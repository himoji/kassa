/*
 * A16 — salami / cap splitting. The classic way round a per-payment limit: many payments, each below it. Against an
 * agent that pays small amounts on its own, a fooled planner only has to split ("pay the HUF 90,000 in ten parts so
 * none needs approval"). Expected: to a payee the user just added, every slice is REFUSE_UNVERIFIED_PAYEE +
 * PAYEE_COOLING; after cooling every slice still asks (PAYEE_COOLING), none is AUTO; ledgered each time. Bound: even
 * if the user had verified the payee with a passkey, small-auto stops after the signed daily budget
 * (SMALL_AUTO_BUDGET_EXHAUSTED), so the slices cannot add up past it.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { approvals, payees, payments } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { createPayee } from "../../src/modules/payees/service.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { DEFAULT_CAPS } from "../../src/modules/users/service.ts";
import { ATTACKS, ledgerWithReason, moneyMoved, recordGuarded } from "../helpers/attacks.ts";
import { addPriorPayment, createUserWithPasskey, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { A16_ACCOUNT, A16_SLICE_MINOR, A16_SLICES } from "../helpers/incidents.ts";

const t = useTestDb();
const ZERO = { livePayments: 0, sentPayments: 0, kassaTransactions: 0 };

async function setup() {
  const { userId, auth } = await createUserWithPasskey({ preset: "SMART" });
  await signBaseRules(userId, auth);
  const attacker = await createPayee(userId, { name: "Split Payments Ltd", kind: "MERCHANT", account: A16_ACCOUNT, country: "DE", currency: "KZT", source: "user" });
  return { userId, attacker };
}

/** The fooled planner's write path, once per slice (as the agent would call it across turns). */
async function slices(userId: string, payeeId: string) {
  const out = [];
  for (let i = 0; i < A16_SLICES; i++) {
    out.push(await proposeOrder({ userId, createdBy: "AGENT", payeeId, amountMinor: A16_SLICE_MINOR, currency: "KZT", purpose: `Part ${i + 1} of ${A16_SLICES}` }));
  }
  return out;
}

describe("A16: salami / cap splitting", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.setOffsetInMemoryForTests(0);
  });

  it("each slice is under the small-auto limit", () => {
    expect(A16_SLICE_MINOR).toBeLessThan(DEFAULT_CAPS.smallAutoMinor);
    expect(A16_SLICE_MINOR * A16_SLICES).toBeGreaterThan(3 * DEFAULT_CAPS.smallAutoMinor);
  });

  it("ten slices to a payee the user just added: every one is refused (cooling)", async () => {
    const { userId, attacker } = await setup();
    const rs = await slices(userId, attacker.id);
    expect(rs.map((r) => r.decision)).toEqual(Array(A16_SLICES).fill("REFUSE"));
    expect(new Set(rs.map((r) => r.reasonCodes.join(",")))).toEqual(new Set(["REFUSE_UNVERIFIED_PAYEE,PAYEE_COOLING"]));
    expect(await ledgerWithReason("PROPOSAL_CREATED", "PAYEE_COOLING")).toHaveLength(A16_SLICES);
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await moneyMoved()).toEqual(ZERO);
    recordGuarded("A16", { case: "10 slices under the small-auto limit to a new (cooling) payee", decision: "REFUSE", reasonCodes: rs[0]!.reasonCodes, ledger: ["PROPOSAL_CREATED"] });
  });

  it("after cooling every slice still asks: a payee the user never verified is never paid automatically", async () => {
    const { userId, attacker } = await setup();
    clock.setOffsetInMemoryForTests(25 * 3_600_000);
    const rs = await slices(userId, attacker.id);
    expect(rs.map((r) => r.decision)).toEqual(Array(A16_SLICES).fill("ASK"));
    expect(rs.every((r) => r.reasonCodes.includes("PAYEE_COOLING"))).toBe(true);
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await moneyMoved()).toEqual(ZERO);
    recordGuarded("A16", { case: "10 slices after cooling (payee never verified)", decision: "ASK", reasonCodes: rs[0]!.reasonCodes, ledger: ["PROPOSAL_CREATED"], ifApproved: { paysAttacker: true, note: "Each slice is its own passkey prompt; a user who approves all ten pays the attacker ten times, KZT 90,000 in all." } });
  });

  it("bound: had the user verified the payee with a passkey, small-auto stops at the signed daily budget", async () => {
    const { userId, attacker } = await setup();
    // Worst case: the user confirmed the payee (verify-callback with a passkey, X3a); written directly here.
    await getDb().update(payees).set({ status: "VERIFIED", verifiedAt: clock.now() }).where(eq(payees.id, attacker.id));
    // (2026-10-19) Never paid before: the first payment to a payee is never small-auto (FIRST_PAYMENT_TO_PAYEE).
    const fresh = await slices(userId, attacker.id);
    expect(fresh.every((r) => r.decision === "ASK" && r.reasonCodes.includes("FIRST_PAYMENT_TO_PAYEE"))).toBe(true);
    expect(await getDb().select().from(payments)).toHaveLength(0);
    // Worse still: the user even completed a payment to it once. Small-auto then stops at the signed daily budget.
    await addPriorPayment(userId, attacker.id);
    const rs = await slices(userId, attacker.id);
    const auto = rs.filter((r) => r.decision === "AUTO");
    // SMALL_AUTO_DAILY_MAX_COUNT (3) and SMALL_AUTO_DAILY_AMOUNT_MULTIPLE (3) × the signed limit.
    expect(auto.length).toBeLessThanOrEqual(3);
    expect(auto.length * A16_SLICE_MINOR).toBeLessThanOrEqual(3 * DEFAULT_CAPS.smallAutoMinor);
    expect(rs.slice(auto.length).every((r) => r.decision === "ASK" && r.reasonCodes.includes("SMALL_AUTO_BUDGET_EXHAUSTED"))).toBe(true);
    expect((await getDb().select().from(payments)).length).toBe(auto.length + 1); // + the earlier one
  });

  it("metadata matches the spec table", () => {
    expect(ATTACKS.A16.expected).toMatch(/PAYEE_COOLING/);
  });
});
