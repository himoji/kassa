/*
 * X3 (security review F2): a prompt-injected planner could spend up to the daily cap through repeated small-auto
 * payments, each under the signed small-auto limit. Small-auto now has a per-day budget (config:
 * SMALL_AUTO_DAILY_MAX_COUNT, default 3; SMALL_AUTO_DAILY_AMOUNT_MULTIPLE × the signed small-auto limit, default 3).
 * Beyond it: ASK + SMALL_AUTO_BUDGET_EXHAUSTED. Payments enforces the same budget independently (I2).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { payments } from "../../src/db/schema.ts";
import { setEnvForTests } from "../../src/env.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { executeApproval } from "../../src/modules/payments/index.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { addPayee, addPriorPayment, createUserWithPasskey, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { forgeSignedApproval } from "../helpers/forge.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

async function smartUserWithShop() {
  const { userId, auth } = await createUserWithPasskey({ preset: "SMART", moneyMode: "CAPPED_WALLET" });
  await signBaseRules(userId, auth); // small-auto limit ₸10,000 (DEFAULT_CAPS.smallAutoMinor = 1,000,000)
  const shop = await addPayee(userId, { name: "Corner Shop in Budapest", kind: "MERCHANT", currency: "KZT" });
  await addPriorPayment(userId, shop.id); // a known shop: the first payment to a payee always asks
  return { userId, auth, shop };
}

describe("X3 per-day small-auto budget", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
    // Midday UTC so all ten orders fall on the same UTC day and outside the "unusual hour" risk feature.
    clock.freezeForTests(new Date("2026-10-28T12:00:00.000Z"));
  });
  afterEach(() => {
    clock.freezeForTests(null);
    setEnvForTests({ SMALL_AUTO_DAILY_MAX_COUNT: "3", SMALL_AUTO_DAILY_AMOUNT_MULTIPLE: "3" });
  });

  it("10 injected small orders in one day: only the first 3 are AUTO, the rest ASK SMALL_AUTO_BUDGET_EXHAUSTED", async () => {
    const { userId, shop } = await smartUserWithShop();
    const decisions: { decision: string; reasonCodes: string[] }[] = [];
    for (let i = 0; i < 10; i++) {
      // ₸5,000 each: under the ₸10,000 small-auto limit, ₸15,000 for three is under the ₸30,000 daily amount.
      decisions.push(await proposeOrder({ userId, createdBy: "AGENT", payeeId: shop.id, amountMinor: 500_000, currency: "KZT", purpose: `Snack ${i}`, rail: "BANK_TRANSFER" }));
    }
    expect(decisions.slice(0, 3).map((d) => d.decision)).toEqual(["AUTO", "AUTO", "AUTO"]);
    for (const d of decisions.slice(3)) {
      expect(d.decision).toBe("ASK");
      expect(d.reasonCodes).toContain("SMALL_AUTO_BUDGET_EXHAUSTED");
    }
    expect(await getDb().select().from(payments)).toHaveLength(4); // 3 today + the earlier one
  });

  it("the daily amount budget binds before the count (₸9,000 + ₸9,000, then ₸3,000 > ₸20,000)", async () => {
    setEnvForTests({ SMALL_AUTO_DAILY_MAX_COUNT: "10", SMALL_AUTO_DAILY_AMOUNT_MULTIPLE: "2" }); // ₸20,000 per day
    const { userId, shop } = await smartUserWithShop();
    const a = await proposeOrder({ userId, createdBy: "AGENT", payeeId: shop.id, amountMinor: 900_000, currency: "KZT", purpose: "A", rail: "BANK_TRANSFER" });
    const b = await proposeOrder({ userId, createdBy: "AGENT", payeeId: shop.id, amountMinor: 900_000, currency: "KZT", purpose: "B", rail: "BANK_TRANSFER" });
    const c = await proposeOrder({ userId, createdBy: "AGENT", payeeId: shop.id, amountMinor: 300_000, currency: "KZT", purpose: "C", rail: "BANK_TRANSFER" });
    expect([a.decision, b.decision]).toEqual(["AUTO", "AUTO"]);
    expect(c.decision).toBe("ASK"); // ₸18,000 + ₸3,000 > ₸20,000
    expect(c.reasonCodes).toContain("SMALL_AUTO_BUDGET_EXHAUSTED");
  });

  it("the budget renews the next UTC day", async () => {
    const { userId, shop } = await smartUserWithShop();
    for (let i = 0; i < 3; i++) await proposeOrder({ userId, createdBy: "AGENT", payeeId: shop.id, amountMinor: 500_000, currency: "KZT", purpose: `Snack ${i}`, rail: "BANK_TRANSFER" });
    clock.freezeForTests(new Date("2026-10-29T12:00:00.000Z"));
    const next = await proposeOrder({ userId, createdBy: "AGENT", payeeId: shop.id, amountMinor: 500_000, currency: "KZT", purpose: "Next day", rail: "BANK_TRANSFER" });
    expect(next.decision).toBe("AUTO");
  });

  it("payments enforces the budget itself: a 4th small-auto approval signed by a buggy rules is refused", async () => {
    const { userId, shop } = await smartUserWithShop();
    for (let i = 0; i < 3; i++) await proposeOrder({ userId, createdBy: "AGENT", payeeId: shop.id, amountMinor: 500_000, currency: "KZT", purpose: `Snack ${i}`, rail: "BANK_TRANSFER" });
    expect(await getDb().select().from(payments)).toHaveLength(4); // 3 today + the earlier one
    const { approvalId } = await forgeSignedApproval(shop, { amountMinor: 500_000, currency: "KZT", homeAmountMinor: 500_000 });
    expect((await executeApproval(approvalId)).reasonCodes).toEqual(["SMALL_AUTO_BUDGET_EXHAUSTED"]);
    expect(await getDb().select().from(payments)).toHaveLength(4); // 3 today + the earlier one
  });
});
