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
 *    T1: mandate active+effective+in scope+period usage, and its assertion over mandateHash; (X1) the order's
 *        signed obligation link re-checked against the obligation (payee, category, amount ≤ bill, period);
 *        or (no mandate) the passkey-signed base rules and the small-auto limit they contain
 *    (M5) an order that settles a purchase order: poHash recomputed from the stored core == the stored poHash, the
 *        owner's stored passkey assertion re-verified over it, payee = the PO's supplier (and its signed account),
 *        amount ≤ the signed total, PO not already paid → BAD_SIGNATURE / INVOICE_ACCOUNT_MISMATCH / INVOICE_ABOVE_PO
 *  7 screening on every rail (X4)                      → REFUSE_SANCTIONS
 *  8a (added 2026-10-16) above the KYC threshold (home currency, own conversion) without a VERIFIED identity check,
 *    every rail but HANDOFF                            → KYC_REQUIRED
 *  8 [tx, per-user advisory lock] nonce inserted into used_nonces (PK) → NONCE_USED;
 *    own daily cap per user in the HOME currency, all currencies summed and converted by payments itself (X2,
 *    injected fx port) → PAYMENTS_DAILY_CAP (rolls the nonce back); (X3) small-auto per-day budget →
 *    SMALL_AUTO_BUDGET_EXHAUSTED; payment row CREATED
 *  9 rail dispatch; status + ledger. The bank rail quotes from the signed funding currency and refuses a
 *    quote whose source amount exceeds the signed fundingAmountMinor (FUNDING_ABOVE_SIGNED_MAX, B2).
 *    (linked accounts) An order signed with fundingSourceId first pulls the signed fundingAmountMinor from that
 *    source (re-checked here before the nonce: the user's, ACTIVE, in fundingCurrency → FUNDING_SOURCE_UNAVAILABLE)
 *    into the wallet; a declined pull fails the payment before any payout (FUNDING_PULL_DECLINED).
 */
import { CanonicalOrder, jcs, jcsHash, mandateHash, orderHash, poHash, type MandateCore, type PaymentStatus, type ReasonCode } from "@kassa/shared";
import { and, eq, gte, notInArray, sql } from "drizzle-orm";
import { verify } from "node:crypto";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { approvals, mandates, merchants, payees, payments, profiles, proposals, purchaseOrders, usedNonces, users } from "../../db/schema.ts";
import { PROFILE_CORE } from "../../db/profile-columns.ts";
import { env } from "../../env.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { pullIntoWallet, PullDeclined } from "../funding-sources/pull.ts";
import { activeFundingSource } from "../funding-sources/store.ts";
import { kycStatusOf } from "../kyc/status.ts";
import { accountHash, decryptAccount } from "../payees/crypto.ts";
import { railFor } from "../rails/index.ts";
import { rulesPublicKey } from "../rules/publicKey.ts";
import { screenName } from "../screening/index.ts";
import { verifyPaymentsAssertion } from "./credentials.ts";
import { checkMandateScope } from "./mandateScope.ts";
import { notifyPaymentOutcome } from "./notify.ts";
import { updatePaymentStatus } from "./status.ts";

export type ExecuteResult = {
  paymentId: string | null;
  status: PaymentStatus | null;
  reasonCodes: ReasonCode[];
  /** Wall-clock time from the start of execution to the bank reporting the money delivered (SENT), when it did. */
  deliveredInMs?: number;
};

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

/*
 * (X2) Home-currency conversion port, registered at startup (orders/wiring.ts → money/fx). Payments converts the
 * order and the day's payments itself for its own cap (I5) and the small-auto limit, instead of trusting the
 * homeAmountMinor rules put into the order. Unwired or failing → fail closed (refused).
 */
export type HomeConverter = (amountMinor: number, currency: string, homeCurrency: string, at: Date, rounding?: "nearest" | "down") => Promise<number>;
let homeConverter: HomeConverter | null = null;

export function registerHomeConverter(fn: HomeConverter | null): void {
  homeConverter = fn;
}

async function ownHome(
  amountMinor: number,
  currency: string,
  homeCurrency: string,
  at: Date,
  reason: ReasonCode,
  rounding: "nearest" | "down" = "nearest",
): Promise<number> {
  if (currency === homeCurrency) return amountMinor;
  if (!homeConverter) refuse(reason, "no fx port: cannot convert to the home currency");
  try {
    const v = await homeConverter(amountMinor, currency, homeCurrency, at, rounding);
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`bad conversion ${v}`);
    return v;
  } catch (err) {
    if (err instanceof Refusal) throw err;
    refuse(reason, `cannot convert ${currency} to ${homeCurrency}: ${(err as Error).message}`);
  }
}

/** (cap currency) PAYMENTS_DAILY_CAP_HOME_MINOR is a fixed amount in PAYMENTS_DAILY_CAP_CURRENCY; this user gets it in their home currency, rounded down. Unconvertible means refused (fail closed). */
async function capInHome(homeCurrency: string, at: Date): Promise<number> {
  const e = env();
  return ownHome(e.PAYMENTS_DAILY_CAP_HOME_MINOR, e.PAYMENTS_DAILY_CAP_CURRENCY, homeCurrency, at, "PAYMENTS_DAILY_CAP", "down");
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Small-auto (T1 without mandate): the base rules the user signed at onboarding. */
/** The signed small-auto limit (in its signed currency) and the order converted into that currency by payments. */
type SmallAutoLimit = { limitMinor: number; currency: string; orderMinor: number };

async function verifyBaseRules(db: DbOrTx, order: CanonicalOrder, now: Date): Promise<SmallAutoLimit> {
  const p = (await db.select(PROFILE_CORE).from(profiles).where(eq(profiles.userId, order.userId)))[0];
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
  if (typeof caps?.currency !== "string") refuse("MANDATE_OUT_OF_SCOPE", "signed base rules have no small-auto currency");
  // X2: the order amount in the SIGNED limit's currency, converted by payments itself.
  const amountInLimitCurrency = await ownHome(order.amountMinor, order.currency, caps.currency, now, "MANDATE_OUT_OF_SCOPE");
  if (amountInLimitCurrency > limit) refuse("MANDATE_OUT_OF_SCOPE", "order above the signed small-auto limit");
  return { limitMinor: limit, currency: caps.currency, orderMinor: amountInLimitCurrency };
}

async function verifyMandate(db: DbOrTx, order: CanonicalOrder, now: Date): Promise<void> {
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
  const scope = await checkMandateScope(db, m, order, now);
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

/**
 * (M5) Re-verify the passkey-signed purchase order an order settles, from payments' own reads (same stored-assertion
 * pattern as verifyMandate): the stored core still hashes to the signed poHash, the owner's assertion over it is
 * valid, and the order pays the PO's supplier account no more than the signed total.
 */
async function verifyPurchaseOrder(db: DbOrTx, order: CanonicalOrder): Promise<void> {
  const row = (
    await db
      .select({ po: purchaseOrders, ownerUserId: merchants.ownerUserId })
      .from(purchaseOrders)
      .innerJoin(merchants, eq(merchants.id, purchaseOrders.merchantId))
      .where(eq(purchaseOrders.id, order.purchaseOrderId!))
  )[0];
  if (!row || row.ownerUserId !== order.userId) refuse("NO_APPROVAL", "purchase order not found");
  const { po } = row;
  if (!po.core || !po.poHash || !po.ownerAssertion) refuse("NO_APPROVAL", "purchase order was never signed");
  let recomputed: string;
  try {
    recomputed = poHash(po.core);
  } catch {
    refuse("BAD_SIGNATURE", "stored purchase order is not a valid core");
  }
  if (recomputed !== po.poHash) refuse("BAD_SIGNATURE", "purchase order fields do not match the signed poHash");
  if (po.core.purchaseOrderId !== po.id || po.core.ownerUserId !== order.userId) refuse("BAD_SIGNATURE", "purchase order core is for another order or owner");
  if (order.payeeId !== po.core.supplierPayeeId || order.payeeAccountHash !== po.core.supplierAccountHash) {
    refuse("INVOICE_ACCOUNT_MISMATCH", "payee is not the signed purchase order's supplier account");
  }
  if (order.currency !== po.core.currency || order.amountMinor > po.core.totalMinor) refuse("INVOICE_ABOVE_PO", "amount above the signed purchase order total");
  if (po.status === "PAID") refuse("NONCE_USED", "purchase order already paid");
  const check = await verifyPaymentsAssertion(db, {
    userId: order.userId,
    assertion: po.ownerAssertion,
    expectedChallenge: po.poHash,
    mode: "stored",
    challengeReason: "BAD_SIGNATURE",
  });
  if (!check.ok) refuse(check.reason, `purchase order assertion: ${check.detail}`);
}

/** Execute an approval. Never throws for a refusal: returns FAILED + reason codes (and logs to the ledger). */
export async function executeApproval(approvalId: string): Promise<ExecuteResult> {
  const db = getDb();
  const now = clock.now();
  const startedAt = performance.now();
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
    if (!payee || payee.userId !== order.userId || payee.accountHash !== order.payeeAccountHash || payee.status === "BLOCKED" || payee.archivedAt !== null) {
      refuse("REFUSE_UNVERIFIED_PAYEE", "payee missing, changed, blocked or removed");
    }
    // A payee captured without account details (onboarding) is never payable, whatever the order says.
    if (payee.accountEnc === null || payee.accountHash === null) refuse("REFUSE_UNVERIFIED_PAYEE", "payee has no account details");
    // A12 (AIXBT-style row writes): the account the rail will pay must decrypt for THIS payee row (v2 AAD binds the
    // payee id) and hash to the account hash the order signed. A ciphertext copied from another row fails here.
    let payeeAccount: string;
    try {
      payeeAccount = decryptAccount(payee.userId, payee.accountEnc, payee.id);
    } catch {
      refuse("REFUSE_UNVERIFIED_PAYEE", "payee account does not belong to this payee row");
    }
    if (accountHash(payeeAccount) !== order.payeeAccountHash) refuse("REFUSE_UNVERIFIED_PAYEE", "payee account does not match the signed account hash");
    if (payee.status === "COOLING" && (a.tier === "T1" || !payee.coolingUntil || payee.coolingUntil.getTime() > now.getTime())) {
      refuse("REFUSE_UNVERIFIED_PAYEE", "cooling payee: T2 only, after coolingUntil (I7)");
    }
    // 6
    let smallAuto: SmallAutoLimit | null = null;
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
      await verifyMandate(db, order, now);
    } else {
      smallAuto = await verifyBaseRules(db, order, now);
    }
    if (order.purchaseOrderId) await verifyPurchaseOrder(db, order);
    // (linked accounts) the source the user signed: still theirs, still linked, in the signed funding currency.
    const source = order.fundingSourceId ? await activeFundingSource(order.userId, order.fundingSourceId) : null;
    if (order.fundingSourceId && (!source || source.currency !== order.fundingCurrency || order.rail !== "BANK_TRANSFER")) {
      refuse("FUNDING_SOURCE_UNAVAILABLE", "the signed linked account is removed, someone else's or in another currency");
    }
    // 7 (X4) every rail; both the signed name and the payee's current name.
    for (const name of new Set([order.payeeName, payee.name])) {
      const s = screenName(name);
      if (s.hit) refuse("REFUSE_SANCTIONS", `screening hit ${s.entryId} (${s.score.toFixed(3)})`);
    }
    // 8
    const cap = await capInHome(u.homeCurrency, now);
    // X2: the order in the user's home currency, by payments' own conversion (not the order's homeAmountMinor).
    const orderHome = await ownHome(order.amountMinor, order.currency, u.homeCurrency, now, "PAYMENTS_DAILY_CAP");
    // 8a (KYC) payments' own re-check, before the nonce: above the threshold (payments' own conversion; unconvertible
    // means 0, fail closed) Kassa pays out only for a user whose latest identity check is VERIFIED. Handoff is paid
    // in the user's own wallet.
    if (order.rail !== "HANDOFF") {
      const e = env();
      let kycThreshold = 0;
      try {
        kycThreshold = await ownHome(e.KYC_THRESHOLD_MINOR, e.KYC_THRESHOLD_CURRENCY, u.homeCurrency, now, "KYC_REQUIRED", "down");
      } catch {
        kycThreshold = 0;
      }
      if (orderHome > kycThreshold && (await kycStatusOf(db, order.userId)) !== "VERIFIED") {
        refuse("KYC_REQUIRED", `above the KYC threshold (${orderHome} > ${kycThreshold} ${u.homeCurrency}) without a verified identity check`);
      }
    }
    const paymentId = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"payments:" + order.userId}))`);
      const inserted = await tx.insert(usedNonces).values({ nonce: order.nonce, usedAt: now }).onConflictDoNothing().returning();
      if (inserted.length === 0) refuse("NONCE_USED", "order nonce already used (replay)");
      // Cap after the nonce: a replay reports NONCE_USED; a cap refusal rolls the nonce insert back.
      // X2 (I5): every live payment of the UTC day, all currencies, converted to the home currency by payments.
      const today = await tx
        .select({ amountMinor: payments.amountMinor, currency: payments.currency, tier: approvals.tier, mandateId: approvals.mandateId })
        .from(payments)
        .innerJoin(approvals, eq(approvals.id, payments.approvalId))
        .where(and(eq(payments.userId, order.userId), notInArray(payments.status, ["FAILED", "CANCELED"]), gte(payments.createdAt, utcDayStart(now))));
      let usedHome = 0;
      for (const p of today) usedHome += await ownHome(p.amountMinor, p.currency, u.homeCurrency, now, "PAYMENTS_DAILY_CAP");
      if (usedHome + orderHome > cap) refuse("PAYMENTS_DAILY_CAP", `payments daily cap reached (${usedHome} + ${orderHome} > ${cap} ${u.homeCurrency})`);
      // X3: small-auto (T1 without mandate) per-day budget, enforced here independently of rules (I2), in the
      // currency of the signed small-auto limit.
      if (smallAuto) {
        const e = env();
        const prior = today.filter((p) => p.tier === "T1" && p.mandateId === null);
        let priorMinor = 0;
        for (const p of prior) priorMinor += await ownHome(p.amountMinor, p.currency, smallAuto.currency, now, "SMALL_AUTO_BUDGET_EXHAUSTED");
        if (prior.length + 1 > e.SMALL_AUTO_DAILY_MAX_COUNT || priorMinor + smallAuto.orderMinor > e.SMALL_AUTO_DAILY_AMOUNT_MULTIPLE * smallAuto.limitMinor) {
          refuse("SMALL_AUTO_BUDGET_EXHAUSTED", `small-auto budget for today used (${prior.length} payments, ${priorMinor} ${smallAuto.currency})`);
        }
      }
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
      // (M5) the purchase order is being paid (→ PAID when this payment is SENT, payments/status.ts).
      if (order.purchaseOrderId) {
        await tx
          .update(purchaseOrders)
          .set({ status: "PAYING", timeline: sql`${purchaseOrders.timeline} || ${JSON.stringify([{ status: "PAYING", at: now.toISOString() }])}::jsonb`, updatedAt: now })
          .where(eq(purchaseOrders.id, order.purchaseOrderId));
      }
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
      if (source && order.fundingAmountMinor !== undefined && order.fundingCurrency) {
        // Pull leg: the signed maximum (exact for a same-currency send; any FX head-room left stays in the wallet).
        const pulled = await pullIntoWallet(source, order.fundingAmountMinor, order.fundingCurrency, paymentId);
        await ledger.append("FUNDING_PULLED", {
          userId: order.userId,
          proposalId: order.proposalId,
          paymentId,
          sourceId: source.id,
          kind: source.kind,
          amountMinor: order.fundingAmountMinor,
          currency: order.fundingCurrency,
          providerRef: pulled.providerRef,
          simulated: pulled.simulated,
        });
      }
      const result = await railFor(order.rail).execute(order, {
        db,
        paymentId,
        approvalId: a.id,
        now,
        payee: { id: payee.id, name: payee.name, kind: payee.kind, account: payeeAccount },
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
      status = "FAILED";
      reasonCodes = [err instanceof PullDeclined ? "FUNDING_PULL_DECLINED" : "RAIL_ERROR"];
      await db
        .update(payments)
        .set({ status: "FAILED", reasonCodes, details: { error: (err as Error).message }, updatedAt: clock.now() })
        .where(eq(payments.id, paymentId));
    }
    // X9: rail failures written directly above (not via updatePaymentStatus) notify here; SENT notified there.
    if (status === "FAILED" || status === "CANCELED") await notifyPaymentOutcome(paymentId, status, reasonCodes);
    // (M5) a rail that failed right away leaves the purchase order payable again.
    if ((status === "FAILED" || status === "CANCELED") && order.purchaseOrderId) {
      await db.update(purchaseOrders).set({ status: "INVOICED", updatedAt: clock.now() }).where(and(eq(purchaseOrders.id, order.purchaseOrderId), eq(purchaseOrders.status, "PAYING")));
    }
    const deliveredInMs = status === "SENT" ? Math.round(performance.now() - startedAt) : undefined;
    await ledger.append("PAYMENT_STATUS", { userId: order.userId, proposalId: order.proposalId, paymentId, status, reasonCodes, rail: order.rail, ...(deliveredInMs !== undefined ? { deliveredInMs } : {}) });
    return { paymentId, status, reasonCodes, ...(deliveredInMs !== undefined ? { deliveredInMs } : {}) };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    await ledger.append("PAYMENT_REFUSED", { userId, proposalId, approvalId, reasonCodes: [err.reason], detail: err.detail });
    return { paymentId: null, status: "FAILED", reasonCodes: [err.reason] };
  }
}

export { updatePaymentStatus };
export { registerPaymentsCredential } from "./credentials.ts";
