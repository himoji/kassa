import { describe, expect, it } from "vitest";

import { decide, type DecideFacts } from "../../src/modules/rules/decide.ts";

const NOW = new Date("2026-10-27T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function base(): DecideFacts {
  return {
    now: NOW,
    frozen: false,
    payee: { status: "VERIFIED", coolingUntil: null, hasAccount: true },
    readerChecks: undefined,
    rail: "BANK_TRANSFER",
    screeningHit: false,
    caps: {
      amountHomeMinor: 500_000,
      perPaymentHomeMinor: 150_000_000,
      dailyHomeMinor: 200_000_000,
      monthlyHomeMinor: 300_000_000,
      usedTodayHomeMinor: 0,
      usedThisMonthHomeMinor: 0,
      reserveBreached: false,
    },
    preset: "SMART",
    effective: { agentAutonomy: "PLAN_AHEAD", paymentPolicy: "RISK_BASED", moneyMode: "CAPPED_WALLET" },
    region: "EU",
    mandate: null,
    mandateOutOfScope: false,
    riskScore: 0.1,
    agentRequestedConfirm: false,
    triggerOrigin: false,
    smallAutoLimitHomeMinor: 1_000_000,
    baseRulesSigned: true,
  };
}

describe("decide: happy path", () => {
  it("base facts yield AUTO via the small-auto step (9)", () => {
    const r = decide(base());
    expect(r.decision).toBe("AUTO");
    expect(r.reasonCodes).toEqual(["SMALL_AUTO"]);
    expect(r.tier).toBe("T1");
    expect(r.mandateId).toBeNull();
  });
});

describe("decide: step 1 frozen", () => {
  it("frozen refuses with REFUSE_FROZEN", () => {
    const r = decide({ ...base(), frozen: true });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_FROZEN");
  });

  it("frozen wins even when the payee is null", () => {
    const r = decide({ ...base(), frozen: true, payee: null });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_FROZEN");
    expect(r.reasonCodes).not.toContain("REFUSE_UNVERIFIED_PAYEE");
  });
});

describe("decide: step 2 payee", () => {
  it("null payee refuses as unverified", () => {
    const r = decide({ ...base(), payee: null });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_UNVERIFIED_PAYEE");
  });

  it("BLOCKED payee refuses as unverified", () => {
    const r = decide({ ...base(), payee: { status: "BLOCKED", coolingUntil: null, hasAccount: true } });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_UNVERIFIED_PAYEE");
  });

  it("COOLING payee still inside its cooling window refuses with PAYEE_COOLING", () => {
    const r = decide({ ...base(), payee: { status: "COOLING", coolingUntil: new Date(NOW.getTime() + HOUR), hasAccount: true } });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_UNVERIFIED_PAYEE");
    expect(r.reasonCodes).toContain("PAYEE_COOLING");
  });

  it("COOLING payee with coolingUntil null refuses", () => {
    const r = decide({ ...base(), payee: { status: "COOLING", coolingUntil: null, hasAccount: true } });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_UNVERIFIED_PAYEE");
  });

  it("payee without account details refuses with PAYEE_ACCOUNT_MISSING, whatever its status", () => {
    for (const payee of [
      { status: "COOLING" as const, coolingUntil: null, hasAccount: false },
      { status: "COOLING" as const, coolingUntil: new Date(NOW.getTime() - HOUR), hasAccount: false },
      { status: "VERIFIED" as const, coolingUntil: null, hasAccount: false },
    ]) {
      const r = decide({ ...base(), payee, mandate: { id: "m1" }, preset: "AUTOPILOT" });
      expect(r.decision).toBe("REFUSE");
      expect(r.reasonCodes).toEqual(["REFUSE_UNVERIFIED_PAYEE", "PAYEE_ACCOUNT_MISSING"]);
    }
  });

  it("COOLING payee after coolingUntil is usable but forces ASK with PAYEE_COOLING", () => {
    const r = decide({ ...base(), payee: { status: "COOLING", coolingUntil: new Date(NOW.getTime() - HOUR), hasAccount: true } });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("PAYEE_COOLING");
    expect(r.tier).toBe("T2");
  });

  it("COOLING payee after coolingUntil stays ASK even with a matching mandate", () => {
    const r = decide({
      ...base(),
      payee: { status: "COOLING", coolingUntil: new Date(NOW.getTime() - HOUR), hasAccount: true },
      mandate: { id: "m1" },
    });
    expect(r.decision).toBe("ASK");
    expect(r.decision).not.toBe("AUTO");
    expect(r.reasonCodes).toContain("PAYEE_COOLING");
  });
});

describe("decide: step 3 reader mismatch", () => {
  it("amount UNVERIFIED refuses with source mismatch", () => {
    const r = decide({ ...base(), readerChecks: { amount: "UNVERIFIED" } });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_SOURCE_MISMATCH");
    expect(r.reasonCodes).toContain("READER_SOURCE_MISMATCH");
  });

  it("account UNVERIFIED refuses with source mismatch", () => {
    const r = decide({ ...base(), readerChecks: { account: "UNVERIFIED" } });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_SOURCE_MISMATCH");
    expect(r.reasonCodes).toContain("READER_SOURCE_MISMATCH");
  });
});

describe("decide: step 4 sanctions screening", () => {
  it("screening hit on a bank transfer refuses", () => {
    const r = decide({ ...base(), screeningHit: true, rail: "BANK_TRANSFER" });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_SANCTIONS");
  });

  // X4 (security review F6, p3 B1): screening applies to every rail, not only bank transfers.
  it.each(["CARD_ISSUING", "HANDOFF", "PAY_IN_PLACE"] as const)("screening hit on %s refuses too", (rail) => {
    const r = decide({ ...base(), screeningHit: true, rail });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toEqual(["REFUSE_SANCTIONS"]);
  });
});

describe("decide: step 5 caps and reserve", () => {
  it("per-payment breach within 2x asks under SMART", () => {
    const r = decide({ ...base(), caps: { ...base().caps, amountHomeMinor: 200_000_000 } });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("CAP_WITHIN_2X_ASK");
  });

  it("per-payment breach beyond 2x refuses under SMART", () => {
    const r = decide({ ...base(), caps: { ...base().caps, amountHomeMinor: 400_000_000 } });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_CAP");
  });

  it("per-payment breach refuses under ASK_ME even within 2x", () => {
    const r = decide({
      ...base(),
      preset: "ASK_ME",
      caps: { ...base().caps, amountHomeMinor: 200_000_000 },
    });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_CAP");
  });

  it("daily breach within 2x asks under SMART", () => {
    const r = decide({
      ...base(),
      caps: { ...base().caps, usedTodayHomeMinor: 199_900_000, amountHomeMinor: 500_000 },
    });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("CAP_WITHIN_2X_ASK");
  });

  it("monthly breach within 2x asks under SMART", () => {
    const r = decide({
      ...base(),
      caps: { ...base().caps, usedThisMonthHomeMinor: 299_900_000, amountHomeMinor: 500_000 },
    });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("CAP_WITHIN_2X_ASK");
  });

  it("reserve breached refuses even under SMART", () => {
    const r = decide({ ...base(), caps: { ...base().caps, reserveBreached: true } });
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_CAP");
  });

  it("unknown reserve (null) does not refuse", () => {
    const r = decide({ ...base(), caps: { ...base().caps, reserveBreached: null } });
    expect(r.decision).toBe("AUTO");
    expect(r.reasonCodes).not.toContain("REFUSE_CAP");
  });
});

describe("decide: step 6 handoff", () => {
  it("region CN hands off", () => {
    const r = decide({ ...base(), region: "CN" });
    expect(r.decision).toBe("HANDOFF");
    expect(r.reasonCodes).toContain("HANDOFF_REGION");
    expect(r.tier).toBe("T2");
  });

  it("money mode HANDOFF hands off", () => {
    const r = decide({
      ...base(),
      effective: { agentAutonomy: "PLAN_AHEAD", paymentPolicy: "RISK_BASED", moneyMode: "HANDOFF" },
    });
    expect(r.decision).toBe("HANDOFF");
    expect(r.reasonCodes).toContain("HANDOFF_MODE");
  });
});

describe("decide: step 7 mandates", () => {
  it("matching mandate under SMART is AUTO T1 with the mandate id", () => {
    const r = decide({ ...base(), mandate: { id: "m1" } });
    expect(r.decision).toBe("AUTO");
    expect(r.reasonCodes).toEqual(["MANDATE_MATCH"]);
    expect(r.tier).toBe("T1");
    expect(r.mandateId).toBe("m1");
  });

  it("matching mandate under ASK_ME asks with PRESET_ASK_ME", () => {
    const r = decide({
      ...base(),
      preset: "ASK_ME",
      effective: { agentAutonomy: "ON_REQUEST", paymentPolicy: "ALWAYS_ASK", moneyMode: "PAY_IN_PLACE" },
      mandate: { id: "m1" },
    });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("PRESET_ASK_ME");
  });

  it("matching mandate with agentRequestedConfirm asks and is never AUTO", () => {
    const r = decide({ ...base(), mandate: { id: "m1" }, agentRequestedConfirm: true });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("AGENT_REQUESTED_CONFIRM");
    expect(r.decision).not.toBe("AUTO");
  });
});

describe("decide: step 8 asks", () => {
  it("ASK_ME with no mandate asks with PRESET_ASK_ME", () => {
    const r = decide({
      ...base(),
      preset: "ASK_ME",
      effective: { agentAutonomy: "ON_REQUEST", paymentPolicy: "ALWAYS_ASK", moneyMode: "PAY_IN_PLACE" },
    });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("PRESET_ASK_ME");
    expect(r.tier).toBe("T2");
  });

  it("AUTOPILOT with NEVER_ASK and no mandate asks with AUTO_NOT_ELIGIBLE", () => {
    const r = decide({
      ...base(),
      preset: "AUTOPILOT",
      effective: { agentAutonomy: "PLAN_AND_ACT", paymentPolicy: "NEVER_ASK", moneyMode: "CAPPED_WALLET" },
    });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("AUTO_NOT_ELIGIBLE");
  });

  it("AUTOPILOT with NEVER_ASK and mandate out of scope asks with MANDATE_OUT_OF_SCOPE", () => {
    const r = decide({
      ...base(),
      preset: "AUTOPILOT",
      effective: { agentAutonomy: "PLAN_AND_ACT", paymentPolicy: "NEVER_ASK", moneyMode: "CAPPED_WALLET" },
      mandateOutOfScope: true,
    });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("MANDATE_OUT_OF_SCOPE");
  });

  it("SMART at risk 0.5 asks with RISK_HIGH", () => {
    const r = decide({ ...base(), riskScore: 0.5 });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("RISK_HIGH");
  });

  it("SMART at risk 0.49 is AUTO", () => {
    const r = decide({ ...base(), riskScore: 0.49 });
    expect(r.decision).toBe("AUTO");
  });

  it("agentRequestedConfirm without mandate asks", () => {
    const r = decide({ ...base(), agentRequestedConfirm: true });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("AGENT_REQUESTED_CONFIRM");
  });
});

describe("decide: step 9 small auto", () => {
  it("amount above the small auto limit asks", () => {
    const r = decide({ ...base(), caps: { ...base().caps, amountHomeMinor: 1_000_001 } });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("ABOVE_SMALL_AUTO_LIMIT");
  });

  it("amount exactly at the small auto limit is AUTO", () => {
    const r = decide({ ...base(), caps: { ...base().caps, amountHomeMinor: 1_000_000 } });
    expect(r.decision).toBe("AUTO");
    expect(r.reasonCodes).toEqual(["SMALL_AUTO"]);
  });

  it("base rules not signed asks with AUTO_NOT_ELIGIBLE", () => {
    const r = decide({ ...base(), baseRulesSigned: false });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("AUTO_NOT_ELIGIBLE");
  });

  it("money mode PAY_IN_PLACE asks with AUTO_NOT_ELIGIBLE", () => {
    const r = decide({
      ...base(),
      effective: { agentAutonomy: "PLAN_AHEAD", paymentPolicy: "RISK_BASED", moneyMode: "PAY_IN_PLACE" },
    });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("AUTO_NOT_ELIGIBLE");
  });

  it("PAY_IN_PLACE rail under a capped wallet asks with AUTO_NOT_ELIGIBLE", () => {
    const r = decide({ ...base(), rail: "PAY_IN_PLACE" });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("AUTO_NOT_ELIGIBLE");
  });
});

describe("decide: informational flags", () => {
  it("triggerOrigin with high risk asks and carries TRIGGER_ORIGIN", () => {
    const r = decide({ ...base(), triggerOrigin: true, riskScore: 0.6 });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("TRIGGER_ORIGIN");
  });

  it("unverified non-critical reader field adds READER_FIELD_UNVERIFIED", () => {
    const r = decide({ ...base(), readerChecks: { nonCriticalUnverified: true }, riskScore: 0.6 });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("READER_FIELD_UNVERIFIED");
  });
});

describe("decide: invariant", () => {
  it("agentRequestedConfirm is never AUTO across fact variants", () => {
    const presets = ["ASK_ME", "SMART", "AUTOPILOT"] as const;
    const payees = [{ status: "VERIFIED", coolingUntil: null }, { status: "COOLING", coolingUntil: new Date(NOW.getTime() - HOUR) }] as const;
    const mandates = [null, { id: "m1" }] as const;
    const amounts = [1, 500_000, 1_000_000];
    for (const preset of presets) {
      for (const payee of payees) {
        for (const mandate of mandates) {
          for (const amountHomeMinor of amounts) {
            const r = decide({
              ...base(),
              preset,
              payee: { status: payee.status, coolingUntil: payee.coolingUntil, hasAccount: true },
              mandate: mandate ? { id: mandate.id } : null,
              caps: { ...base().caps, amountHomeMinor },
              agentRequestedConfirm: true,
            });
            expect(r.decision, JSON.stringify({ preset, payee, mandate, amountHomeMinor })).not.toBe("AUTO");
          }
        }
      }
    }
  });
});

describe("decide: step 1b duplicate obligation period (B4)", () => {
  it("refuses with DUPLICATE_OBLIGATION_PAYMENT, even inside a mandate", () => {
    const r = decide({ ...base(), duplicateObligation: true, mandate: { id: "m" } });
    expect(r).toMatchObject({ decision: "REFUSE", reasonCodes: ["DUPLICATE_OBLIGATION_PAYMENT"] });
  });

  it("frozen still wins over a duplicate", () => {
    expect(decide({ ...base(), frozen: true, duplicateObligation: true }).reasonCodes).toEqual(["REFUSE_FROZEN"]);
  });
});

describe("decide: step 4b funding (B2)", () => {
  it("bank transfer with no covering funding route → INSUFFICIENT_FUNDS before caps and mandate", () => {
    const r = decide({ ...base(), fundingAvailable: false, mandate: { id: "m" }, caps: { ...base().caps, amountHomeMinor: 999_000_000 } });
    expect(r).toMatchObject({ decision: "REFUSE", reasonCodes: ["INSUFFICIENT_FUNDS"] });
  });

  it("reader mismatch (step 3) and screening (step 4) come first", () => {
    expect(decide({ ...base(), fundingAvailable: false, readerChecks: { amount: "UNVERIFIED" } }).reasonCodes).toContain("REFUSE_SOURCE_MISMATCH");
    expect(decide({ ...base(), fundingAvailable: false, screeningHit: true }).reasonCodes).toEqual(["REFUSE_SANCTIONS"]);
  });

  it("unknown funding (null) and non-bank rails are not refused for funds", () => {
    expect(decide({ ...base(), fundingAvailable: null }).decision).toBe("AUTO");
    expect(decide({ ...base(), rail: "CARD_ISSUING", fundingAvailable: false }).decision).toBe("AUTO");
  });
});

describe("decide: Phase 2 fix pass (X1, X2, X3)", () => {
  it("X1: a mandate payee outside the mandate's scope never auto-pays, not even below the small-auto limit", () => {
    const r = decide({ ...base(), mandateScopeMismatch: true });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("MANDATE_SCOPE_MISMATCH");
    const o = decide({ ...base(), mandateOutOfScope: true });
    expect(o.decision).toBe("ASK");
    expect(o.reasonCodes).toContain("MANDATE_OUT_OF_SCOPE");
  });

  it("X2: over payments' own daily cap → REFUSE_CAP + PAYMENTS_DAILY_CAP, also where SMART would ask within 2×", () => {
    const within2x = { ...base().caps, amountHomeMinor: 50_000_000, usedTodayHomeMinor: 180_000_000, paymentsDailyHomeMinor: 200_000_000 };
    expect(decide({ ...base(), caps: within2x })).toMatchObject({ decision: "REFUSE", reasonCodes: ["REFUSE_CAP", "PAYMENTS_DAILY_CAP"] });
    const underRulesCaps = { ...base().caps, amountHomeMinor: 500_000, usedTodayHomeMinor: 0, dailyHomeMinor: 900_000_000, paymentsDailyHomeMinor: 400_000 };
    expect(decide({ ...base(), caps: underRulesCaps }).reasonCodes).toEqual(["REFUSE_CAP", "PAYMENTS_DAILY_CAP"]);
    expect(decide({ ...base(), caps: { ...base().caps, paymentsDailyHomeMinor: 200_000_000 } }).decision).toBe("AUTO");
  });

  it("X3: small-auto beyond the per-day budget (count or amount) → ASK SMALL_AUTO_BUDGET_EXHAUSTED", () => {
    const budget = { usedCount: 2, usedHomeMinor: 1_000_000, maxCount: 3, maxHomeMinor: 3_000_000 };
    expect(decide({ ...base(), smallAutoBudget: budget }).decision).toBe("AUTO");
    expect(decide({ ...base(), smallAutoBudget: { ...budget, usedCount: 3 } }).reasonCodes).toContain("SMALL_AUTO_BUDGET_EXHAUSTED");
    expect(decide({ ...base(), smallAutoBudget: { ...budget, usedHomeMinor: 2_600_000 } }).reasonCodes).toContain("SMALL_AUTO_BUDGET_EXHAUSTED");
  });
});
