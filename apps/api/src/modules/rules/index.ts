/*
 * Rules module (spec §5, §7, §10): drafts in, decisions out. Builds the canonical order, verifies the
 * user's WebAuthn assertion (T2) and signs approvals (Ed25519). It never moves money: AUTO/approved
 * orders are handed to an executor registered at startup (orders/wiring.ts → payments), so the agent →
 * rules import path never reaches payments (I1).
 */
import {
  formatMoney,
  orderHash as computeOrderHash,
  type CanonicalOrder,
  type Decision,
  type PaymentStatus,
  type Rail,
  type ReasonCode,
} from "@kassa/shared";
import { and, eq, gte, lte } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { approvals, budgets, payees, proposals, type ProposalDraftJson } from "../../db/schema.ts";
import { HttpProblem, notFound } from "../../http/problem.ts";
import { addMs, clock, MINUTE_MS } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { findMatchingMandate } from "../mandates/scope.ts";
import { toHome } from "../money/fx.ts";
import { notify } from "../notifications/service.ts";
import { screenName } from "../screening/index.ts";
import { effectiveOf, loadUser } from "../users/service.ts";
import { decide, type DecideResult } from "./decide.ts";
import {
  categoryRemaining,
  chooseRail,
  dayStartUtc,
  defaultCategory,
  itemsOf,
  localHour,
  monthStartUtc,
  paidHomeSince,
  payeeHistory,
  reserveBreached,
  zoneFor,
} from "./facts.ts";
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
};

export type ProposeOrderResult = {
  proposalId: string;
  decision: Decision;
  reasonCodes: ReasonCode[];
  riskScore: number;
  summary: string;
};

export const ORDER_TTL_MS = 10 * MINUTE_MS;

// ---------- executor (dependency injection; see orders/wiring.ts) ----------

export type ExecutionResult = { paymentId: string | null; status: PaymentStatus | null; reasonCodes: ReasonCode[] };
type Executor = (approvalId: string) => Promise<ExecutionResult>;
let executor: Executor | null = null;

export function registerExecutor(fn: Executor | null): void {
  executor = fn;
}

// ---------- helpers ----------

function newNonce(): string {
  return randomBytes(16).toString("base64url"); // 16 random bytes, base64url (spec §7)
}

function summarize(decision: Decision, codes: ReasonCode[], order: { amountMinor: number; currency: string; payeeName: string }, home?: { amountMinor: number; currency: string }): string {
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
  return `${verb[decision]}: ${money} to ${order.payeeName}. Reasons: ${codes.join(", ") || "none"}.`;
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
  await db
    .update(proposals)
    .set({ status: ok ? "EXECUTED" : "FAILED", updatedAt: clock.now() })
    .where(eq(proposals.id, proposalId));
  if (!ok) {
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

export async function proposeOrder(input: ProposeOrderInput): Promise<ProposeOrderResult> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new HttpProblem(400, "BAD_AMOUNT", "amountMinor must be a positive integer (minor units)");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new HttpProblem(400, "BAD_CURRENCY", "currency must be ISO 4217");
  const db = getDb();
  const now = clock.now();
  const { user, profile, caps } = await loadUser(db, input.userId);
  const effective = effectiveOf(user);
  const payee = (await db.select().from(payees).where(and(eq(payees.id, input.payeeId), eq(payees.userId, input.userId))))[0] ?? null;
  const category = input.category ?? (payee ? defaultCategory(payee.kind) : "other");
  const rail = chooseRail(input.rail, effective.moneyMode, user.region, payee?.kind ?? "PERSON");
  const home = await toHome(input.amountMinor, input.currency, user.homeCurrency, now);

  const screening = rail === "BANK_TRANSFER" && payee ? screenName(payee.name) : { hit: false as const, score: 0 };
  const [usedToday, usedMonth, reserve, mandate, history, remaining] = await Promise.all([
    paidHomeSince(db, user.id, dayStartUtc(now)),
    paidHomeSince(db, user.id, monthStartUtc(now)),
    reserveBreached(user.id, user.homeCurrency, caps.reserveMinor, home.amountMinor, now),
    payee
      ? findMatchingMandate(db, { userId: user.id, payeeId: payee.id, category, currency: input.currency, amountMinor: input.amountMinor, now })
      : Promise.resolve({ match: null, outOfScope: false }),
    payee ? payeeHistory(db, user.id, payee.id) : Promise.resolve({ count: 0, priceHistory: {}, qtyHistory: {} }),
    categoryRemaining(db, user.id, category, now),
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

  const result: DecideResult = decide({
    now,
    frozen: user.frozenAt !== null,
    payee: payee ? { status: payee.status, coolingUntil: payee.coolingUntil } : null,
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
    },
    preset: user.preset,
    effective,
    region: user.region,
    mandate: mandate.match ? { id: mandate.match.id } : null,
    mandateOutOfScope: mandate.outOfScope,
    riskScore: score,
    agentRequestedConfirm: input.agentRequestedConfirm === true,
    triggerOrigin,
    smallAutoLimitHomeMinor: caps.smallAutoMinor,
    baseRulesSigned: profile.baseRulesAssertion !== null && profile.baseRulesHash !== null,
  });

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
  };
  let order: CanonicalOrder | null = null;
  let hash: string | null = null;
  if (result.decision !== "REFUSE" && payee) {
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
    };
    hash = computeOrderHash(order);
  }

  let approvalId: string | null = null;
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
        screening: screening.hit ? { hit: true, entryId: screening.entryId, score: screening.score } : undefined,
      },
      tx,
    );
    if (result.decision === "AUTO" && order && hash) {
      approvalId = await issueApproval(tx, { proposalId, orderHash: hash, tier: "T1", userAssertion: null, mandateId: result.mandateId });
      await ledger.append("APPROVAL_ISSUED", { userId: user.id, proposalId, approvalId, tier: "T1", mandateId: result.mandateId, orderHash: hash }, tx);
    }
  });

  if (result.decision === "ASK" || result.decision === "HANDOFF") {
    await notify(user.id, {
      kind: "ORDER_NEEDS_APPROVAL",
      title: "Review and sign",
      body: summarize(result.decision, result.reasonCodes, { amountMinor: input.amountMinor, currency: input.currency, payeeName: payee?.name ?? "payee" }),
      data: { proposalId, decision: result.decision, reasonCodes: result.reasonCodes },
    });
  }

  let reasonCodes = result.reasonCodes;
  const decision = result.decision;
  if (approvalId) {
    const exec = await runExecutor(proposalId, user.id, approvalId);
    if (exec.status === "FAILED" || exec.status === "CANCELED") {
      reasonCodes = [...reasonCodes, ...exec.reasonCodes];
    }
  }
  if (decision === "REFUSE") {
    await notify(user.id, {
      kind: "ORDER_REFUSED",
      title: "Payment refused",
      body: summarize(decision, reasonCodes, { amountMinor: input.amountMinor, currency: input.currency, payeeName: payee?.name ?? "unknown payee" }),
      data: { proposalId, reasonCodes },
    });
  }
  return {
    proposalId,
    decision,
    reasonCodes,
    riskScore: score,
    summary: summarize(decision, reasonCodes, { amountMinor: input.amountMinor, currency: input.currency, payeeName: payee?.name ?? "unknown payee" }, { amountMinor: home.amountMinor, currency: user.homeCurrency }),
  };
}

// ---------- order view / approve / reject (T2) ----------

async function loadOwnProposal(db: DbOrTx, userId: string, proposalId: string) {
  const p = (await db.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.userId, userId))))[0];
  if (!p) throw notFound("order");
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
  const p = await refreshIfExpired(db, await loadOwnProposal(db, userId, proposalId));
  if (!p.canonicalOrder || !p.orderHash) {
    throw new HttpProblem(409, p.reasonCodes[0] ?? "REFUSED", "This order was refused and has nothing to sign", { reasonCodes: p.reasonCodes });
  }
  const payee = (await db.select().from(payees).where(eq(payees.id, p.canonicalOrder.payeeId)))[0];
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
    payeeStatus: payee?.status ?? "BLOCKED",
    decision: p.decision,
    reasonCodes: p.reasonCodes,
    status: p.status,
  };
}

export type ApproveResult = {
  approvalId: string;
  tier: "T1" | "T2";
  paymentId: string | null;
  paymentStatus: PaymentStatus | null;
  reasonCodes: ReasonCode[];
};

/** POST /orders/:id/approve — rules verification (spec §7) then signed approval → executor. */
export async function approveOrder(userId: string, proposalId: string, assertion: unknown): Promise<ApproveResult> {
  const db = getDb();
  const p = await loadOwnProposal(db, userId, proposalId);
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
    throw new HttpProblem(410, "ORDER_EXPIRED", "Order expired; reopen it to get a fresh one", { reasonCodes: ["ORDER_EXPIRED"] });
  }
  // Payee state may have changed since the draft (blocked, or replaced): re-check.
  const payee = (await db.select().from(payees).where(eq(payees.id, p.canonicalOrder.payeeId)))[0];
  if (!payee || payee.status === "BLOCKED" || payee.accountHash !== p.canonicalOrder.payeeAccountHash) {
    throw new HttpProblem(409, "REFUSE_UNVERIFIED_PAYEE", "Payee changed or blocked", { reasonCodes: ["REFUSE_UNVERIFIED_PAYEE"] });
  }
  if (payee.status === "COOLING" && (!payee.coolingUntil || payee.coolingUntil.getTime() > clock.nowMs())) {
    throw new HttpProblem(409, "REFUSE_UNVERIFIED_PAYEE", "Payee is still cooling", { reasonCodes: ["REFUSE_UNVERIFIED_PAYEE", "PAYEE_COOLING"] });
  }

  const check = await verifyRulesAssertion(db, { userId, assertion, expectedChallenge: p.orderHash, challengeReason: "ORDER_HASH_MISMATCH" });
  if (!check.ok) {
    await ledger.append("APPROVAL_DENIED", { userId, proposalId, reasonCodes: [check.reason], detail: check.detail });
    throw new HttpProblem(403, check.reason, check.detail, { reasonCodes: [check.reason] });
  }

  let approvalId = "";
  await db.transaction(async (tx) => {
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

  const exec = await runExecutor(proposalId, userId, approvalId);
  return { approvalId, tier: "T2", paymentId: exec.paymentId, paymentStatus: exec.status, reasonCodes: exec.reasonCodes };
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
    await ledger.append("ORDER_REJECTED", { userId, proposalId, reason: reason ?? null, reasonCodes: ["USER_REJECTED"] }, tx);
  });
}

export { decide } from "./decide.ts";
export { riskFeatures, riskScore } from "./risk.ts";
export { RISK_WEIGHTS, SMART_RISK_THRESHOLD } from "./riskWeights.ts";
