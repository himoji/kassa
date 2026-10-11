/*
 * Payments module (spec §7 "Payments verification", I2/I4/I5/I9). Executes ONLY signed approvals and
 * re-verifies everything itself — it trusts nothing the rules module computed except what the rules
 * Ed25519 signature covers. From rules it imports only rules/publicKey (ESLint-enforced, spec §4).
 *
 * Order of checks:
 *  1 approval exists                                   → NO_APPROVAL
 *  2 approval signature (RULES_PUBLIC_KEY), keyId       → BAD_SIGNATURE
 *  3 approval not expired                              → APPROVAL_EXPIRED
 *  4 orderHash recomputed from the stored canonical order == signed orderHash → ORDER_HASH_MISMATCH;
 *    approval issued before the order expired          → ORDER_EXPIRED
 *  5 user not frozen; payee unchanged (account hash) and not blocked/cooling-before-time
 *  6 T2: assertion verified against webauthn_credentials_payments (live counter)
 *    T1: mandate active+effective+in scope+period usage, and its assertion over mandateHash;
 *        or (no mandate) the passkey-signed base rules and the small-auto limit they contain
 *  7 screening for bank transfers                      → REFUSE_SANCTIONS
 *  8 [tx, per-user advisory lock] nonce inserted into used_nonces (PK) → NONCE_USED;
 *    own daily cap per user & currency → PAYMENTS_DAILY_CAP (rolls the nonce back); payment row CREATED
 *  9 rail dispatch; status + ledger. The bank rail quotes from the signed funding currency and refuses a
 *    quote whose source amount exceeds the signed fundingAmountMinor (FUNDING_ABOVE_SIGNED_MAX, B2).
 */
import { CanonicalOrder, jcs, jcsHash, mandateHash, orderHash, type MandateCore, type PaymentStatus, type ReasonCode } from "@kassa/shared";
import { and, eq, gte, notInArray, sql } from "drizzle-orm";
import { verify } from "node:crypto";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { approvals, mandates, payees, payments, profiles, proposals, usedNonces, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { decryptAccount } from "../payees/crypto.ts";
import { railFor } from "../rails/index.ts";
import { rulesPublicKey } from "../rules/publicKey.ts";
import { screenName } from "../screening/index.ts";
import { verifyPaymentsAssertion } from "./credentials.ts";
import { checkMandateScope } from "./mandateScope.ts";
import { updatePaymentStatus } from "./status.ts";

export type ExecuteResult = { paymentId: string | null; status: PaymentStatus | null; reasonCodes: ReasonCode[] };

class Refusal extends Error {
  constructor(
    readonly reason: ReasonCode,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function refuse(reason: ReasonCode, detail: string): never {
  throw new Refusal(reason, detail);
}

function verifyApprovalSig(a: typeof approvals.$inferSelect): boolean {
  const { key, keyId } = rulesPublicKey();
  if (a.keyId !== keyId) return false;
  const message = jcs({
    orderHash: a.orderHash,
    tier: a.tier,
    issuedAt: a.issuedAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
    keyId: a.keyId,
  });
  try {
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(a.approvalSig, "base64url"));
  } catch {
    return false;
  }
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Small-auto (T1 without mandate): the base rules the user signed at onboarding. */
async function verifyBaseRules(db: DbOrTx, order: CanonicalOrder): Promise<void> {
  const p = (await db.select().from(profiles).where(eq(profiles.userId, order.userId)))[0];
  if (!p?.baseRules || !p.baseRulesHash || !p.baseRulesAssertion) refuse("NO_APPROVAL", "no signed base rules for T1 without mandate");
  if (jcsHash(p.baseRules) !== p.baseRulesHash) refuse("BAD_SIGNATURE", "stored base rules do not match their hash");
  const check = await verifyPaymentsAssertion(db, {
    userId: order.userId,
    assertion: p.baseRulesAssertion,
    expectedChallenge: p.baseRulesHash,
    mode: "stored",
    challengeReason: "BAD_SIGNATURE",
  });
  if (!check.ok) refuse(check.reason, `base rules: ${check.detail}`);
  const caps = (p.baseRules as { caps?: { smallAutoMinor?: unknown; currency?: unknown } }).caps;
  const limit = typeof caps?.smallAutoMinor === "number" ? caps.smallAutoMinor : 0;
  if (caps?.currency !== order.homeCurrency || order.homeAmountMinor > limit) {
    refuse("MANDATE_OUT_OF_SCOPE", "order above the signed small-auto limit");
  }
}

async function verifyMandate(db: DbOrTx, order: CanonicalOrder, category: string, now: Date): Promise<void> {
  const m = (await db.select().from(mandates).where(eq(mandates.id, order.mandateId!)))[0];
  if (!m || m.userId !== order.userId) refuse("MANDATE_INACTIVE", "mandate not found");
  if (!m.userAssertion) refuse("MANDATE_INACTIVE", "mandate was never signed");
  const core: MandateCore = {
    v: 1,
    mandateId: m.id,
    userId: m.userId,
    payeeIds: m.payeeIds,
    categories: m.categories,
    currency: m.currency,
    maxPerPaymentMinor: m.maxPerPaymentMinor,
    maxPerPeriodMinor: m.maxPerPeriodMinor,
    period: m.period,
    validFrom: m.validFrom.toISOString(),
    validUntil: m.validUntil?.toISOString() ?? null,
  };
  let recomputed: string;
  try {
    recomputed = mandateHash(core);
  } catch {
    refuse("MANDATE_INACTIVE", "stored mandate is not a valid core");
  }
  if (recomputed !== m.mandateHash) refuse("BAD_SIGNATURE", "mandate fields do not match the signed mandateHash");
  const scope = await checkMandateScope(db, m, order, category, now);
  if (!scope.ok) refuse(scope.reason, scope.detail);
  const check = await verifyPaymentsAssertion(db, {
    userId: order.userId,
    assertion: m.userAssertion,
    expectedChallenge: m.mandateHash,
    mode: "stored",
    challengeReason: "BAD_SIGNATURE",
  });
  if (!check.ok) refuse(check.reason, `mandate assertion: ${check.detail}`);
}

/** Execute an approval. Never throws for a refusal: returns FAILED + reason codes (and logs to the ledger). */
export async function executeApproval(approvalId: string): Promise<ExecuteResult> {
  const db = getDb();
  const now = clock.now();
  let userId: string | null = null;
  let proposalId: string | null = null;
  try {
    // 1
    const a = (await db.select().from(approvals).where(eq(approvals.id, approvalId)))[0];
    if (!a) refuse("NO_APPROVAL", "approval not found");
    proposalId = a.proposalId;
    // 2
    if (!verifyApprovalSig(a)) refuse("BAD_SIGNATURE", "rules approval signature invalid");
    // 3
    if (now.getTime() > a.expiresAt.getTime()) refuse("APPROVAL_EXPIRED", "approval expired");
    // 4
    const p = (await db.select().from(proposals).where(eq(proposals.id, a.proposalId)))[0];
    if (!p?.canonicalOrder) refuse("NO_APPROVAL", "no canonical order for approval");
    const parsed = CanonicalOrder.safeParse(p.canonicalOrder);
    if (!parsed.success) refuse("ORDER_HASH_MISMATCH", "stored canonical order is invalid");
    const order = parsed.data;
    userId = order.userId;
    let recomputed: string;
    try {
      recomputed = orderHash(order); // also rejects a partial funding binding (B2)
    } catch {
      refuse("ORDER_HASH_MISMATCH", "stored canonical order cannot be hashed");
    }
    if (recomputed !== a.orderHash) refuse("ORDER_HASH_MISMATCH", "stored order does not hash to the signed orderHash");
    if (order.proposalId !== a.proposalId) refuse("ORDER_HASH_MISMATCH", "approval/order proposal mismatch");
    if (a.issuedAt.getTime() > Date.parse(order.expiresAt)) refuse("ORDER_EXPIRED", "approval issued after the order expired");
    // 5
    const u = (await db.select().from(users).where(eq(users.id, order.userId)))[0];
    if (!u) refuse("NO_APPROVAL", "user not found");
    if (u.frozenAt) refuse("REFUSE_FROZEN", "user frozen");
    const payee = (await db.select().from(payees).where(eq(payees.id, order.payeeId)))[0];
    if (!payee || payee.userId !== order.userId || payee.accountHash !== order.payeeAccountHash || payee.status === "BLOCKED") {
      refuse("REFUSE_UNVERIFIED_PAYEE", "payee missing, changed or blocked");
    }
    if (payee.status === "COOLING" && (a.tier === "T1" || !payee.coolingUntil || payee.coolingUntil.getTime() > now.getTime())) {
      refuse("REFUSE_UNVERIFIED_PAYEE", "cooling payee: T2 only, after coolingUntil (I7)");
    }
    // 6
    if (a.tier === "T2") {
      const check = await verifyPaymentsAssertion(db, {
        userId: order.userId,
        assertion: a.userAssertion,
        expectedChallenge: a.orderHash,
        mode: "live",
        challengeReason: "ORDER_HASH_MISMATCH",
      });
      if (!check.ok) refuse(check.reason, check.detail);
    } else if (order.mandateId) {
      if (a.mandateId !== order.mandateId) refuse("MANDATE_INACTIVE", "approval/order mandate mismatch");
      await verifyMandate(db, order, p.category, now);
    } else {
      await verifyBaseRules(db, order);
    }
    // 7
    if (order.rail === "BANK_TRANSFER") {
      const s = screenName(order.payeeName);
      if (s.hit) refuse("REFUSE_SANCTIONS", `screening hit ${s.entryId} (${s.score.toFixed(3)})`);
    }
    // 8
    const cap = env().PAYMENTS_DAILY_CAP_HOME_MINOR;
    const paymentId = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"payments:" + order.userId}))`);
      const inserted = await tx.insert(usedNonces).values({ nonce: order.nonce, usedAt: now }).onConflictDoNothing().returning();
      if (inserted.length === 0) refuse("NONCE_USED", "order nonce already used (replay)");
      // Cap after the nonce: a replay reports NONCE_USED; a cap refusal rolls the nonce insert back.
      const used = await tx
        .select({ total: sql<string>`coalesce(sum(${payments.homeAmountMinor}), 0)` })
        .from(payments)
        .where(
          and(
            eq(payments.userId, order.userId),
            eq(payments.currency, order.currency),
            notInArray(payments.status, ["FAILED", "CANCELED"]),
            gte(payments.createdAt, utcDayStart(now)),
          ),
        );
      if (Number(used[0]?.total ?? 0) + order.homeAmountMinor > cap) refuse("PAYMENTS_DAILY_CAP", "payments daily cap reached");
      const row = await tx
        .insert(payments)
        .values({
          approvalId: a.id,
          rail: order.rail,
          railRef: null,
          status: "CREATED",
          amountMinor: order.amountMinor,
          currency: order.currency,
          createdAt: now,
          updatedAt: now,
          userId: order.userId,
          proposalId: order.proposalId,
          homeAmountMinor: order.homeAmountMinor,
          homeCurrency: order.homeCurrency,
        })
        .returning({ id: payments.id });
      const id = row[0]!.id;
      await ledger.append(
        "PAYMENT_CREATED",
        { userId: order.userId, proposalId: order.proposalId, approvalId: a.id, paymentId: id, tier: a.tier, rail: order.rail, amountMinor: order.amountMinor, currency: order.currency, orderHash: a.orderHash, nonce: order.nonce },
        tx,
      );
      return id;
    });

    // 9
    let status: PaymentStatus = "FAILED";
    let reasonCodes: ReasonCode[] = [];
    try {
      const result = await railFor(order.rail).execute(order, {
        db,
        paymentId,
        approvalId: a.id,
        now,
        payee: { id: payee.id, name: payee.name, kind: payee.kind, account: decryptAccount(payee.userId, payee.accountEnc) },
      });
      status = result.status;
      reasonCodes = (result.reasonCodes ?? []) as ReasonCode[];
      await db
        .update(payments)
        .set({
          status: status === "SENT" ? "PROCESSING" : status,
          railRef: result.railRef,
          details: result.details ?? {},
          reasonCodes,
          updatedAt: clock.now(),
        })
        .where(eq(payments.id, paymentId));
      // SENT goes through the common transition so the KASSA_PAYMENT transaction is recorded.
      if (status === "SENT") await updatePaymentStatus(paymentId, "SENT", { source: `rail:${order.rail}` });
    } catch (err) {
      reasonCodes = ["RAIL_ERROR"];
      await db
        .update(payments)
        .set({ status: "FAILED", reasonCodes, details: { error: (err as Error).message }, updatedAt: clock.now() })
        .where(eq(payments.id, paymentId));
    }
    await ledger.append("PAYMENT_STATUS", { userId: order.userId, proposalId: order.proposalId, paymentId, status, reasonCodes, rail: order.rail });
    return { paymentId, status, reasonCodes };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    await ledger.append("PAYMENT_REFUSED", { userId, proposalId, approvalId, reasonCodes: [err.reason], detail: err.detail });
    return { paymentId: null, status: "FAILED", reasonCodes: [err.reason] };
  }
}

export { updatePaymentStatus };
export { registerPaymentsCredential } from "./credentials.ts";
