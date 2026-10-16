/* GET /history: the stored history for the Home card; null before any import, only the caller's own. */
import { ImportHistory } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { profiles } from "../../src/db/schema.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

const HISTORY = ImportHistory.parse({
  homeCurrency: "KZT",
  from: "2026-05-01",
  to: "2026-09-30",
  months: 5,
  counts: { rows: 120, spending: 100, incoming: 10, ownTransfers: 8, refunds: 2 },
  spendingByCategory: [{ category: "groceries", monthlyHomeMinor: 80_000_00, totalHomeMinor: 400_000_00, count: 60 }],
  monthlySpendingHomeMinor: 200_000_00,
  monthlyIncomeHomeMinor: 250_000_00,
  incomes: [],
  recurring: [],
  fees: { totalHomeMinor: 0, count: 0, fxMarkupBps: null, fxSamples: 0, fxCostHomeMinor: 0 },
  topMerchants: [],
  notes: ["Statements: Example Bank, 1 May – 30 Sep 2026 (5 months)."],
  currencies: [],
});

describe("GET /history", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("is null before any import, then the stored history, for the caller only", async () => {
    const a = await createUserWithPasskey({ counter: 1 });
    const b = await createUserWithPasskey({ counter: 1 });
    const get = async (userId: string) => (await app().inject({ method: "GET", url: "/api/history", headers: await bearer(userId) })).json();
    expect(await get(a.userId)).toEqual({ history: null });
    await getDb().update(profiles).set({ moneyHistory: HISTORY }).where(eq(profiles.userId, a.userId));
    expect((await get(a.userId)).history).toMatchObject({ months: 5, notes: HISTORY.notes });
    expect(await get(b.userId)).toEqual({ history: null });
    expect((await app().inject({ method: "GET", url: "/api/history" })).statusCode).toBe(401);
  });
});
