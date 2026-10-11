/*
 * Payees (I7): every new payee — and every account change, which IS a new payee — starts COOLING for
 * 24 h on the Clock. Cooling payees are never usable on autopilot (T1) and need a passkey (T2) after
 * coolingUntil. The account is stored AES-256-GCM encrypted plus its hash (payees/crypto.ts).
 */
import { jcsHash, type CreatePayeeRequest, type PayeeDto } from "@kassa/shared";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { payees } from "../../db/schema.ts";
import { auditAssertionFailure, ownedNotFound } from "../../http/audit.ts";
import { conflict, HttpProblem, notFound } from "../../http/problem.ts";
import { putGated, takeGated } from "../auth/challenges.ts";
import { addMs, clock, DAY_MS } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { sealPii } from "../privacy/keys.ts";
import { notify } from "../notifications/service.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";
import { screenName } from "../screening/index.ts";
import { isValidIban, looksLikeIban } from "../screening/iban.ts";
import { accountHash, decryptAccount, encryptAccount, maskAccount, normalizeAccount } from "./crypto.ts";

export const COOLING_MS = DAY_MS;

export function toPayeeDto(p: typeof payees.$inferSelect): PayeeDto {
  const accountMissing = p.accountEnc === null;
  let masked = accountMissing ? "" : "••••";
  try {
    if (p.accountEnc !== null) masked = maskAccount(decryptAccount(p.userId, p.accountEnc));
  } catch {
    // undecryptable (key rotated): show nothing rather than fail the list
  }
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    accountMasked: masked,
    accountMissing,
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
  // I9 / X4: screen the name at creation. A hit is refused and not stored (a payee that can never be paid is no
  // use); the hit is ledgered with the name sealed under the user's key (GDPR Art. 17 crypto-shredding).
  const screening = screenName(req.name);
  if (screening.hit) {
    await ledger.append("PAYEE_SCREENING_HIT", {
      userId,
      reasonCodes: ["REFUSE_SANCTIONS"],
      entryId: screening.entryId,
      score: Math.round(screening.score * 10_000) / 10_000,
      source: req.source ?? "user",
      ...(await sealPii(userId, { name: req.name })),
    });
    throw new HttpProblem(422, "REFUSE_SANCTIONS", "This name matches a sanctions list entry; the payee was not added", { reasonCodes: ["REFUSE_SANCTIONS"] });
  }
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
      // accountHash (sha256 of a third party's account) is sealed with the user's key: an IBAN space is small
      // enough to brute-force a bare hash, and erasure must make it unreadable (GDPR Art. 17).
      { userId, payeeId: p.id, status: "COOLING", coolingUntil: coolingUntil.toISOString(), replacesPayeeId: p.replacesPayeeId, source: req.source ?? "user", ...(await sealPii(userId, { accountHash: p.accountHash }, tx)) },
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

/** (X3) What the user signs to verify a payee: binds its id, name and account hash (PSD2 RTS Art. 5 dynamic linking). */
export type PayeeVerifyCore = { v: 1; kind: "PAYEE_VERIFY"; userId: string; payeeId: string; payeeName: string; accountHash: string; nonce: string };

/**
 * Simulated confirmation-of-payee callback (spec §8). Allowed only after the cooling period (I7), and (X3, security
 * review F1) only with a FRESH passkey assertion: a verified payee becomes eligible for small-auto payments, so a
 * stolen session must not be able to verify one. First call → HTTP 428 PASSKEY_REQUIRED with a challenge =
 * jcsHash(PayeeVerifyCore) (the nonce makes every challenge unique); resend with {challengeId, assertion}.
 */
export async function verifyCallback(userId: string, payeeId: string, body: { challengeId?: string | undefined; assertion?: unknown } = {}) {
  const db = getDb();
  const p = (await db.select().from(payees).where(and(eq(payees.id, payeeId), eq(payees.userId, userId))))[0];
  if (!p) throw await ownedNotFound(userId, "payee", payeeId, async () => (await db.select({ id: payees.id }).from(payees).where(eq(payees.id, payeeId))).length > 0);
  if (p.status === "VERIFIED") return p;
  if (p.status === "BLOCKED") throw conflict("REFUSE_UNVERIFIED_PAYEE", "Payee is blocked");
  // A payee without account details (captured in onboarding) has nothing to confirm: verifying it would make an
  // account-less payee look payable. Checked before the cooling window (its coolingUntil is null).
  if (p.accountHash === null) {
    throw conflict("PAYEE_ACCOUNT_MISSING", "Add the payee's account details first", { reasonCodes: ["REFUSE_UNVERIFIED_PAYEE", "PAYEE_ACCOUNT_MISSING"] });
  }
  const accountHashValue = p.accountHash;
  const now = clock.now();
  if (p.coolingUntil && p.coolingUntil.getTime() > now.getTime()) {
    throw conflict("PAYEE_COOLING", "Payee is still cooling", { reasonCodes: ["PAYEE_COOLING"], details: { coolingUntil: p.coolingUntil.toISOString() } });
  }

  if (!body.challengeId || !body.assertion) {
    const core: PayeeVerifyCore = { v: 1, kind: "PAYEE_VERIFY", userId, payeeId: p.id, payeeName: p.name, accountHash: accountHashValue, nonce: randomBytes(16).toString("base64url") };
    const hash = jcsHash(core);
    const challengeId = putGated({ userId, purpose: "payee-verify", hash, payload: core });
    throw new HttpProblem(428, "PASSKEY_REQUIRED", `Confirm ${p.name} with your passkey`, {
      reasonCodes: ["PASSKEY_REQUIRED"],
      details: { challengeId, webauthnOptions: await assertionOptions(db, userId, hash) },
    });
  }
  const gated = takeGated(body.challengeId, userId, "payee-verify");
  const core = gated?.payload as PayeeVerifyCore | undefined;
  // The challenge must be for THIS payee, with the account it still has.
  if (!gated || !core || core.payeeId !== p.id || core.accountHash !== p.accountHash || core.payeeName !== p.name) {
    throw conflict("CHALLENGE_MISMATCH", "The signed request no longer matches this payee; start again");
  }
  const check = await verifyRulesAssertion(db, { userId, assertion: body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID" });
  if (!check.ok) {
    await auditAssertionFailure(userId, "payee-verify", check.reason);
    throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
  }
  const rows = await db.transaction(async (tx) => {
    const r = await tx
      .update(payees)
      .set({ status: "VERIFIED", verifiedAt: now })
      .where(and(eq(payees.id, payeeId), eq(payees.status, "COOLING")))
      .returning();
    if (r.length === 0) throw conflict("CHALLENGE_MISMATCH", "Payee changed while you were confirming it; start again");
    await ledger.append("PAYEE_VERIFIED", { userId, payeeId, source: "verify-callback (simulated)", challengeHash: gated.hash, credentialId: check.credentialId }, tx);
    return r;
  });
  return rows[0]!;
}
