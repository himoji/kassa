/*
 * Rules module (spec §5, §7, §10): drafts in, decisions out. Builds the canonical order, verifies the
 * user's WebAuthn assertion (T2) and signs approvals (Ed25519). It never moves money: AUTO/approved
 * orders are handed to an executor registered at startup (orders/wiring.ts → payments), so the agent →
 * rules import path never reaches payments (I1).
 */
import {
  Fulfillment,
  formatMoney,
  isoMoney,
  isSupportedCurrency,
  orderBodyEn,
  ownWalletAccountHash,
  OWN_WALLET_PAYEE_NAME,
  SupportedCurrency,
  itemsHash as computeItemsHash,
  orderHash as computeOrderHash,
  reasonsSentenceEn,
  type CanonicalOrder,
  type Decision,
  type PaymentStatus,
  type Rail,
  type ReasonCode,
  budgetCategoryFor,
} from "@kassa/shared";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { approvals, budgets, merchants, obligations, payees, proposals, purchaseOrders, type ProposalDraftJson } from "../../db/schema.ts";
import { ownedNotFound } from "../../http/audit.ts";
import { env } from "../../env.ts";
import { HttpProblem } from "../../http/problem.ts";
import { addMs, clock, MINUTE_MS } from "../clock/index.ts";
import { kycStatusOf } from "../kyc/status.ts";
import { kycThresholdInHome } from "../kyc/threshold.ts";
import { ledger } from "../ledger/index.ts";
import { sealPii } from "../privacy/keys.ts";
import { findMatchingMandate, type LinkedObligation } from "../mandates/scope.ts";
import { dueHorizon } from "../scheduler/window.ts";
import { claimSettlement, markSettlementPaid, releaseSettlement, settlementFor } from "../obligations/settlements.ts";
import { toHome } from "../money/fx.ts";
import { notify } from "../notifications/service.ts";
import { readDetails } from "../payees/crypto.ts";
import { screenName } from "../screening/index.ts";
import { effectiveOf, loadUser } from "../users/service.ts";
import { capBreaches, decide, type DecideResult } from "./decide.ts";
import {
  categoryRemaining,
  chooseRail,
  dayStartUtc,
  itemsOf,
  localHour,
  lockUserPayments,
  monthStartUtc,
  payeeHistory,
  completedPaymentsToPayee,
  reserveBreached,
  smallAutoUsedSince,
  usedHomeSince,
  zoneFor,
} from "./facts.ts";
import { activeFundingSource } from "../funding-sources/store.ts";
import { chooseFunding, type FundingChoice } from "./funding.ts";
import { riskFeatures, riskScore } from "./risk.ts";
import { APPROVAL_TTL_MS, signApproval } from "./signing.ts";
import { assertionOptions, verifyRulesAssertion } from "./webauthn.ts";

export type ProposeOrderInput = {
  userId: string;
  createdBy: "AGENT" | "SCHEDULER" | "USER";
  payeeId: string;
  amountMinor: number;
  currency: string;
  purpose: string;
  rail?: Rail;
  items?: unknown[];
  category?: string;
  agentRequestedConfirm?: boolean;
  readerChecks?: { amount?: "VERIFIED" | "UNVERIFIED"; account?: "VERIFIED" | "UNVERIFIED"; nonCriticalUnverified?: boolean };
  triggerOrigin?: boolean;
  /** (added) scheduler link to the obligation being paid, and its due date (idempotency key). */
  obligationId?: string;
  dueDate?: string;
  /** (added, B1) documents whose Reader checks produced `readerChecks` (audit; stored on the draft). */
  sourceDocIds?: string[];
  /**
   * (added 2026-10-14, Business M2) The merchant order this payment buys (delivery order or till bill). Its items must
   * total exactly amountMinor; the order signs itemsHash(items), and the commerce hook fulfils exactly these items.
   */
  fulfillment?: Fulfillment;
  /**
   * (added 2026-10-15, Business M5) The passkey-signed supplier purchase order this payment settles (invoice three-way
   * match, business/invoices.ts). Signed into the CanonicalOrder; payments re-verifies the PO signature. Never AUTO.
   */
  purchaseOrderId?: string;
  /**
   * (added 2026-10-16, linked accounts) Pay from this ACTIVE linked card or bank instead of the wallet: bank rail only,
   * funded in the source's currency, and signed into the CanonicalOrder (fundingSourceId) with the funding binding.
   */
  fundingSourceId?: string;
  /**
   * (added 2026-10-20) The channel that asked holds no passkey and may never move money by itself (the voice Shortcut,
   * capture/routes.ts): the order is always ASK (T2, the user's passkey), never AUTO under a mandate or the small-auto
   * limit. Set by the server for that channel, never by the planner.
   */
  passkeyOnly?: boolean;
};

export type ProposeOrderResult = {
  proposalId: string;
  decision: Decision;
  reasonCodes: ReasonCode[];
  riskScore: number;
  summary: string;
  /** (added 2026-10-16) AUTO orders executed right away: the payment's status and, once SENT, how long it took. */
  paymentStatus?: PaymentStatus | null;
  deliveredInMs?: number;
};

export const ORDER_TTL_MS = 10 * MINUTE_MS;

// ---------- executor (dependency injection; see orders/wiring.ts) ----------

export type ExecutionResult = { paymentId: string | null; status: PaymentStatus | null; reasonCodes: ReasonCode[]; deliveredInMs?: number };
type Executor = (approvalId: string) => Promise<ExecutionResult>;
let executor: Executor | null = null;

export function registerExecutor(fn: Executor | null): void {
  executor = fn;
}

// ---------- handoff QR preflight (X7; injected like the executor, so rules never imports rails) ----------

type HandoffQrCheck = NonNullable<ProposalDraftJson["handoffQr"]>;
type HandoffPreflight = (order: CanonicalOrder) => Promise<Omit<HandoffQrCheck, "checkedAt">>;
let handoffPreflight: HandoffPreflight | null = null;

export function registerHandoffPreflight(fn: HandoffPreflight | null): void {
  handoffPreflight = fn;
}

/**
 * (X7, cn report note 1) A pending HANDOFF order gets the merchant's QR request and its payee-name check when it is
 * first shown, before the passkey prompt. A mismatch refuses the order up front (QR_PAYEE_MISMATCH, nothing to
 * sign) and frees its obligation period. Stored on the draft; the handoff rail later pays exactly this QR.
 */
async function ensureHandoffCheck(db: DbOrTx, p: typeof proposals.$inferSelect): Promise<typeof proposals.$inferSelect> {
  if (p.status !== "PENDING_APPROVAL" || p.canonicalOrder?.rail !== "HANDOFF" || p.draft.handoffQr || !handoffPreflight) return p;
  let qr: Omit<HandoffQrCheck, "checkedAt">;
  try {
    qr = await handoffPreflight(p.canonicalOrder);
  } catch (err) {
    throw new HttpProblem(502, "RAIL_ERROR", `Could not get the merchant's QR request: ${(err as Error).message}`, { reasonCodes: ["RAIL_ERROR"] });
  }
  const handoffQr: HandoffQrCheck = { ...qr, checkedAt: clock.now().toISOString() };
  const mismatch = qr.check !== "MATCH";
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(proposals)
      .set({
        draft: { ...p.draft, handoffQr },
        ...(mismatch ? { status: "REFUSED" as const, reasonCodes: [...p.reasonCodes, "QR_PAYEE_MISMATCH" as const] } : {}),
        updatedAt: clock.now(),
      })
      .where(and(eq(proposals.id, p.id), eq(proposals.status, "PENDING_APPROVAL"), sql`${proposals.draft}->'handoffQr' is null`))
      .returning();
    // A concurrent request stored its check first: use that one.
    if (rows.length === 0) return (await tx.select().from(proposals).where(eq(proposals.id, p.id)))[0]!;
    const sealed = await sealPii(p.userId, { qrPayeeName: qr.qrPayeeName }, tx);
    if (mismatch) {
      await releaseSettlement(tx, p.id);
      await ledger.append("HANDOFF_MISMATCH", { userId: p.userId, proposalId: p.id, qrPaymentId: qr.qrPaymentId, nameSimilarity: qr.nameSimilarity, reasonCodes: ["QR_PAYEE_MISMATCH"], stage: "before-signing", ...sealed }, tx);
    } else {
      await ledger.append("HANDOFF_QR_CHECKED", { userId: p.userId, proposalId: p.id, qrPaymentId: qr.qrPaymentId, nameSimilarity: qr.nameSimilarity, check: "MATCH" }, tx);
    }
    return rows[0]!;
  });
}

// ---------- helpers ----------

function newNonce(): string {
  return randomBytes(16).toString("base64url"); // 16 random bytes, base64url (spec §7)
}

/** (cap currency) The payments daily cap pre-checked in the user's home currency (PAYMENTS_DAILY_CAP_CURRENCY converted, rounded down, mirrors payments). Unconvertible → 0: every payment is refused before signing (fail closed). */
async function paymentsCapInHome(homeCurrency: string, at: Date): Promise<number> {
  const e = env();
  if (e.PAYMENTS_DAILY_CAP_CURRENCY === homeCurrency) return e.PAYMENTS_DAILY_CAP_HOME_MINOR;
  try {
    const v = (await toHome(e.PAYMENTS_DAILY_CAP_HOME_MINOR, e.PAYMENTS_DAILY_CAP_CURRENCY, homeCurrency, at, "down")).amountMinor;
    return Number.isSafeInteger(v) && v >= 0 ? v : 0;
  } catch {
    return 0;
  }
}

function summarize(
  decision: Decision,
  codes: ReasonCode[],
  order: { amountMinor: number; currency: string; payeeName: string; fundingCurrency?: string | undefined; fundingAmountMinor?: number | undefined },
  home?: { amountMinor: number; currency: string },
): string {
  let money: string;
  try {
    money = formatMoney(order.amountMinor, order.currency);
    if (home && home.currency !== order.currency) money += ` (≈ ${formatMoney(home.amountMinor, home.currency)})`;
  } catch {
    money = `${order.amountMinor} ${order.currency} (minor units)`;
  }
  const verb: Record<Decision, string> = {
    AUTO: "Paid automatically inside your signed rules",
    ASK: "Needs your passkey approval",
    HANDOFF: "Ready for you to pay yourself (handoff)",
    REFUSE: "Refused",
  };
  let funded = "";
  if (order.fundingCurrency && order.fundingAmountMinor !== undefined && order.fundingCurrency !== order.currency) {
    try {
      funded = ` Paid from your ${order.fundingCurrency} balance, at most ${formatMoney(order.fundingAmountMinor, order.fundingCurrency)} incl. fees.`;
    } catch {
      funded = ` Paid from your ${order.fundingCurrency} balance, at most ${order.fundingAmountMinor} (minor units) incl. fees.`;
    }
  }
  return `${verb[decision]}: ${money} to ${order.payeeName}.${funded} ${reasonsSentenceEn(codes)}`;
}

function statusFor(decision: Decision): "REFUSED" | "PENDING_APPROVAL" | "APPROVED" {
  if (decision === "REFUSE") return "REFUSED";
  if (decision === "AUTO") return "APPROVED";
  return "PENDING_APPROVAL";
}

async function issueApproval(
  db: DbOrTx,
  p: { proposalId: string; orderHash: string; tier: "T1" | "T2"; userAssertion: unknown; mandateId: string | null },
): Promise<string> {
  const issuedAt = clock.now();
  const expiresAt = addMs(issuedAt, APPROVAL_TTL_MS);
  const { fields, sig } = signApproval({
    orderHash: p.orderHash,
    tier: p.tier,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  const rows = await db
    .insert(approvals)
    .values({
      proposalId: p.proposalId,
      orderHash: fields.orderHash,
      tier: fields.tier,
      approvalSig: sig,
      keyId: fields.keyId,
      userAssertion: (p.userAssertion as never) ?? null,
      mandateId: p.mandateId,
      issuedAt,
      expiresAt,
    })
    .returning({ id: approvals.id });
  return rows[0]!.id;
}

async function runExecutor(proposalId: string, userId: string, approvalId: string): Promise<ExecutionResult> {
  if (!executor) return { paymentId: null, status: null, reasonCodes: [] };
  const res = await executor(approvalId);
  const db = getDb();
  const ok = res.status !== null && res.status !== "FAILED" && res.status !== "CANCELED";
  await db.transaction(async (tx) => {
    await tx
      .update(proposals)
      .set({ status: ok ? "EXECUTED" : "FAILED", updatedAt: clock.now() })
      .where(eq(proposals.id, proposalId));
    // B4: an executed proposal settles its obligation period; a failed one frees it for a new proposal.
    if (ok) await markSettlementPaid(tx, proposalId);
    else await releaseSettlement(tx, proposalId);
  });
  // Refused by payments before a payment row existed; outcomes of created payments are notified by payments (X9).
  if (!ok && res.paymentId === null) {
    await notify(userId, {
      kind: "PAYMENT_FAILED",
      title: "Payment not sent",
      body: `Payments refused or failed: ${res.reasonCodes.join(", ")}`,
      data: { proposalId, reasonCodes: res.reasonCodes },
    });
  }
  return res;
}

// ---------- proposeOrder ----------

/** Thrown inside the proposal transaction when another proposal claimed the obligation period first (B4). */
class SettlementTaken extends Error {}
/** Thrown inside the proposal transaction when an AUTO order no longer fits the caps under the payments lock. */
class CapRace extends Error {}

/**
 * (2026-10-18) Decide step 5 again, at the moment an order is approved (T2 passkey or AUTO), under the per-user advisory
 * lock payments takes around its own cap and payment insert. Usage counts live payments AND approved orders still in
 * flight, so two orders proposed under the cap one by one cannot both be approved past it (proposal-time facts cannot
 * see each other). Returns the refusal codes, or null when the caps still hold. Must run inside `tx` before the order
 * is marked APPROVED; the lock is released when `tx` commits, after which this order counts as in flight.
 * The protected reserve is not re-read here (wallet balance, checked at proposal time; the bank's funds check backs it).
 */
async function capsStillHold(tx: DbOrTx, userId: string, order: CanonicalOrder, now: Date, excludeProposalId?: string): Promise<ReasonCode[] | null> {
  // A conversion moves money between the user's own balances: outside the payment caps (CONVERT, 2026-10-18).
  if (order.rail === "CONVERT") return null;
  await lockUserPayments(tx, userId);
  const { user, caps } = await loadUser(tx, userId);
  const amountHomeMinor =
    order.homeCurrency === user.homeCurrency ? order.homeAmountMinor : (await toHome(order.amountMinor, order.currency, user.homeCurrency, now)).amountMinor;
  const usedToday = await usedHomeSince(tx, userId, dayStartUtc(now), excludeProposalId);
  const usedMonth = await usedHomeSince(tx, userId, monthStartUtc(now), excludeProposalId);
  const { capHit, paymentsCapHit } = capBreaches({
    amountHomeMinor,
    perPaymentHomeMinor: caps.perPaymentMinor,
    dailyHomeMinor: caps.perDayMinor,
    monthlyHomeMinor: caps.perMonthMinor,
    usedTodayHomeMinor: usedToday,
    usedThisMonthHomeMinor: usedMonth,
    reserveBreached: null,
    paymentsDailyHomeMinor: await paymentsCapInHome(user.homeCurrency, now),
  });
  if (capHit) return ["REFUSE_CAP"];
  if (paymentsCapHit) return ["REFUSE_CAP", "PAYMENTS_DAILY_CAP"];
  return null;
}

export async function proposeOrder(input: ProposeOrderInput, internal: { duplicateObligation?: boolean; capRace?: boolean } = {}): Promise<ProposeOrderResult> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new HttpProblem(400, "BAD_AMOUNT", "amountMinor must be a positive integer (minor units)");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new HttpProblem(400, "BAD_CURRENCY", "currency must be ISO 4217");
  let fulfillment: Fulfillment | null = null;
  if (input.fulfillment) {
    const f = Fulfillment.safeParse(input.fulfillment);
    if (!f.success) throw new HttpProblem(400, "BAD_FULFILLMENT", "fulfillment is invalid");
    const total = f.data.items.reduce((s, i) => s + i.qty * i.unitPriceMinor, 0);
    if (total !== input.amountMinor) throw new HttpProblem(400, "BAD_FULFILLMENT", `fulfillment items total ${total}, not amountMinor ${input.amountMinor}`);
    if (f.data.channel === "TILL" && !f.data.billId) throw new HttpProblem(400, "BAD_FULFILLMENT", "a TILL fulfillment needs its billId");
    fulfillment = f.data;
  }
  const db = getDb();
  const now = clock.now();
  const { user, profile, caps } = await loadUser(db, input.userId);
  const effective = effectiveOf(user);
  // A removed recipient (archivedAt) is no payee at all: refused like an unknown one.
  const payee = (await db.select().from(payees).where(and(eq(payees.id, input.payeeId), eq(payees.userId, input.userId), isNull(payees.archivedAt))))[0] ?? null;
  const rail = chooseRail(input.rail, effective.moneyMode, user.region, payee?.kind ?? "PERSON");
  const home = await toHome(input.amountMinor, input.currency, user.homeCurrency, now);

  // B4: the obligation period this order pays (scheduler and agent alike) and whether it is already taken.
  let period: string | null = null;
  let linked: LinkedObligation | null = null;
  if (input.obligationId) {
    const ob = (await db.select().from(obligations).where(and(eq(obligations.id, input.obligationId), eq(obligations.userId, user.id))))[0];
    if (!ob || ob.payeeId !== input.payeeId) throw new HttpProblem(400, "BAD_OBLIGATION", "obligationId is not this user's obligation for this payee");
    period = input.dueDate ?? ob.dueDate;
    linked = { id: ob.id, category: ob.category, amountMinor: ob.amountMinor, currency: ob.currency, dueDate: ob.dueDate, period };
  }
  // (M5) A purchase-order invoice: the PO must be the user's own, signed, for this supplier, and cover the amount.
  let poNotDelivered = false;
  if (input.purchaseOrderId) {
    const row = (
      await db
        .select({ po: purchaseOrders, ownerUserId: merchants.ownerUserId })
        .from(purchaseOrders)
        .innerJoin(merchants, eq(merchants.id, purchaseOrders.merchantId))
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
    )[0];
    const core = row?.po.core;
    if (!row || row.ownerUserId !== user.id || !core || !row.po.poHash) throw new HttpProblem(400, "BAD_PURCHASE_ORDER", "purchaseOrderId is not a signed purchase order of this user");
    if (core.supplierPayeeId !== input.payeeId) throw new HttpProblem(400, "BAD_PURCHASE_ORDER", "the payee is not the purchase order's supplier", { reasonCodes: ["INVOICE_ACCOUNT_MISMATCH"] });
    if (core.currency !== input.currency || input.amountMinor > core.totalMinor) throw new HttpProblem(400, "BAD_PURCHASE_ORDER", "amount above the signed purchase order total", { reasonCodes: ["INVOICE_ABOVE_PO"] });
    poNotDelivered = !row.po.timeline.some((t) => t.status === "DELIVERED");
  }
  // X1: a linked bill's category comes from the obligation (server side), never from the caller's input.
  const category = linked?.category ?? input.category ?? (payee ? budgetCategoryFor(payee.kind, readDetails(payee)) : "other");
  const duplicateObligation = internal.duplicateObligation === true || (period !== null && (await settlementFor(db, input.obligationId!, period)) !== null);

  // (linked accounts) The source the user chose to pay from: their own, active, and only for a bank transfer.
  const source = input.fundingSourceId ? await activeFundingSource(user.id, input.fundingSourceId) : null;
  if (input.fundingSourceId && !source) {
    throw new HttpProblem(422, "FUNDING_SOURCE_UNAVAILABLE", "That card or bank account is not linked (any more)", { reasonCodes: ["FUNDING_SOURCE_UNAVAILABLE"] });
  }
  if (source && rail !== "BANK_TRANSFER") {
    throw new HttpProblem(422, "FUNDING_SOURCE_NOT_FOR_RAIL", "A linked account pays bank transfers; this payment goes another way", { reasonCodes: ["FUNDING_SOURCE_UNAVAILABLE"] });
  }

  // B2: funding route for bank transfers (spec §12), bound into the signed order below.
  let funding: FundingChoice | null = null;
  if (rail === "BANK_TRANSFER" && payee && !duplicateObligation) {
    const choose = () => chooseFunding({ userId: user.id, homeCurrency: user.homeCurrency, amountMinor: input.amountMinor, currency: input.currency, now, dueDate: period ?? input.dueDate, linkedCurrency: source?.currency });
    funding = await choose();
    // (2026-10-18) Balances unreadable: read once more (a bank blip), then refuse (BALANCES_UNAVAILABLE, decide 4b).
    // A guessed same-currency binding is never signed: it let an order the wallet cannot cover reach the passkey.
    if (funding.status === "UNKNOWN") funding = await choose();
  }
  const balancesUnknown = funding?.status === "UNKNOWN";
  const signedFunding = funding && funding.status === "OK" ? funding.funding : null;

  // I9 / X4: screen the payee on every rail (card, handoff, pay-in-place, bank).
  const screening = payee ? screenName(payee.name) : { hit: false as const, score: 0 };
  const [usedToday, usedMonth, reserve, mandate, history, remaining, smallAutoToday, completedToPayee] = await Promise.all([
    // (2026-10-18) executed + in flight (approved, not yet a payment row)
    usedHomeSince(db, user.id, dayStartUtc(now)),
    usedHomeSince(db, user.id, monthStartUtc(now)),
    // Paid from a linked account, the wallet's reserve is not touched.
    source ? Promise.resolve(false) : reserveBreached(user.id, user.homeCurrency, caps.reserveMinor, home.amountMinor, now),
    payee
      ? findMatchingMandate(db, { userId: user.id, payeeId: payee.id, currency: input.currency, amountMinor: input.amountMinor, now, obligation: linked })
      : Promise.resolve({ match: null, outOfScope: false, scopeMismatch: false }),
    payee ? payeeHistory(db, user.id, payee.id) : Promise.resolve({ count: 0, priceHistory: {}, qtyHistory: {} }),
    categoryRemaining(db, user.id, category, now),
    smallAutoUsedSince(db, user.id, dayStartUtc(now)),
    payee ? completedPaymentsToPayee(db, user.id, payee.id) : Promise.resolve(0),
  ]);
  const triggerOrigin = input.createdBy === "SCHEDULER" || input.triggerOrigin === true;
  const features = riskFeatures({
    priorPaymentsToPayee: history.count,
    items: itemsOf(input.items),
    priceHistory: history.priceHistory,
    qtyHistory: history.qtyHistory,
    amountHomeMinor: home.amountMinor,
    categoryRemainingHomeMinor: remaining,
    localHour: localHour(now, zoneFor(user.region)),
    triggerOrigin,
    readerUnverifiedNonCritical: input.readerChecks?.nonCriticalUnverified === true,
  });
  const score = riskScore(features);

  const paymentsCapHome = await paymentsCapInHome(user.homeCurrency, now);
  // (KYC) only orders Kassa pays out and only above the threshold need the identity check; read the standing then.
  const kycRequired =
    rail !== "HANDOFF" && home.amountMinor > (await kycThresholdInHome(user.homeCurrency, now)) && (await kycStatusOf(db, user.id)) !== "VERIFIED";
  const decided: DecideResult = decide({
    now,
    frozen: user.frozenAt !== null,
    payee: payee ? { status: payee.status, coolingUntil: payee.coolingUntil, hasAccount: payee.accountHash !== null } : null,
    readerChecks: input.readerChecks,
    rail,
    screeningHit: screening.hit,
    caps: {
      amountHomeMinor: home.amountMinor,
      perPaymentHomeMinor: caps.perPaymentMinor,
      dailyHomeMinor: caps.perDayMinor,
      monthlyHomeMinor: caps.perMonthMinor,
      usedTodayHomeMinor: usedToday,
      usedThisMonthHomeMinor: usedMonth,
      reserveBreached: reserve,
      paymentsDailyHomeMinor: paymentsCapHome,
    },
    preset: user.preset,
    effective,
    region: user.region,
    mandate: mandate.match ? { id: mandate.match.id } : null,
    mandateOutOfScope: mandate.outOfScope,
    mandateScopeMismatch: mandate.scopeMismatch,
    // (2026-10-19) mandate AUTO only for a bill the scheduler would pay now (same window, scheduler/window.ts)
    mandateNotDueYet: linked !== null && linked.period > dueHorizon(now),
    riskScore: score,
    agentRequestedConfirm: input.agentRequestedConfirm === true,
    triggerOrigin,
    smallAutoLimitHomeMinor: caps.smallAutoMinor,
    priorCompletedPaymentsToPayee: completedToPayee,
    smallAutoBudget: {
      usedCount: smallAutoToday.count,
      usedHomeMinor: smallAutoToday.homeMinor,
      maxCount: env().SMALL_AUTO_DAILY_MAX_COUNT,
      maxHomeMinor: env().SMALL_AUTO_DAILY_AMOUNT_MULTIPLE * caps.smallAutoMinor,
    },
    baseRulesSigned: profile.baseRulesAssertion !== null && profile.baseRulesHash !== null,
    duplicateObligation,
    fundingAvailable: funding === null ? null : funding.status !== "NONE",
    balancesUnknown,
    kycRequired,
  });
  // (M5) A supplier invoice is always paid with the owner's passkey (T2): never AUTO, never under a mandate; an
  // invoice for an undelivered PO says so.
  let result = decided;
  if (input.purchaseOrderId && decided.decision !== "REFUSE") {
    const codes: ReasonCode[] = [...decided.reasonCodes];
    if (poNotDelivered) codes.push("PO_NOT_DELIVERED");
    result = decided.decision === "AUTO" ? { ...decided, decision: "ASK", tier: "T2", mandateId: null, reasonCodes: codes.filter((c) => c !== "MANDATE_MATCH" && c !== "SMALL_AUTO") } : { ...decided, reasonCodes: codes };
  }
  // A passkey-only channel (the voice Shortcut) never gets AUTO: the passkey approval is the only way its order executes.
  if (input.passkeyOnly && result.decision === "AUTO") {
    const codes = result.reasonCodes.filter((c) => c !== "MANDATE_MATCH" && c !== "SMALL_AUTO");
    result = { ...result, decision: "ASK", tier: "T2", mandateId: null, reasonCodes: codes.includes("AGENT_REQUESTED_CONFIRM") ? codes : [...codes, "AGENT_REQUESTED_CONFIRM"] };
  }

  const proposalId = randomUUID();
  const draft: ProposalDraftJson = {
    payeeId: input.payeeId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    purpose: input.purpose,
    rail,
    items: input.items,
    category,
    agentRequestedConfirm: input.agentRequestedConfirm,
    readerChecks: input.readerChecks,
    triggerOrigin: input.triggerOrigin,
    obligationId: input.obligationId,
    dueDate: input.dueDate,
    riskFeatures: features,
    ...(input.sourceDocIds?.length ? { sourceDocIds: input.sourceDocIds } : {}),
    ...(input.obligationId && period ? { dueDate: period } : {}),
    ...(fulfillment ? { fulfillment } : {}),
    ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
    ...(source ? { fundingSourceId: source.id } : {}),
  };
  let order: CanonicalOrder | null = null;
  let hash: string | null = null;
  // decide() refuses a payee without account details; the accountHash check keeps an order from ever binding none.
  if (result.decision !== "REFUSE" && payee && payee.accountHash !== null) {
    order = {
      v: 1,
      proposalId,
      userId: user.id,
      payeeId: payee.id,
      payeeName: payee.name,
      payeeAccountHash: payee.accountHash,
      amountMinor: input.amountMinor,
      currency: input.currency,
      rail: result.decision === "HANDOFF" ? "HANDOFF" : rail,
      purpose: input.purpose.slice(0, 140),
      homeAmountMinor: home.amountMinor,
      homeCurrency: user.homeCurrency,
      mandateId: result.mandateId,
      nonce: newNonce(),
      expiresAt: addMs(now, ORDER_TTL_MS).toISOString(),
      ...(result.decision !== "HANDOFF" && rail === "BANK_TRANSFER" && signedFunding
        ? {
            fundingCurrency: signedFunding.currency,
            fundingAmountMinor: signedFunding.maxAmountMinor,
            fundingRouteId: signedFunding.routeId,
            fundingMarkupBps: signedFunding.markupBps,
            ...(source ? { fundingSourceId: source.id } : {}),
          }
        : {}),
      // X1: the bill this order pays is signed with it (payments re-checks it for mandate payments).
      ...(linked ? { obligationId: linked.id, obligationPeriod: linked.period } : {}),
      // (M2) what is bought: the shop order / till bill fulfilled after payment must hash to this.
      ...(fulfillment ? { itemsHash: computeItemsHash(fulfillment.items) } : {}),
      // (M5) the signed purchase order this pays: payments re-verifies its owner signature, supplier and total.
      ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
    };
    hash = computeOrderHash(order);
  }

  let approvalId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(proposals).values({
        id: proposalId,
        userId: user.id,
        createdBy: input.createdBy,
        draft,
        decision: result.decision,
        reasonCodes: result.reasonCodes,
        riskScore: score,
        canonicalOrder: order,
        orderHash: hash,
        status: statusFor(result.decision),
        category,
        obligationId: input.obligationId ?? null,
        createdAt: now,
        updatedAt: now,
      });
      await ledger.append(
        "PROPOSAL_CREATED",
        {
          userId: user.id,
          proposalId,
          createdBy: input.createdBy,
          decision: result.decision,
          reasonCodes: result.reasonCodes,
          riskScore: score,
          orderHash: hash,
          amountMinor: input.amountMinor,
          currency: input.currency,
          payeeId: input.payeeId,
          rail,
          fx: { rate: home.rate, rateDate: home.rateDate, source: home.source },
          funding: order?.fundingCurrency
            ? { currency: order.fundingCurrency, maxAmountMinor: order.fundingAmountMinor, routeId: order.fundingRouteId, markupBps: order.fundingMarkupBps, estimatedAmountMinor: signedFunding?.estimatedAmountMinor, balancesKnown: funding?.status === "OK", fundingSourceId: order.fundingSourceId }
            : undefined,
          obligation: period ? { obligationId: input.obligationId, period } : undefined,
          screening: screening.hit ? { hit: true, entryId: screening.entryId, score: screening.score } : undefined,
        },
        tx,
      );
      // B4: claim the obligation period; the primary key makes a concurrent second claim lose.
      if (period && result.decision !== "REFUSE") {
        const claimed = await claimSettlement(tx, { userId: user.id, obligationId: input.obligationId!, period, proposalId });
        if (!claimed) throw new SettlementTaken();
      }
      if (result.decision === "AUTO" && order && hash) {
        // (2026-10-18) the caps again under the payments lock, counting orders approved since the facts were read.
        if (await capsStillHold(tx, user.id, order, now, proposalId)) throw new CapRace();
        approvalId = await issueApproval(tx, { proposalId, orderHash: hash, tier: "T1", userAssertion: null, mandateId: result.mandateId });
        await ledger.append("APPROVAL_ISSUED", { userId: user.id, proposalId, approvalId, tier: "T1", mandateId: result.mandateId, orderHash: hash }, tx);
      }
    });
  } catch (err) {
    // Lost the race for the period: nothing was written; decide again as a duplicate (REFUSE).
    if (err instanceof SettlementTaken && !internal.duplicateObligation) return proposeOrder(input, { ...internal, duplicateObligation: true });
    // Another order was approved in between: decide again with it counted (step 5 then refuses REFUSE_CAP).
    if (err instanceof CapRace && !internal.capRace) return proposeOrder(input, { ...internal, capRace: true });
    if (err instanceof CapRace) throw new HttpProblem(409, "REFUSE_CAP", "This payment no longer fits your limits", { reasonCodes: ["REFUSE_CAP"] });
    throw err;
  }

  if (result.decision === "ASK" || result.decision === "HANDOFF") {
    await notify(user.id, {
      kind: "ORDER_NEEDS_APPROVAL",
      title: "Review and sign",
      body: summarize(result.decision, result.reasonCodes, { amountMinor: input.amountMinor, currency: input.currency, payeeName: payee?.name ?? "payee", fundingCurrency: order?.fundingCurrency, fundingAmountMinor: order?.fundingAmountMinor }),
      data: { proposalId, decision: result.decision, reasonCodes: result.reasonCodes },
    });
  }

  let reasonCodes = result.reasonCodes;
  const decision = result.decision;
  let executed: ExecutionResult | null = null;
  if (approvalId) {
    const exec = await runExecutor(proposalId, user.id, approvalId);
    executed = exec;
    if (exec.status === "FAILED" || exec.status === "CANCELED") {
      reasonCodes = [...reasonCodes, ...exec.reasonCodes];
    }
  }
  if (decision === "REFUSE") {
    await notify(user.id, {
      kind: "ORDER_REFUSED",
      title: "Payment refused",
      body: summarize(decision, reasonCodes, { amountMinor: input.amountMinor, currency: input.currency, payeeName: payee?.name ?? "unknown recipient" }),
      data: { proposalId, reasonCodes },
    });
  }
  return {
    proposalId,
    decision,
    reasonCodes,
    riskScore: score,
    summary: summarize(
      decision,
      reasonCodes,
      { amountMinor: input.amountMinor, currency: input.currency, payeeName: payee?.name ?? "unknown recipient", fundingCurrency: order?.fundingCurrency, fundingAmountMinor: order?.fundingAmountMinor },
      { amountMinor: home.amountMinor, currency: user.homeCurrency },
    ),
    ...(executed ? { paymentStatus: executed.status, ...(executed.deliveredInMs !== undefined ? { deliveredInMs: executed.deliveredInMs } : {}) } : {}),
  };
}

// ---------- proposeConversion (2026-10-18) ----------

export type ProposeConversionInput = {
  userId: string;
  createdBy: "AGENT" | "USER";
  /** Buy this much of `toCurrency` (minor units)... */
  amountMinor: number;
  toCurrency: string;
  /** ...from this balance; omitted = the cheapest balance that covers it (route optimizer). */
  fromCurrency?: string | undefined;
  purpose?: string | undefined;
};

/**
 * An exchange between the user's own wallet balances (spec §12 "Convert"), as a CONVERT canonical order: buy
 * `amountMinor` of `toCurrency` from the `fromCurrency` balance, at most `fundingAmountMinor` debited, via a bank route
 * the optimizer picks (fee and markup in the signed maximum). No money leaves the user, so it is outside the payment
 * caps, the small-auto limit, mandates and screening; it is always ASK (T2, the passkey over the order), never AUTO, and
 * refused when frozen, when no balance covers it (INSUFFICIENT_FUNDS) or when the balances cannot be read
 * (BALANCES_UNAVAILABLE). Payments re-checks the shape (own wallet only) and the bank quote against the signed maximum.
 */
export async function proposeConversion(input: ProposeConversionInput): Promise<ProposeOrderResult> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new HttpProblem(400, "BAD_AMOUNT", "amountMinor must be a positive integer (minor units)");
  }
  for (const c of [input.toCurrency, input.fromCurrency]) {
    if (c !== undefined && !isSupportedCurrency(c)) throw new HttpProblem(400, "BAD_CURRENCY", `${c} is not a currency the wallet holds`);
  }
  if (input.fromCurrency === input.toCurrency) throw new HttpProblem(400, "BAD_CURRENCY", "Convert between two different currencies");
  const db = getDb();
  const now = clock.now();
  const { user } = await loadUser(db, input.userId);
  const home = await toHome(input.amountMinor, input.toCurrency, user.homeCurrency, now);
  const purpose = (input.purpose?.trim() || `Convert ${input.fromCurrency ? `${input.fromCurrency} ` : ""}to ${input.toCurrency}`).slice(0, 140);

  let codes: ReasonCode[];
  let funding: FundingChoice | null = null;
  if (user.frozenAt !== null) {
    codes = ["REFUSE_FROZEN"];
  } else {
    const fundingCurrencies = input.fromCurrency ? [input.fromCurrency] : SupportedCurrency.options.filter((c) => c !== input.toCurrency);
    const choose = () => chooseFunding({ userId: user.id, homeCurrency: user.homeCurrency, amountMinor: input.amountMinor, currency: input.toCurrency, now, fundingCurrencies });
    funding = await choose();
    if (funding.status === "UNKNOWN") funding = await choose();
    codes = funding.status === "UNKNOWN" ? ["BALANCES_UNAVAILABLE"] : funding.status === "NONE" ? ["INSUFFICIENT_FUNDS"] : ["CONVERT_OWN_BALANCES"];
  }
  const decision: Decision = funding?.status === "OK" ? "ASK" : "REFUSE";

  const proposalId = randomUUID();
  let order: CanonicalOrder | null = null;
  let hash: string | null = null;
  if (decision === "ASK" && funding?.status === "OK") {
    order = {
      v: 1,
      proposalId,
      userId: user.id,
      payeeId: user.id,
      payeeName: OWN_WALLET_PAYEE_NAME,
      payeeAccountHash: ownWalletAccountHash(user.id),
      amountMinor: input.amountMinor,
      currency: input.toCurrency,
      rail: "CONVERT",
      purpose,
      homeAmountMinor: home.amountMinor,
      homeCurrency: user.homeCurrency,
      mandateId: null,
      nonce: newNonce(),
      expiresAt: addMs(now, ORDER_TTL_MS).toISOString(),
      fundingCurrency: funding.funding.currency,
      fundingAmountMinor: funding.funding.maxAmountMinor,
      fundingRouteId: funding.funding.routeId,
      fundingMarkupBps: funding.funding.markupBps,
    };
    hash = computeOrderHash(order); // also checks the conversion shape (orderConversion)
  }
  const draft: ProposalDraftJson = { payeeId: user.id, amountMinor: input.amountMinor, currency: input.toCurrency, purpose, rail: "CONVERT", category: CONVERSION_CATEGORY, ...(input.fromCurrency ? { fromCurrency: input.fromCurrency } : {}) };
  await db.transaction(async (tx) => {
    await tx.insert(proposals).values({
      id: proposalId,
      userId: user.id,
      createdBy: input.createdBy,
      draft,
      decision,
      reasonCodes: codes,
      riskScore: 0,
      canonicalOrder: order,
      orderHash: hash,
      status: statusFor(decision),
      category: CONVERSION_CATEGORY,
      obligationId: null,
      createdAt: now,
      updatedAt: now,
    });
    await ledger.append(
      "PROPOSAL_CREATED",
      {
        userId: user.id,
        proposalId,
        createdBy: input.createdBy,
        kind: "CONVERT",
        decision,
        reasonCodes: codes,
        riskScore: 0,
        orderHash: hash,
        amountMinor: input.amountMinor,
        currency: input.toCurrency,
        rail: "CONVERT",
        fx: { rate: home.rate, rateDate: home.rateDate, source: home.source },
        funding: order ? { currency: order.fundingCurrency, maxAmountMinor: order.fundingAmountMinor, routeId: order.fundingRouteId, markupBps: order.fundingMarkupBps, estimatedAmountMinor: funding?.status === "OK" ? funding.funding.estimatedAmountMinor : undefined } : undefined,
      },
      tx,
    );
  });
  const summary = conversionSummary(decision, codes, order, input);
  await notify(user.id, {
    kind: decision === "ASK" ? "ORDER_NEEDS_APPROVAL" : "ORDER_REFUSED",
    title: decision === "ASK" ? "Review and sign" : "Conversion refused",
    body: summary,
    data: { proposalId, decision, reasonCodes: codes },
  });
  return { proposalId, decision, reasonCodes: codes, riskScore: 0, summary };
}

/** Budget category of a conversion (an exchange, not spending: no budget covers it). */
export const CONVERSION_CATEGORY = "conversion";

function conversionSummary(decision: Decision, codes: ReasonCode[], order: CanonicalOrder | null, input: ProposeConversionInput): string {
  if (order) return `Needs your passkey approval to ${orderBodyEn(order)} ${reasonsSentenceEn(codes)}`;
  let want: string;
  try {
    want = isoMoney(input.amountMinor, input.toCurrency);
  } catch {
    want = `${input.amountMinor} ${input.toCurrency} (minor units)`;
  }
  return `Refused: converting into ${want}${input.fromCurrency ? ` from your ${input.fromCurrency} balance` : ""}. ${reasonsSentenceEn(codes)}`;
}

// ---------- order view / approve / reject (T2) ----------

async function loadOwnProposal(db: DbOrTx, userId: string, proposalId: string) {
  const p = (await db.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.userId, userId))))[0];
  // BOLA (OWASP API1): another user's order is indistinguishable from a missing one; the probe is audited.
  if (!p) throw await ownedNotFound(userId, "order", proposalId, async () => (await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.id, proposalId))).length > 0);
  return p;
}

/**
 * Re-issue an expired, still-pending order with a fresh nonce and expiry (same content otherwise).
 * The old hash can never be approved: approve checks the stored hash and expiry.
 */
async function refreshIfExpired(db: DbOrTx, p: typeof proposals.$inferSelect) {
  if (p.status !== "PENDING_APPROVAL" || !p.canonicalOrder) return p;
  const now = clock.now();
  if (Date.parse(p.canonicalOrder.expiresAt) > now.getTime()) return p;
  const order: CanonicalOrder = { ...p.canonicalOrder, nonce: newNonce(), expiresAt: addMs(now, ORDER_TTL_MS).toISOString() };
  const hash = computeOrderHash(order);
  const rows = await db
    .update(proposals)
    .set({ canonicalOrder: order, orderHash: hash, updatedAt: now })
    .where(eq(proposals.id, p.id))
    .returning();
  await ledger.append("ORDER_REISSUED", { userId: p.userId, proposalId: p.id, orderHash: hash, previousOrderHash: p.orderHash });
  return rows[0]!;
}

export async function getOrderView(userId: string, proposalId: string) {
  const db = getDb();
  const loaded = await loadOwnProposal(db, userId, proposalId);
  const refreshed = await refreshIfExpired(db, loaded);
  const p = await ensureHandoffCheck(db, refreshed);
  // X8: tell the client this request replaced an expired order, so it shows "expired, review again".
  const reissuedFrom = refreshed !== loaded && loaded.orderHash ? loaded.orderHash : null;
  return buildOrderView(db, userId, p, reissuedFrom);
}

async function buildOrderView(db: DbOrTx, userId: string, p: typeof proposals.$inferSelect, reissuedFrom: string | null) {
  if (!p.canonicalOrder || !p.orderHash) {
    throw new HttpProblem(409, p.reasonCodes[0] ?? "REFUSED", "This order was refused and has nothing to sign", { reasonCodes: p.reasonCodes });
  }
  const payee = (await db.select().from(payees).where(eq(payees.id, p.canonicalOrder.payeeId)))[0];
  // (2026-10-18) a CONVERT order credits the user's own wallet (no payee row), checked in orderConversion.
  const ownWallet = p.canonicalOrder.rail === "CONVERT" && p.canonicalOrder.payeeId === userId && p.canonicalOrder.payeeAccountHash === ownWalletAccountHash(userId);
  const now = clock.now();
  const remaining = await categoryRemaining(db, userId, p.category, now);
  const { user } = await loadUser(db, userId);
  let budgetImpact = null;
  if (remaining !== null) {
    const today = now.toISOString().slice(0, 10);
    const b = (
      await db
        .select()
        .from(budgets)
        .where(and(eq(budgets.userId, userId), eq(budgets.category, p.category), lte(budgets.periodStart, today), gte(budgets.periodEnd, today)))
    )[0];
    if (b) {
      const end = Date.parse(`${b.periodEnd}T23:59:59.999Z`);
      budgetImpact = {
        category: p.category,
        homeCurrency: user.homeCurrency,
        limitHomeMinor: b.limitHomeMinor,
        remainingBeforeHomeMinor: remaining,
        remainingAfterHomeMinor: remaining - p.canonicalOrder.homeAmountMinor,
        daysLeft: Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000)),
      };
    }
  }
  const pending = p.status === "PENDING_APPROVAL";
  return {
    canonicalOrder: p.canonicalOrder,
    orderHash: p.orderHash,
    webauthnOptions: pending ? await assertionOptions(db, userId, p.orderHash) : null,
    budgetImpact,
    payeeStatus: ownWallet ? ("VERIFIED" as const) : (payee?.status ?? "BLOCKED"),
    decision: p.decision,
    reasonCodes: p.reasonCodes,
    status: p.status,
    ...(reissuedFrom ? { reissuedFromOrderHash: reissuedFrom } : {}),
    ...(p.draft.handoffQr
      ? {
          handoff: {
            check: p.draft.handoffQr.check,
            qrPayeeName: p.draft.handoffQr.qrPayeeName,
            verifiedPayeeName: p.draft.handoffQr.verifiedPayeeName,
            nameSimilarity: p.draft.handoffQr.nameSimilarity,
          },
        }
      : {}),
  };
}

export type ApproveResult = {
  approvalId: string;
  tier: "T1" | "T2";
  paymentId: string | null;
  paymentStatus: PaymentStatus | null;
  reasonCodes: ReasonCode[];
  deliveredInMs?: number;
};

/** POST /orders/:id/approve — rules verification (spec §7) then signed approval → executor. */
export async function approveOrder(userId: string, proposalId: string, assertion: unknown): Promise<ApproveResult> {
  const db = getDb();
  let p = await loadOwnProposal(db, userId, proposalId);
  // X7: a handoff order is checked before signing (also when the client skipped GET /orders/:id).
  if (p.status === "PENDING_APPROVAL" && Date.parse(p.canonicalOrder?.expiresAt ?? "") > clock.nowMs()) p = await ensureHandoffCheck(db, p);
  if (p.reasonCodes.includes("QR_PAYEE_MISMATCH") || p.draft.handoffQr?.check === "QR_PAYEE_MISMATCH") {
    throw new HttpProblem(409, "QR_PAYEE_MISMATCH", "The merchant's QR names someone else than the verified payee; this order cannot be approved", { reasonCodes: ["QR_PAYEE_MISMATCH"] });
  }
  if (p.status !== "PENDING_APPROVAL" || !p.canonicalOrder || !p.orderHash) {
    throw new HttpProblem(409, "NOT_PENDING", `Order is ${p.status}`, { reasonCodes: p.reasonCodes });
  }
  const { user } = await loadUser(db, userId);
  if (user.frozenAt) throw new HttpProblem(403, "REFUSE_FROZEN", "Account is frozen", { reasonCodes: ["REFUSE_FROZEN"] });
  // The stored order must still hash to the stored orderHash (I3).
  if (computeOrderHash(p.canonicalOrder) !== p.orderHash) {
    throw new HttpProblem(409, "ORDER_HASH_MISMATCH", "Stored order does not match its hash", { reasonCodes: ["ORDER_HASH_MISMATCH"] });
  }
  if (Date.parse(p.canonicalOrder.expiresAt) <= clock.nowMs()) {
    // X8 (p2 B3): never sign or execute a re-issued order in this call. Re-issue it (new nonce/expiry/hash) and
    // return it for review; the assertion the client sent is over the OLD hash and is discarded.
    const refreshed = await refreshIfExpired(db, p);
    const view = await buildOrderView(db, userId, await ensureHandoffCheck(db, refreshed), p.orderHash);
    throw new HttpProblem(410, "ORDER_EXPIRED", "This order expired. Review the re-issued order and sign it again.", { reasonCodes: ["ORDER_EXPIRED"], details: view });
  }
  if (p.canonicalOrder.rail === "CONVERT") {
    // (2026-10-18) a conversion credits only the signing user's own wallet (no payee row to re-check).
    if (p.canonicalOrder.payeeId !== userId || p.canonicalOrder.payeeAccountHash !== ownWalletAccountHash(userId)) {
      throw new HttpProblem(409, "REFUSE_UNVERIFIED_PAYEE", "A conversion can only credit your own wallet", { reasonCodes: ["REFUSE_UNVERIFIED_PAYEE"] });
    }
  } else {
    // Payee state may have changed since the draft (blocked, or replaced): re-check.
    const payee = (await db.select().from(payees).where(eq(payees.id, p.canonicalOrder.payeeId)))[0];
    if (!payee || payee.status === "BLOCKED" || payee.archivedAt !== null || payee.accountHash !== p.canonicalOrder.payeeAccountHash) {
      throw new HttpProblem(409, "REFUSE_UNVERIFIED_PAYEE", "Recipient changed, blocked or removed", { reasonCodes: ["REFUSE_UNVERIFIED_PAYEE"] });
    }
    if (payee.status === "COOLING" && (!payee.coolingUntil || payee.coolingUntil.getTime() > clock.nowMs())) {
      throw new HttpProblem(409, "REFUSE_UNVERIFIED_PAYEE", "Payee is still cooling", { reasonCodes: ["REFUSE_UNVERIFIED_PAYEE", "PAYEE_COOLING"] });
    }
  }

  const check = await verifyRulesAssertion(db, { userId, assertion, expectedChallenge: p.orderHash, challengeReason: "ORDER_HASH_MISMATCH" });
  if (!check.ok) {
    await ledger.append("APPROVAL_DENIED", { userId, proposalId, reasonCodes: [check.reason], detail: check.detail });
    throw new HttpProblem(403, check.reason, check.detail, { reasonCodes: [check.reason] });
  }

  let approvalId = "";
  const held: { codes: ReasonCode[] | null } = { codes: null };
  await db.transaction(async (tx) => {
    // (2026-10-18) Caps re-checked under the payments lock, counting live payments and other approved orders in flight
    // (two pending orders that each fit cannot both be approved past the cap). Nothing is written when they no longer
    // hold; the order stays pending (it can be approved once the cap allows it, e.g. tomorrow, or after a raise).
    held.codes = await capsStillHold(tx, userId, p.canonicalOrder!, clock.now());
    if (held.codes) return;
    // Guard against double approval racing: only one PENDING → APPROVED transition wins.
    const updated = await tx
      .update(proposals)
      .set({ status: "APPROVED", updatedAt: clock.now() })
      .where(and(eq(proposals.id, proposalId), eq(proposals.status, "PENDING_APPROVAL")))
      .returning({ id: proposals.id });
    if (updated.length === 0) throw new HttpProblem(409, "NOT_PENDING", "Order already handled");
    approvalId = await issueApproval(tx, {
      proposalId,
      orderHash: p.orderHash!,
      tier: "T2",
      userAssertion: assertion,
      mandateId: p.canonicalOrder!.mandateId,
    });
    await ledger.append("APPROVAL_ISSUED", { userId, proposalId, approvalId, tier: "T2", orderHash: p.orderHash, credentialId: check.credentialId }, tx);
  });
  if (held.codes) {
    await ledger.append("APPROVAL_DENIED", { userId, proposalId, reasonCodes: held.codes, detail: "caps re-checked at approval (executed + in-flight orders)" });
    throw new HttpProblem(409, "REFUSE_CAP", "Approving this now would go over one of your limits, counting payments already approved. Nothing was paid.", { reasonCodes: held.codes });
  }

  const exec = await runExecutor(proposalId, userId, approvalId);
  return { approvalId, tier: "T2", paymentId: exec.paymentId, paymentStatus: exec.status, reasonCodes: exec.reasonCodes, ...(exec.deliveredInMs !== undefined ? { deliveredInMs: exec.deliveredInMs } : {}) };
}

export async function rejectOrder(userId: string, proposalId: string, reason?: string): Promise<void> {
  const db = getDb();
  const p = await loadOwnProposal(db, userId, proposalId);
  if (p.status !== "PENDING_APPROVAL") throw new HttpProblem(409, "NOT_PENDING", `Order is ${p.status}`);
  await db.transaction(async (tx) => {
    await tx
      .update(proposals)
      .set({ status: "REJECTED", reasonCodes: [...p.reasonCodes, "USER_REJECTED"], updatedAt: clock.now() })
      .where(eq(proposals.id, proposalId));
    await releaseSettlement(tx, proposalId);
    // The free-text reason is personal: sealed with the user's key (crypto-shredding on erasure).
    const sealed = reason ? await sealPii(userId, { reason }, tx) : {};
    await ledger.append("ORDER_REJECTED", { userId, proposalId, reasonCodes: ["USER_REJECTED"], ...sealed }, tx);
  });
}

export { decide } from "./decide.ts";
export { riskFeatures, riskScore } from "./risk.ts";
export { RISK_WEIGHTS, SMART_RISK_THRESHOLD } from "./riskWeights.ts";
