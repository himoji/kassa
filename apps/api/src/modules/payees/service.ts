/*
 * Payees (I7): every new payee — and every account change, which IS a new payee — starts COOLING for
 * 24 h on the Clock. Cooling payees are never usable on autopilot (T1) and need a passkey (T2) after
 * coolingUntil. The account is stored AES-256-GCM encrypted plus its hash (payees/crypto.ts).
 */
import type { CreatePayeeRequest, PayeeDto } from "@kassa/shared";
import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { payees } from "../../db/schema.ts";
import { conflict, HttpProblem, notFound } from "../../http/problem.ts";
import { addMs, clock, DAY_MS } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { notify } from "../notifications/service.ts";
import { isValidIban, looksLikeIban } from "../screening/iban.ts";
import { accountHash, decryptAccount, encryptAccount, maskAccount, normalizeAccount } from "./crypto.ts";

export const COOLING_MS = DAY_MS;

export function toPayeeDto(p: typeof payees.$inferSelect): PayeeDto {
  let masked = "••••";
  try {
    masked = maskAccount(decryptAccount(p.userId, p.accountEnc));
  } catch {
    // undecryptable (key rotated): show nothing rather than fail the list
  }
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    accountMasked: masked,
    country: p.country,
    currency: p.currency,
    status: p.status,
    verifiedAt: p.verifiedAt?.toISOString() ?? null,
    coolingUntil: p.coolingUntil?.toISOString() ?? null,
    replacesPayeeId: p.replacesPayeeId,
  };
}

export async function listPayees(userId: string) {
  return getDb().select().from(payees).where(eq(payees.userId, userId));
}

export async function createPayee(userId: string, req: CreatePayeeRequest & { source?: string }) {
  const db = getDb();
  if (looksLikeIban(req.account) && !isValidIban(req.account)) {
    throw new HttpProblem(422, "INVALID_IBAN", "IBAN check digits are wrong (ISO 13616 / ISO 7064 MOD 97-10)");
  }
  if (!/^[A-Z]{2}$/.test(req.country)) throw new HttpProblem(422, "INVALID_COUNTRY", "country must be ISO 3166-1 alpha-2");
  if (req.replacesPayeeId) {
    const old = (await db.select().from(payees).where(and(eq(payees.id, req.replacesPayeeId), eq(payees.userId, userId))))[0];
    if (!old) throw notFound("replaced payee");
  }
  const now = clock.now();
  const coolingUntil = addMs(now, COOLING_MS);
  const rows = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(payees)
      .values({
        userId,
        name: req.name.trim(),
        kind: req.kind,
        accountEnc: encryptAccount(userId, normalizeAccount(req.account)),
        accountHash: accountHash(req.account),
        country: req.country,
        currency: req.currency,
        status: "COOLING",
        verifiedAt: null,
        coolingUntil,
        replacesPayeeId: req.replacesPayeeId ?? null,
        createdAt: now,
      })
      .returning();
    const p = inserted[0]!;
    await ledger.append(
      "PAYEE_CREATED",
      { userId, payeeId: p.id, status: "COOLING", coolingUntil: coolingUntil.toISOString(), replacesPayeeId: p.replacesPayeeId, accountHash: p.accountHash, source: req.source ?? "user" },
      tx,
    );
    return inserted;
  });
  const p = rows[0]!;
  await notify(userId, {
    kind: "PAYEE_COOLING",
    title: "New payee is cooling",
    body: `${p.name} can be paid with your passkey after ${coolingUntil.toISOString()}. A changed account is a new payee.`,
    data: { payeeId: p.id, coolingUntil: coolingUntil.toISOString(), replacesPayeeId: p.replacesPayeeId },
  });
  return p;
}

/**
 * Simulated confirmation-of-payee callback (spec §8). Allowed only after the cooling period: the 24 h
 * delay is the protection, the callback only records that the account was confirmed.
 */
export async function verifyCallback(userId: string, payeeId: string) {
  const db = getDb();
  const p = (await db.select().from(payees).where(and(eq(payees.id, payeeId), eq(payees.userId, userId))))[0];
  if (!p) throw notFound("payee");
  if (p.status === "VERIFIED") return p;
  if (p.status === "BLOCKED") throw conflict("REFUSE_UNVERIFIED_PAYEE", "Payee is blocked");
  const now = clock.now();
  if (p.coolingUntil && p.coolingUntil.getTime() > now.getTime()) {
    throw conflict("PAYEE_COOLING", "Payee is still cooling", { reasonCodes: ["PAYEE_COOLING"], details: { coolingUntil: p.coolingUntil.toISOString() } });
  }
  const rows = await db.transaction(async (tx) => {
    const r = await tx.update(payees).set({ status: "VERIFIED", verifiedAt: now }).where(eq(payees.id, payeeId)).returning();
    await ledger.append("PAYEE_VERIFIED", { userId, payeeId, source: "verify-callback (simulated)" }, tx);
    return r;
  });
  return rows[0]!;
}
