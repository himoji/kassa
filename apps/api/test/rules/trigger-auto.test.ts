import { describe, expect, it } from "vitest";

import { decide, type DecideFacts } from "../../src/modules/rules/decide.ts";

const NOW = new Date("2026-10-27T09:00:00.000Z");

/** A small, otherwise auto-eligible order: SMART, verified payee, capped wallet, signed base rules, under the small limit. */
function base(): DecideFacts {
  return {
    now: NOW,
    frozen: false,
    payee: { status: "VERIFIED", coolingUntil: null, hasAccount: true },
    readerChecks: undefined,
    rail: "CARD_ISSUING",
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

describe("decide: trigger-originated drafts never reach AUTO through the small-auto limit (rule 9)", () => {
  it("(a) trigger origin, under the small auto limit, no mandate: ASK with TRIGGER_ORIGIN and TRIGGER_NEEDS_MANDATE", () => {
    const r = decide({ ...base(), triggerOrigin: true });
    expect(r.decision).toBe("ASK");
    expect(r.reasonCodes).toContain("TRIGGER_ORIGIN");
    expect(r.reasonCodes).toContain("TRIGGER_NEEDS_MANDATE");
    expect(r.reasonCodes).not.toContain("SMALL_AUTO");
    expect(r.tier).toBe("T2");
    expect(r.mandateId).toBeNull();
  });

  it("(b) the same draft created by the user is still AUTO via SMALL_AUTO (unchanged)", () => {
    const r = decide({ ...base(), triggerOrigin: false });
    expect(r.decision).toBe("AUTO");
    expect(r.reasonCodes).toEqual(["SMALL_AUTO"]);
    expect(r.tier).toBe("T1");
    expect(r.mandateId).toBeNull();
  });

  it("(c) trigger-origin draft inside an active mandate, preset not ASK_ME: AUTO via the mandate (unchanged)", () => {
    const r = decide({ ...base(), triggerOrigin: true, mandate: { id: "mandate-restock" } });
    expect(r.decision).toBe("AUTO");
    expect(r.reasonCodes).toEqual(["MANDATE_MATCH"]);
    expect(r.tier).toBe("T1");
    expect(r.mandateId).toBe("mandate-restock");
  });
});
