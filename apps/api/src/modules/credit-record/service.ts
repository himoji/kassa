/*
 * Credit record (spec §8, §16): a signed summary the student can share with a landlord or bank.
 * bundle → sha256 = base64url(sha256(JCS(bundle))) → Ed25519 signature with LEDGER_CHECKPOINT_KEY
 * (RFC 8032) → stored in the append-only ledger (I12) under an unguessable verifyId (128-bit random).
 * Public verification recomputes the hash, checks the signature and the ledger chain.
 */
import { jcs, jcsHash, type CreditRecordItem } from "@kassa/shared";
import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { ledgerEntries, payments, profiles, proposals, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { HttpProblem, notFound } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { checkpointPublicKey, ledger } from "../ledger/index.ts";
import { entryHash } from "../ledger/internal.ts";
import { keyIdOf, loadPrivateKey, signText, verifyText } from "../ledger/keys.ts";
import { openPii, sealPii } from "../privacy/keys.ts";

export type CreditBundle = {
  v: 1;
  verifyId: string;
  issuedAt: string;
  period: { from: string; to: string };
  holder: string;
  items: CreditRecordItem[];
  summary: { billsPaidOnTime: number; billsTotal: number; monthsCovered: number; regularIncomeMonths: number };
  simulated: boolean;
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => `${p[0]!.toUpperCase()}.`)
    .join(" ");
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1);
}

export async function exportCreditRecord(userId: string, req: { from: string; to: string; items: CreditRecordItem[] }) {
  const db = getDb();
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!u) throw notFound("user");
  const p = (await db.select().from(profiles).where(eq(profiles.userId, userId)))[0];
  const start = new Date(`${req.from}T00:00:00.000Z`);
  const end = new Date(`${req.to}T23:59:59.999Z`);
  const bills = await db
    .select({ id: proposals.id, dueDate: sql<string | null>`${proposals.draft}->>'dueDate'`, status: proposals.status })
    .from(proposals)
    .where(and(eq(proposals.userId, userId), isNotNull(proposals.obligationId), gte(proposals.createdAt, start), lte(proposals.createdAt, end)));
  let onTime = 0;
  for (const b of bills) {
    const paid = (await db.select().from(payments).where(and(eq(payments.proposalId, b.id), eq(payments.status, "SENT"))))[0];
    if (paid && (!b.dueDate || paid.updatedAt.getTime() <= Date.parse(`${b.dueDate}T23:59:59.999Z`))) onTime++;
  }
  const months = monthsBetween(req.from, req.to);
  const hasMonthlyIncome = (p?.incomes ?? []).some((i) => i.cadence === "MONTHLY");
  const bundle: CreditBundle = {
    v: 1,
    verifyId: randomBytes(16).toString("base64url"),
    issuedAt: clock.now().toISOString(),
    period: { from: req.from, to: req.to },
    holder: initials(u.displayName),
    items: [...new Set(req.items)].sort(),
    summary: { billsPaidOnTime: onTime, billsTotal: bills.length, monthsCovered: months, regularIncomeMonths: hasMonthlyIncome ? months : 0 },
    simulated: true,
  };
  const sha256 = jcsHash(bundle);
  const key = loadPrivateKey(env().LEDGER_CHECKPOINT_KEY);
  const pub = checkpointPublicKey();
  const sig = signText(key, sha256);
  // The bundle (holder initials, payment history summary) is sealed with the user's key: after an erasure
  // (GDPR Art. 17) the public verify link stops resolving while the ledger chain stays intact.
  await ledger.append("CREDIT_RECORD_EXPORTED", { userId, verifyId: bundle.verifyId, sha256, sig, keyId: keyIdOf(pub), ...(await sealPii(userId, { bundle })) });
  return { bundle, sha256 };
}

export async function findCreditRecord(verifyId: string) {
  const db = getDb();
  const e = (
    await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.type, "CREDIT_RECORD_EXPORTED"), sql`${ledgerEntries.payload}->>'verifyId' = ${verifyId}`))
  )[0];
  if (!e) throw notFound("credit record");
  const raw = e.payload as { userId: string; bundle?: CreditBundle; pii?: string; sha256: string; sig: string; keyId: string };
  // Pre-Phase-2 entries carry the bundle in clear; newer ones seal it with the holder's key.
  const opened = raw.pii ? ((await openPii(raw.userId, raw.pii, db)) as { bundle: CreditBundle } | null) : raw.bundle ? { bundle: raw.bundle } : null;
  if (!opened) throw new HttpProblem(410, "ACCOUNT_ERASED", "This credit record was withdrawn: the holder erased their data", { reasonCodes: ["ACCOUNT_ERASED"] });
  const payload = { ...raw, bundle: opened.bundle };
  const pub = checkpointPublicKey();
  const valid =
    jcsHash(payload.bundle) === payload.sha256 &&
    payload.keyId === keyIdOf(pub) &&
    verifyText(pub, payload.sha256, payload.sig) &&
    entryHash(e.prevHash, e.seq, e.ts.toISOString(), e.type, e.payload) === e.hash;
  return { ...payload, valid, json: jcs(payload.bundle) };
}
