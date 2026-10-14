/*
 * GET /insights/spending (the month by category and by day, against last month and a usual month) and
 * GET /transactions/:id (one purchase, its place and card, its category this month, and the merchant's history).
 */
import { SpendingInsightsResponse, TransactionDetailResponse } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { budgets, cards, profiles, transactions, users } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

beforeEach(async () => {
  await t.reset();
  offlineEnvironment();
  clock.freezeForTests(new Date("2026-10-11T09:00:00.000Z"));
});
afterEach(() => {
  clock.freezeForTests(null);
});

async function hufUser() {
  const { userId } = await createUserWithPasskey();
  await getDb().update(users).set({ homeCurrency: "HUF" }).where(eq(users.id, userId));
  return userId;
}

function spend(userId: string, occurredAt: string, merchant: string, category: string | null, amountMinor: number, extra: Partial<typeof transactions.$inferInsert> = {}) {
  return {
    userId,
    source: "SHORTCUT" as const,
    occurredAt: new Date(occurredAt),
    merchantRaw: merchant,
    merchantNorm: merchant.toLowerCase(),
    amountMinor,
    currency: "HUF",
    homeAmountMinor: amountMinor,
    category,
    status: "SETTLED" as const,
    createdAt: new Date(occurredAt),
    ...extra,
  };
}

async function get(userId: string, url: string) {
  return app().inject({ method: "GET", url: `/api${url}`, headers: await bearer(userId) });
}

describe("GET /insights/spending", () => {
  it("adds up this month by category and day, with last month to date, the usual month and the pace", async () => {
    const userId = await hufUser();
    await getDb().insert(budgets).values({ userId, category: "groceries", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: 50_000_00 });
    await getDb().update(profiles).set({ incomes: [{ source: "Family", currency: "HUF", amountMinor: 200_000_00, cadence: "MONTHLY", nextDate: "2026-11-01" }] }).where(eq(profiles.userId, userId));
    await getDb()
      .insert(transactions)
      .values([
        spend(userId, "2026-08-02T10:00:00Z", "SPAR", "groceries", 30_000_00),
        spend(userId, "2026-09-03T10:00:00Z", "SPAR", "groceries", 6_000_00),
        spend(userId, "2026-09-25T10:00:00Z", "ZARA", "shopping", 20_000_00),
        spend(userId, "2026-10-02T08:00:00Z", "SPAR", "groceries", 4_000_00),
        spend(userId, "2026-10-02T18:00:00Z", "SPAR", "groceries", 2_000_00),
        spend(userId, "2026-10-09T12:00:00Z", "WOLT", "eating_out", 5_000_00),
      ]);

    const res = await get(userId, "/insights/spending");
    expect(res.statusCode, res.body).toBe(200);
    const body = SpendingInsightsResponse.parse(res.json());

    expect(body.homeCurrency).toBe("HUF");
    expect(body.month).toEqual({ start: "2026-10-01", end: "2026-10-31", daysTotal: 31, daysElapsed: 11, daysLeft: 21 });
    expect(body.totalMinor).toBe(11_000_00);
    expect(body.count).toBe(3);
    // September 1–11 had one 6 000 purchase; the whole of September 26 000.
    expect(body.lastMonthToDateMinor).toBe(6_000_00);
    expect(body.lastMonthTotalMinor).toBe(26_000_00);
    // August (tracked from the 2nd: in full) 30 000 and September 26 000: usually 28 000.
    expect(body.typicalMonthMinor).toBe(28_000_00);
    // Pace: the last 11 days without the biggest (6 000 on the 2nd) is 5 000 / 10 a day, for the 20 days after today.
    expect(body.projectedMinor).toBe(11_000_00 + 500_00 * 20);
    expect(body.incomeUsedPct).toBe(5);
    expect(body.outsideBudgetsMinor).toBe(5_000_00);

    expect(body.daily).toHaveLength(11);
    expect(body.daily[1]).toEqual({ date: "2026-10-02", spentMinor: 6_000_00 });
    expect(body.daily[8]).toEqual({ date: "2026-10-09", spentMinor: 5_000_00 });
    expect(body.daily[10]).toEqual({ date: "2026-10-11", spentMinor: 0 });

    const groceries = body.categories.find((c) => c.category === "groceries")!;
    expect(groceries).toMatchObject({ spentMinor: 6_000_00, count: 2, sharePct: 54, typicalMinor: 18_000_00 });
    expect(groceries.budget).toMatchObject({ limitMinor: 50_000_00, spentMinor: 6_000_00, remainingMinor: 44_000_00, pace: "ON_TRACK" });
    expect(body.categories.find((c) => c.category === "eating_out")?.budget).toBeNull();

    expect(body.topMerchants[0]).toEqual({ name: "Spar", spentMinor: 6_000_00, count: 2 });
    expect(body.topMerchants[1]?.spentMinor).toBe(5_000_00);
  });

  it("compares only against months tracked in full", async () => {
    const userId = await hufUser();
    // Tracking started on September 27: September is not a usual month and not a fair "last month".
    await getDb()
      .insert(transactions)
      .values([spend(userId, "2026-09-27T10:00:00Z", "SPAR", "groceries", 3_000_00), spend(userId, "2026-10-01T10:00:00Z", "RENT", "rent", 200_000_00), spend(userId, "2026-10-05T10:00:00Z", "SPAR", "groceries", 2_000_00)]);
    const body = SpendingInsightsResponse.parse((await get(userId, "/insights/spending")).json());
    expect(body.lastMonthToDateMinor).toBeNull();
    expect(body.lastMonthTotalMinor).toBeNull();
    expect(body.typicalMonthMinor).toBeNull();
    expect(body.categories.every((c) => c.typicalMinor === null)).toBe(true);
    // Rent on the 1st is counted once, not repeated for every day left.
    expect(body.projectedMinor).toBe(202_000_00 + Math.round((2_000_00 / 10) * 20));
  });

  it("is empty but well-formed for a new user, and lists budgets with nothing spent yet", async () => {
    const userId = await hufUser();
    await getDb().insert(budgets).values({ userId, category: "transport", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: 10_000_00 });
    const body = SpendingInsightsResponse.parse((await get(userId, "/insights/spending")).json());
    expect(body.totalMinor).toBe(0);
    expect(body.lastMonthToDateMinor).toBeNull();
    expect(body.typicalMonthMinor).toBeNull();
    expect(body.categories).toEqual([
      { category: "transport", spentMinor: 0, count: 0, typicalMinor: null, sharePct: 0, budget: expect.objectContaining({ limitMinor: 10_000_00 }) },
    ]);
    expect(body.topMerchants).toEqual([]);
  });
});

describe("GET /transactions/:id", () => {
  it("returns the purchase with its place, card, category month and the merchant's earlier visits", async () => {
    const userId = await hufUser();
    const [card] = await getDb().insert(cards).values({ userId, label: "OTP Visa", last4: "4242", billingCurrency: "HUF", kind: "LOCAL_HUF" }).returning();
    await getDb().insert(budgets).values({ userId, category: "eating_out", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: 20_000_00 });
    await getDb()
      .insert(transactions)
      .values([
        spend(userId, "2026-09-14T08:00:00Z", "SQ *BLUE BOTTLE", "eating_out", 1_500_00),
        spend(userId, "2026-10-03T08:00:00Z", "SQ *BLUE BOTTLE", "eating_out", 1_700_00),
        spend(userId, "2026-10-08T12:00:00Z", "WOLT", "eating_out", 4_000_00),
      ]);
    const [tx] = await getDb()
      .insert(transactions)
      .values(
        spend(userId, "2026-10-10T08:00:00Z", "SQ *BLUE BOTTLE", "eating_out", 1_800_00, {
          cardId: card!.id,
          place: { name: "Blue Bottle Coffee", kind: "café", processor: "Square", street: "Váci utca 10", city: "Budapest", lat: 47.493, lon: 19.053 },
        }),
      )
      .returning();

    const res = await get(userId, `/transactions/${tx!.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = TransactionDetailResponse.parse(res.json());
    expect(body.transaction.id).toBe(tx!.id);
    expect(body.merchant).toBe("Blue Bottle Coffee");
    expect(body.place).toEqual({ name: "Blue Bottle Coffee", kind: "café", where: "Váci utca 10, Budapest", processor: "Square", lat: 47.493, lon: 19.053 });
    expect(body.card).toEqual({ label: "OTP Visa", last4: "4242" });
    expect(body.category).toMatchObject({ category: "eating_out", spentThisMonthMinor: 7_500_00, countThisMonth: 3, shareOfMonthPct: 100 });
    expect(body.category?.budget).toMatchObject({ limitMinor: 20_000_00, remainingMinor: 12_500_00 });
    expect(body.merchantHistory).toMatchObject({ visits: 3, totalMinor: 5_000_00, averageMinor: Math.round(5_000_00 / 3), firstAt: "2026-09-14T08:00:00.000Z" });
    expect(body.merchantHistory.recent.map((r) => r.occurredAt)).toEqual(["2026-10-03T08:00:00.000Z", "2026-09-14T08:00:00.000Z"]);
  });

  it("is 404 for someone else's purchase and for an unknown id", async () => {
    const owner = await hufUser();
    const other = (await createUserWithPasskey()).userId;
    const [tx] = await getDb().insert(transactions).values(spend(owner, "2026-10-10T08:00:00Z", "SPAR", null, 1_000_00)).returning();
    expect((await get(other, `/transactions/${tx!.id}`)).statusCode).toBe(404);
    expect((await get(owner, "/transactions/00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    const mine = TransactionDetailResponse.parse((await get(owner, `/transactions/${tx!.id}`)).json());
    expect(mine.category).toBeNull();
    expect(mine.card).toBeNull();
    expect(mine.merchant).toBe("Spar");
  });
});
