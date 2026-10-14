/*
 * Spec §10 evaluation order, first match wins. Pure: every fact is gathered beforehand (rules/facts.ts),
 * so each step is unit-testable.
 *
 *  1 frozen → REFUSE_FROZEN
 *  1b (added, B4) the obligation period already has a pending or paid proposal → DUPLICATE_OBLIGATION_PAYMENT
 *  2 payee missing / BLOCKED / COOLING before coolingUntil → REFUSE_UNVERIFIED_PAYEE
 *    (added 2026-10-13) payee without account details → REFUSE_UNVERIFIED_PAYEE + PAYEE_ACCOUNT_MISSING
 *    (COOLING after coolingUntil is usable in T2 only → forces ASK with PAYEE_COOLING)
 *  3 reader mismatch on amount or account → REFUSE_SOURCE_MISMATCH
 *  4 screening hit (X4: every rail, not only bank transfers) → REFUSE_SANCTIONS
 *  4b (added, B2) bank transfer with no funding route that covers it (spec §12) → INSUFFICIENT_FUNDS
 *  5 caps / protected reserve → REFUSE_CAP under every preset (no "within 2×" ask since 2026-10-14); (X2) the payments module's
 *    own daily cap on today's home-currency usage → REFUSE_CAP + PAYMENTS_DAILY_CAP (hard, payments would refuse)
 *  6 region CN or money mode HANDOFF → HANDOFF
 *  7 matching active mandate and preset ≠ ASK_ME → AUTO (T1); the draft must be linked server-side to a bill in
 *    the mandate's scope (X1, mandates/scope.ts)
 *  8 ASK_ME always asks; AUTOPILOT without mandate asks; SMART asks at risk ≥ 0.5 → ASK (T2);
 *    (X1) a payee covered by a mandate is never paid automatically outside that mandate (MANDATE_SCOPE_MISMATCH /
 *    MANDATE_OUT_OF_SCOPE force ASK, also below the small-auto limit)
 *  9 otherwise AUTO — only SMART, verified payee, ≤ small auto limit, capped wallet, (X3) inside the per-day
 *    small-auto budget (count + amount, else ASK SMALL_AUTO_BUDGET_EXHAUSTED);
 *    trigger/scheduler drafts never (ASK + TRIGGER_NEEDS_MANDATE); they need a mandate (step 7)
 *
 * The agent's uncertainty (agentRequestedConfirm) can force ASK, never AUTO.
 */
import type { Decision, EffectiveSettings, PayeeStatus, Preset, Rail, ReasonCode, Region, Tier } from "@kassa/shared";

import { SMART_RISK_THRESHOLD } from "./riskWeights.ts";

export type CapCheck = {
  /** Order amount in home minor units. */
  amountHomeMinor: number;
  perPaymentHomeMinor: number;
  dailyHomeMinor: number;
  monthlyHomeMinor: number;
  usedTodayHomeMinor: number;
  usedThisMonthHomeMinor: number;
  /** Balance after the payment would fall below the protected reserve (null = balance unknown). */
  reserveBreached: boolean | null;
  /**
   * (X2) The payments module's own daily cap (PAYMENTS_DAILY_CAP_HOME_MINOR, I5), pre-checked against today's usage
   * in the home currency so the user is refused before signing instead of after. Undefined = not checked.
   */
  paymentsDailyHomeMinor?: number;
};

export type DecideFacts = {
  now: Date;
  frozen: boolean;
  /** hasAccount false = no account details yet (payee captured in onboarding): refused whatever its status. */
  payee: { status: PayeeStatus; coolingUntil: Date | null; hasAccount: boolean } | null;
  readerChecks?: { amount?: "VERIFIED" | "UNVERIFIED"; account?: "VERIFIED" | "UNVERIFIED"; nonCriticalUnverified?: boolean };
  rail: Rail;
  screeningHit: boolean;
  caps: CapCheck;
  preset: Preset;
  effective: EffectiveSettings;
  region: Region;
  /** An active, effective, signed mandate whose scope covers this order. */
  mandate: { id: string } | null;
  /** Mandates exist for this payee but the order is outside their scope. */
  mandateOutOfScope: boolean;
  /** (X1) A mandate covers this payee but the draft is not linked to a bill in its scope (payee, category, amount, period). */
  mandateScopeMismatch?: boolean;
  riskScore: number;
  agentRequestedConfirm: boolean;
  triggerOrigin: boolean;
  smallAutoLimitHomeMinor: number;
  /** (X3) Per-day small-auto budget: today's small-auto usage and the limits (count, home amount). Undefined = none. */
  smallAutoBudget?: { usedCount: number; usedHomeMinor: number; maxCount: number; maxHomeMinor: number };
  /** Base rules (incl. the small auto limit) were passkey-signed — payments needs this for T1 without a mandate. */
  baseRulesSigned: boolean;
  /** (added, B4) a proposal for the same obligation period is pending approval or paid. */
  duplicateObligation?: boolean;
  /** (added, B2) bank transfers: false = no funding currency × rail covers the order incl. fees by the due date. */
  fundingAvailable?: boolean | null;
};

export type DecideResult = {
  decision: Decision;
  reasonCodes: ReasonCode[];
  tier: Tier | null;
  mandateId: string | null;
};

const refuse = (...codes: ReasonCode[]): DecideResult => ({ decision: "REFUSE", reasonCodes: codes, tier: null, mandateId: null });

export function decide(f: DecideFacts): DecideResult {
  // 1
  if (f.frozen) return refuse("REFUSE_FROZEN");
  // 1b
  if (f.duplicateObligation) return refuse("DUPLICATE_OBLIGATION_PAYMENT");

  // 2
  let coolingAsk = false;
  if (!f.payee || f.payee.status === "BLOCKED") return refuse("REFUSE_UNVERIFIED_PAYEE");
  if (!f.payee.hasAccount) return refuse("REFUSE_UNVERIFIED_PAYEE", "PAYEE_ACCOUNT_MISSING");
  if (f.payee.status === "COOLING") {
    if (!f.payee.coolingUntil || f.now.getTime() < f.payee.coolingUntil.getTime()) {
      return refuse("REFUSE_UNVERIFIED_PAYEE", "PAYEE_COOLING");
    }
    coolingAsk = true;
  }

  // 3
  if (f.readerChecks?.amount === "UNVERIFIED" || f.readerChecks?.account === "UNVERIFIED") {
    return refuse("REFUSE_SOURCE_MISMATCH", "READER_SOURCE_MISMATCH");
  }

  // 4
  // (X4) every rail: card, handoff and pay-in-place payees are screened like bank transfers.
  if (f.screeningHit) return refuse("REFUSE_SANCTIONS");
  // 4b
  if (f.rail === "BANK_TRANSFER" && f.fundingAvailable === false) return refuse("INSUFFICIENT_FUNDS");

  // 5
  const c = f.caps;
  const breaches: { total: number; cap: number }[] = [];
  if (c.amountHomeMinor > c.perPaymentHomeMinor) breaches.push({ total: c.amountHomeMinor, cap: c.perPaymentHomeMinor });
  if (c.usedTodayHomeMinor + c.amountHomeMinor > c.dailyHomeMinor) {
    breaches.push({ total: c.usedTodayHomeMinor + c.amountHomeMinor, cap: c.dailyHomeMinor });
  }
  if (c.usedThisMonthHomeMinor + c.amountHomeMinor > c.monthlyHomeMinor) {
    breaches.push({ total: c.usedThisMonthHomeMinor + c.amountHomeMinor, cap: c.monthlyHomeMinor });
  }
  const capRefusal = (): DecideResult => (f.triggerOrigin ? refuse("REFUSE_CAP", "TRIGGER_ORIGIN") : refuse("REFUSE_CAP"));
  // (X2) payments would refuse this anyway (PAYMENTS_DAILY_CAP): refuse before signing, never "ASK within 2×" then
  // refused after the passkey (p3 O1). Checked after the rules' own hard refusals so their codes stay unchanged.
  const paymentsCapHit = c.paymentsDailyHomeMinor !== undefined && c.usedTodayHomeMinor + c.amountHomeMinor > c.paymentsDailyHomeMinor;
  const paymentsCapRefusal = (): DecideResult =>
    f.triggerOrigin ? refuse("REFUSE_CAP", "PAYMENTS_DAILY_CAP", "TRIGGER_ORIGIN") : refuse("REFUSE_CAP", "PAYMENTS_DAILY_CAP");
  // A cap is a hard limit under every preset (T3): above it the order is refused, and the user raises the cap with a
  // passkey-signed settings change instead. (Until 2026-10-14 SMART asked within 2× the cap; SECURITY.md §2 T3.)
  if (breaches.length > 0 || c.reserveBreached === true) {
    // A7 (spec §19): a trigger-originated draft over the caps is refused WITH the anomaly flag.
    return capRefusal();
  }
  if (paymentsCapHit) return paymentsCapRefusal();

  // 6
  if (f.region === "CN") return withFlags({ decision: "HANDOFF", reasonCodes: ["HANDOFF_REGION"], tier: "T2", mandateId: null }, f);
  if (f.effective.moneyMode === "HANDOFF") {
    return withFlags({ decision: "HANDOFF", reasonCodes: ["HANDOFF_MODE"], tier: "T2", mandateId: null }, f);
  }

  const alwaysAsk = f.preset === "ASK_ME" || f.effective.paymentPolicy === "ALWAYS_ASK";

  // 7
  if (f.mandate && !alwaysAsk) {
    if (f.agentRequestedConfirm) return ask(["MANDATE_MATCH", "AGENT_REQUESTED_CONFIRM"], f);
    if (coolingAsk) return ask(["PAYEE_COOLING"], f);
    return { decision: "AUTO", reasonCodes: ["MANDATE_MATCH"], tier: "T1", mandateId: f.mandate.id };
  }

  // 8
  const why: ReasonCode[] = [];
  if (alwaysAsk) why.push("PRESET_ASK_ME");
  if (coolingAsk) why.push("PAYEE_COOLING");
  if (f.agentRequestedConfirm) why.push("AGENT_REQUESTED_CONFIRM");
  // X1: a payee covered by a mandate is paid automatically only inside that mandate, never via the small-auto limit.
  if (f.mandateScopeMismatch) why.push("MANDATE_SCOPE_MISMATCH");
  if (f.mandateOutOfScope) why.push("MANDATE_OUT_OF_SCOPE");
  if (f.effective.paymentPolicy === "NEVER_ASK" || f.preset === "AUTOPILOT") {
    // Autopilot only acts inside a mandate (spec §10 step 8: "no mandate means ask").
    if (!f.mandateOutOfScope && !f.mandateScopeMismatch) why.push("AUTO_NOT_ELIGIBLE");
  } else if (f.riskScore >= SMART_RISK_THRESHOLD) {
    why.push("RISK_HIGH");
  }
  if (why.length > 0) return ask(why, f);

  // 9
  const smallAutoOk =
    f.preset === "SMART" &&
    f.effective.paymentPolicy === "RISK_BASED" &&
    f.payee.status === "VERIFIED" &&
    f.effective.moneyMode === "CAPPED_WALLET" &&
    (f.rail === "CARD_ISSUING" || f.rail === "BANK_TRANSFER") &&
    f.baseRulesSigned;
  if (!smallAutoOk) return ask(["AUTO_NOT_ELIGIBLE"], f);
  // (2026-10-12) trigger/scheduler drafts may be AUTO only inside a mandate (step 7), never via the small-auto limit
  if (f.triggerOrigin) return ask(["TRIGGER_NEEDS_MANDATE"], f);
  if (c.amountHomeMinor > f.smallAutoLimitHomeMinor) return ask(["ABOVE_SMALL_AUTO_LIMIT"], f);
  // (X3) per-day budget: a fooled planner cannot drain the day's cap through many small payments.
  const b = f.smallAutoBudget;
  if (b && (b.usedCount + 1 > b.maxCount || b.usedHomeMinor + c.amountHomeMinor > b.maxHomeMinor)) return ask(["SMALL_AUTO_BUDGET_EXHAUSTED"], f);
  return { decision: "AUTO", reasonCodes: ["SMALL_AUTO"], tier: "T1", mandateId: null };
}

function ask(codes: ReasonCode[], f: DecideFacts): DecideResult {
  return withFlags({ decision: "ASK", reasonCodes: codes, tier: "T2", mandateId: null }, f);
}

/** Informational flags appended to non-refusals (A7 "anomaly flag" for trigger-originated drafts). */
function withFlags(r: DecideResult, f: DecideFacts): DecideResult {
  const codes = [...r.reasonCodes];
  if (f.mandateOutOfScope && r.decision === "ASK" && !codes.includes("MANDATE_OUT_OF_SCOPE")) codes.push("MANDATE_OUT_OF_SCOPE");
  if (f.mandateScopeMismatch && r.decision === "ASK" && !codes.includes("MANDATE_SCOPE_MISMATCH")) codes.push("MANDATE_SCOPE_MISMATCH");
  if (f.triggerOrigin && !codes.includes("TRIGGER_ORIGIN")) codes.push("TRIGGER_ORIGIN");
  if (f.readerChecks?.nonCriticalUnverified && !codes.includes("READER_FIELD_UNVERIFIED")) codes.push("READER_FIELD_UNVERIFIED");
  return { ...r, reasonCodes: codes };
}
