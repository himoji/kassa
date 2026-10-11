/*
 * The payments daily cap is a fixed amount in a reference currency (PAYMENTS_DAILY_CAP_CURRENCY, default KZT) and is
 * converted into each user's home currency: rounded DOWN, fail-closed (PAYMENTS_DAILY_CAP) when conversion fails.
 * Rules pre-check the same converted cap (REFUSE_CAP + PAYMENTS_DAILY_CAP before signing).
 */
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { payments, users } from "../../src/db/schema.ts";
import { setEnvForTests } from "../../src/env.ts";
import { toHome, useFallbackFxForTests } from "../../src/modules/money/fx.ts";
import { registerHomeConverter } from "../../src/modules/payments/index.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { addPayee, createUserWithPasskey, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

// Example mid rates (fixtures/fx-rates.json, base EUR): 1 EUR = rates[X] units of X.
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../fixtures/fx-rates.json"), "utf8")) as { rates: Record<string, string> };
const CAP_KZT_MINOR = 200_000_000; // ₸2,000,000
/** Exact CNY minor units (fen) of ₸2,000,000 at the fixture rates: ₸2,000,000 × CNY/KZT × 100. */
const exactCapFen = ((2_000_000 * Number(fixture.rates.CNY)) / Number(fixture.rates.KZT)) * 100;

/** A CNY home-currency user (EU region, so no handoff). */
async function cnyUser() {
  const u = await createUserWithPasskey({ region: "EU" });
  await getDb().update(users).set({ homeCurrency: "CNY" }).where(eq(users.id, u.userId));
  await signBaseRules(u.userId, u.auth, "CNY");
  return u;
}

/** Propose; if the rules ask for the passkey, sign it (a passkey approval runs the executor and its refusals). */
async function proposeAndMaybeSign(userId: string, auth: Parameters<typeof signBaseRules>[1], amountMinor: number, payeeId: string) {
  const r = await proposeOrder({ userId, createdBy: "USER", payeeId, amountMinor, currency: "CNY", purpose: "Dorm" });
  if (r.decision !== "ASK") return r;
  const v = await getOrderView(userId, r.proposalId);
  const res = await approveOrder(userId, r.proposalId, auth.assert(v.orderHash));
  return { ...r, reasonCodes: res.reasonCodes, decision: r.decision };
}

describe("payments daily cap: reference currency converted to the home currency", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
    // The fx module with its offline example table (fixtures/fx-rates.json), not the 1-table fallback.
    useFallbackFxForTests(false);
    setEnvForTests({ PAYMENTS_DAILY_CAP_HOME_MINOR: String(CAP_KZT_MINOR), PAYMENTS_DAILY_CAP_CURRENCY: "KZT" });
  });

  it("the converted cap is rounded DOWN and lies within ¥27,000-30,000 of the exact fixture conversion", async () => {
    const down = await toHome(CAP_KZT_MINOR, "KZT", "CNY", new Date("2026-10-12T00:00:00Z"), "down");
    expect(down.amountMinor).toBeLessThanOrEqual(exactCapFen);
    expect(exactCapFen - down.amountMinor).toBeLessThan(1); // only the rate's last decimals separate them
    expect(down.amountMinor / 100).toBeGreaterThanOrEqual(27_000);
    expect(down.amountMinor / 100).toBeLessThanOrEqual(30_000);
  });

  it("a CNY user: a payment above the converted cap is refused with PAYMENTS_DAILY_CAP, one below is not", async () => {
    const { userId, auth } = await cnyUser();
    const payee = await addPayee(userId, { name: "Dorm Office in Shanghai", kind: "UNIVERSITY", currency: "CNY" });
    const above = await proposeOrder({ userId, createdBy: "USER", payeeId: payee.id, amountMinor: Math.ceil(exactCapFen) + 100, currency: "CNY", purpose: "Dorm" });
    expect(above.decision).toBe("REFUSE");
    expect(above.reasonCodes).toContain("PAYMENTS_DAILY_CAP");
    const below = await proposeAndMaybeSign(userId, auth, 2_000_000, payee.id);
    expect(below.reasonCodes).not.toContain("PAYMENTS_DAILY_CAP");
  });

  it("fails closed: when the cap cannot be converted, the executor refuses with PAYMENTS_DAILY_CAP and pays nothing", async () => {
    const { userId, auth } = await cnyUser();
    const payee = await addPayee(userId, { name: "Dorm Office in Shanghai", kind: "UNIVERSITY", currency: "CNY" });
    registerHomeConverter(async () => {
      throw new Error("fx down");
    });
    try {
      const r = await proposeAndMaybeSign(userId, auth, 100_000, payee.id);
      expect(r.reasonCodes).toContain("PAYMENTS_DAILY_CAP");
      expect(await getDb().select().from(payments)).toHaveLength(0);
    } finally {
      registerHomeConverter(null);
      offlineEnvironment();
    }
  });
});
