/*
 * The evidence generator's outcome classification (test/helpers/attacks.ts): REFUSED / ASKED / PAID per case, the
 * cooling note, the worst outcome per attack and the summary counts. An ASK is a passkey prompt, never a refusal.
 */
import { describe, expect, it } from "vitest";

import { classifyGuarded, summarize, worstOutcome, type AttackEntry, type GuardedCase } from "../helpers/attacks.ts";

const ask = { paysAttacker: true, note: "approving pays the attacker" };

describe("evidence outcome classification", () => {
  it("REFUSE and 'no proposal' are REFUSED", () => {
    expect(classifyGuarded({ case: "r", decision: "REFUSE", reasonCodes: ["REFUSE_CAP"], ledger: ["PROPOSAL_CREATED"] }).outcome).toBe("REFUSED");
    expect(classifyGuarded({ case: "n", decision: null, reasonCodes: ["UNKNOWN_PAYEE_REF"], ledger: [] }).outcome).toBe("REFUSED");
  });

  it("ASK is ASKED, not refused, and must say who is paid if approved", () => {
    const c = classifyGuarded({ case: "a", decision: "ASK", reasonCodes: ["TRIGGER_ORIGIN"], ledger: ["PROPOSAL_CREATED"], ifApproved: ask });
    expect(c.outcome).toBe("ASKED");
    expect(c.ifApproved).toEqual(ask);
    expect(() => classifyGuarded({ case: "a", decision: "ASK", reasonCodes: [], ledger: ["PROPOSAL_CREATED"] })).toThrow(/ifApproved/);
  });

  it("PAYEE_COOLING: REFUSE = still in the 24 h cooling; ASK = cooled but never verified, an approval pays", () => {
    const inCooling = classifyGuarded({ case: "c", decision: "REFUSE", reasonCodes: ["REFUSE_UNVERIFIED_PAYEE", "PAYEE_COOLING"], ledger: ["PROPOSAL_CREATED"] });
    expect(inCooling).toMatchObject({ outcome: "REFUSED", payeeCooling: "IN_COOLING" });
    const cooled = classifyGuarded({ case: "c", decision: "ASK", reasonCodes: ["PAYEE_COOLING"], ledger: ["PROPOSAL_CREATED"], ifApproved: ask });
    expect(cooled).toMatchObject({ outcome: "ASKED", payeeCooling: "COOLED_UNVERIFIED" });
    expect(classifyGuarded({ case: "x", decision: "REFUSE", reasonCodes: ["REFUSE_CAP"], ledger: [] }).payeeCooling).toBeNull();
  });

  it("a refusal at approval or execution is REFUSED whatever the rules decided", () => {
    expect(classifyGuarded({ case: "t", decision: "ASK", reasonCodes: ["ORDER_HASH_MISMATCH"], ledger: ["APPROVAL_DENIED"] }).outcome).toBe("REFUSED");
    expect(classifyGuarded({ case: "m", decision: "AUTO", reasonCodes: ["BAD_SIGNATURE"], ledger: ["PROPOSAL_CREATED", "APPROVAL_ISSUED", "PAYMENT_REFUSED"] }).outcome).toBe("REFUSED");
    expect(classifyGuarded({ case: "q", decision: "HANDOFF", reasonCodes: ["QR_PAYEE_MISMATCH"], ledger: ["HANDOFF_MISMATCH"] }).outcome).toBe("REFUSED");
  });

  it("paid wins; an AUTO that neither paid nor was refused cannot be evidence", () => {
    const p = classifyGuarded({ case: "p", decision: "HANDOFF", reasonCodes: ["QR_PAYEE_MISMATCH"], ledger: ["HANDOFF_PAID_MISMATCH"], paid: true, ifApproved: ask });
    expect(p.outcome).toBe("PAID");
    expect(p).not.toHaveProperty("paid");
    expect(p).not.toHaveProperty("ifApproved");
    expect(() => classifyGuarded({ case: "x", decision: "AUTO", reasonCodes: [], ledger: ["PROPOSAL_CREATED"] })).toThrow(/AUTO/);
  });

  it("worst outcome and summary counts", () => {
    const refused = classifyGuarded({ case: "r", decision: "REFUSE", reasonCodes: [], ledger: [] });
    const askedAttacker = classifyGuarded({ case: "a", decision: "ASK", reasonCodes: ["PAYEE_COOLING"], ledger: [], ifApproved: ask });
    const askedVerified = classifyGuarded({ case: "v", decision: "ASK", reasonCodes: [], ledger: [], ifApproved: { paysAttacker: false, note: "overpays the verified supplier" } });
    expect(worstOutcome([])).toBe("REFUSED");
    expect(worstOutcome([refused, askedAttacker])).toBe("ASKED");

    const entry = (cases: GuardedCase[], tapPaid: boolean, toAttacker: boolean): AttackEntry => ({
      attack: "x",
      expected: "x",
      guarded: { paid: false, worst: "REFUSED", paysAttackerIfUserApproves: false, cases },
      tapConfirm: { outcome: tapPaid ? "PAID" : "REFUSED", paid: tapPaid, railCalls: 1, taps: 1, paidOnlyBecauseUserTapped: tapPaid, carefulUserPaid: false, toAttacker, detail: "", note: "" },
      naive: { outcome: "PAID", paid: true, railCalls: 1, detail: "" },
    });
    const attacks = { A1: entry([refused], true, true), A2: entry([refused, askedAttacker], true, true), A7: entry([askedVerified], true, false) };
    expect(summarize(attacks)).toEqual({
      total: 3,
      guardedRefused: 1,
      guardedAsked: 2,
      guardedPaid: 0,
      cases: { total: 4, refused: 2, asked: 2, paid: 0 },
      guardedPaysAttackerIfUserApproves: 1,
      tapConfirmPaid: 3,
      tapConfirmPaidToAttacker: 2,
      tapConfirmPaidOnlyBecauseUserTapped: 3,
      tapConfirmCarefulUserPaid: 0,
      naivePaid: 3,
    });
    expect(attacks.A2.guarded).toMatchObject({ worst: "ASKED", paid: false, paysAttackerIfUserApproves: true });
    expect(attacks.A7.guarded).toMatchObject({ worst: "ASKED", paysAttackerIfUserApproves: false });
  });
});
