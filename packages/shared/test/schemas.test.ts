import { describe, expect, it } from "vitest";

import {
  applySettingsPatch,
  effectiveSettings,
  ProposeOrderInput,
  ReasonCode,
  TOOL_INPUT_SCHEMAS,
  ToolName,
  UserSettings,
} from "../src/index.ts";

describe("tools", () => {
  it("defines exactly the 11 planner tools of spec §9", () => {
    expect([...ToolName.options].sort()).toEqual(
      [
        "forecast_coverage",
        "get_balances",
        "get_budget",
        "get_obligations",
        "get_payee_facts",
        "get_profile_summary",
        "get_routes",
        "log_expense",
        "propose_order",
        "read_document",
        "search_catalog",
      ].sort(),
    );
    expect(Object.keys(TOOL_INPUT_SCHEMAS)).toHaveLength(11);
  });

  it("propose_order requires integer minor units and caps purpose at 140", () => {
    const ok = { payeeRef: "payee_3", amountMinor: 240000, currency: "EUR", purpose: "Tuition" };
    expect(ProposeOrderInput.safeParse(ok).success).toBe(true);
    expect(ProposeOrderInput.safeParse({ ...ok, amountMinor: 2400.5 }).success).toBe(false);
    expect(ProposeOrderInput.safeParse({ ...ok, purpose: "x".repeat(141) }).success).toBe(false);
    expect(ProposeOrderInput.safeParse({ ...ok, currency: "eur" }).success).toBe(false);
  });
});

describe("reason codes", () => {
  it("includes every code named in the spec", () => {
    for (const c of [
      "REFUSE_FROZEN",
      "REFUSE_UNVERIFIED_PAYEE",
      "REFUSE_SOURCE_MISMATCH",
      "READER_SOURCE_MISMATCH",
      "REFUSE_SANCTIONS",
      "REFUSE_CAP",
      "QR_PAYEE_MISMATCH",
      "NO_APPROVAL",
      "NONCE_USED",
    ]) {
      expect(ReasonCode.options).toContain(c);
    }
  });
});

describe("settings presets (spec §10)", () => {
  const base: UserSettings = {
    preset: "SMART",
    region: "EU",
    homeCurrency: "KZT",
    notificationMode: "EACH",
    overrides: { agentAutonomy: null, paymentPolicy: null, moneyMode: null },
  };

  it("derives advanced switches from the preset", () => {
    expect(effectiveSettings("ASK_ME", base.overrides)).toEqual({
      agentAutonomy: "ON_REQUEST",
      paymentPolicy: "ALWAYS_ASK",
      moneyMode: "PAY_IN_PLACE",
    });
    expect(effectiveSettings("AUTOPILOT", base.overrides).paymentPolicy).toBe("NEVER_ASK");
  });

  it("rejects never-ask with HANDOFF or PAY_IN_PLACE", () => {
    for (const moneyMode of ["HANDOFF", "PAY_IN_PLACE"] as const) {
      expect(
        UserSettings.safeParse({ ...base, preset: "AUTOPILOT", overrides: { ...base.overrides, moneyMode } }).success,
      ).toBe(false);
      expect(
        UserSettings.safeParse({
          ...base,
          overrides: { ...base.overrides, paymentPolicy: "NEVER_ASK", moneyMode },
        }).success,
      ).toBe(false);
    }
    expect(UserSettings.safeParse({ ...base, preset: "AUTOPILOT" }).success).toBe(true);
  });

  it("validates a PATCH after merging with stored settings", () => {
    const autopilot = applySettingsPatch(base, { preset: "AUTOPILOT" });
    expect(autopilot.preset).toBe("AUTOPILOT");
    expect(() => applySettingsPatch(autopilot, { overrides: { moneyMode: "HANDOFF" } })).toThrow();
    expect(applySettingsPatch(autopilot, { preset: "SMART", overrides: { moneyMode: "HANDOFF" } }).overrides.moneyMode).toBe(
      "HANDOFF",
    );
  });
});
