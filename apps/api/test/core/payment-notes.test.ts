/*
 * The payment notification after a tap (POST /capture/shortcut `nudge`, and the in-app notification): when and where,
 * the likely place (processor prefixes moved aside, the AI's guess with consent), budget context for spending in a
 * category WITHOUT a budget, and the AI tip, which may only quote numbers the server computed.
 */
import { eq } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { budgets, cards, notifications, profiles, transactions, users } from "../../src/db/schema.ts";
import { purgeExpired } from "../../src/modules/privacy/service.ts";
import { setPaymentNoteModelForTests, tipIsGrounded } from "../../src/modules/advice/enrich.ts";
import { ADVICE_PROMPT } from "../../src/modules/advice/prompt.ts";
import { SYSTEM_PROMPT } from "../../src/modules/agent/prompt.ts";
import { cardFromHint } from "../../src/modules/capture/cards.ts";
import { cleanMerchant } from "../../src/modules/capture/place.ts";
import { rememberCategoryCorrection } from "../../src/modules/capture/service.ts";
import { normalizeMerchant } from "../../src/modules/capture/normalize.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

async function device(userId: string): Promise<string> {
  const res = await app().inject({ method: "POST", url: "/api/devices/shortcut", headers: await bearer(userId) });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

async function tap(token: string, payload: Record<string, unknown>) {
  const res = await app().inject({ method: "POST", url: "/api/capture/shortcut", headers: { authorization: `Bearer ${token}` }, payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { status: string; transactionId: string; nudge: string; nudgeTitle: string; nudgeBody: string };
}

async function hufUser(opts: { aiConsent?: boolean } = {}) {
  const { userId } = await createUserWithPasskey(opts.aiConsent === false ? { aiConsent: false } : {});
  await getDb().update(users).set({ homeCurrency: "HUF" }).where(eq(users.id, userId));
  return userId;
}

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

/** A model that answers every call with this JSON, and counts the calls. */
function fakeModel(answer: unknown) {
  const calls: string[] = [];
  const model = new MockLanguageModelV4({
    provider: "test",
    modelId: "payment-note",
    doGenerate: async (opts) => {
      calls.push(JSON.stringify(opts.prompt));
      return { content: [{ type: "text", text: JSON.stringify(answer) }], finishReason: { unified: "stop", raw: undefined }, usage: USAGE, warnings: [] };
    },
  });
  return { model, calls };
}

beforeEach(async () => {
  await t.reset();
  offlineEnvironment();
  clock.freezeForTests(new Date("2026-10-11T09:00:00.000Z"));
  setPaymentNoteModelForTests(null);
});
afterEach(() => {
  clock.freezeForTests(null);
  setPaymentNoteModelForTests(undefined);
});

describe("when, where and which place", () => {
  it("names the street and city the Shortcut sent, keeps them (coordinates rounded) and counts visits", async () => {
    const userId = await hufUser();
    const token = await device(userId);
    const loc = { street: "Váci utca 10", city: "Budapest", country: "Hungary", latitude: "47.493812", longitude: 19.054321 };
    const first = await tap(token, { merchant: "CAFE FREI", amount: "1 290 Ft", ...loc });
    expect(plain(first.nudge).split("\n")[1]).toBe("Today 11:00 · Váci utca 10, Budapest · first time here");
    const row = (await getDb().select().from(transactions).where(eq(transactions.id, first.transactionId)))[0]!;
    expect(row.place).toEqual({ name: "Cafe Frei", source: "CLEANED", street: "Váci utca 10", city: "Budapest", country: "Hungary", lat: 47.494, lon: 19.054 });

    clock.freezeForTests(new Date("2026-10-11T15:30:00.000Z"));
    const second = await tap(token, { merchant: "CAFE FREI", amount: "990 Ft", city: "Budapest" });
    expect(plain(second.nudge).split("\n")[1]).toBe("Today 17:30 · Budapest · 2nd visit this month");
  });

  it("moves the payment processor aside: SQ *BLUE BOTTLE 0412 is Blue Bottle, paid via Square", async () => {
    const userId = await hufUser();
    const token = await device(userId);
    const r = await tap(token, { merchant: "SQ *BLUE BOTTLE 0412", amount: "HUF 2,100.00" });
    expect(plain(r.nudgeTitle)).toBe("Logged HUF 2,100.00 at Blue Bottle");
    expect(plain(r.nudge).split("\n")[1]).toBe("Today 11:00 · first time here · paid via Square");
    expect(cleanMerchant("SUMUP *CAFE FREI")).toEqual({ name: "Cafe Frei", processor: "SumUp" });
    expect(cleanMerchant("ZETTLE_*Bistro Nord")).toEqual({ name: "Bistro Nord", processor: "Zettle" });
    expect(cleanMerchant("Café de Flore")).toEqual({ name: "Café de Flore", processor: null });
  });

  it("old Shortcuts without location fields still work, and junk coordinates are ignored", async () => {
    const userId = await hufUser();
    const token = await device(userId);
    const r = await tap(token, { merchant: "CAFE FREI", amount: "1 290 Ft", latitude: "not a number", longitude: "", city: "" });
    expect(r.status).toBe("LOGGED");
    const row = (await getDb().select().from(transactions).where(eq(transactions.id, r.transactionId)))[0]!;
    expect(row.place).toEqual({ name: "Cafe Frei", source: "CLEANED" });
  });

  it("after the captured-text retention, the street and coordinates go and the city stays", async () => {
    const userId = await hufUser();
    const token = await device(userId);
    const r = await tap(token, { merchant: "CAFE FREI", amount: "1 290 Ft", street: "Váci utca 10", city: "Budapest", latitude: 47.49, longitude: 19.05 });
    await purgeExpired(new Date("2027-02-01T00:00:00.000Z"));
    const row = (await getDb().select().from(transactions).where(eq(transactions.id, r.transactionId)))[0]!;
    expect(row.place).toEqual({ name: "Cafe Frei", source: "CLEANED", city: "Budapest" });
  });

  it("the in-app notification says where too", async () => {
    const userId = await hufUser();
    await rememberCategoryCorrection(userId, normalizeMerchant("CAFE FREI"), "eating_out");
    await getDb().insert(budgets).values({ userId, category: "eating_out", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: 10_000_00 });
    const token = await device(userId);
    await tap(token, { merchant: "CAFE FREI", amount: "1 290 Ft", city: "Budapest" });
    const n = (await getDb().select().from(notifications).where(eq(notifications.userId, userId)))[0]!;
    expect(n.kind).toBe("BUDGET_EACH");
    expect(plain(n.body)).toBe("HUF 1,290.00 at Cafe Frei in Budapest. Eating out: 12% used, 88% left for 21 days, on track.");
    expect(n.data).toMatchObject({ key: "budget.each", params: { where: "Budapest" } });
  });
});

describe("cards learned from taps", () => {
  it("a tap with a card Kassa does not know adds it, says so once, and later taps reuse it", async () => {
    const userId = await hufUser();
    const token = await device(userId);
    const first = await tap(token, { merchant: "CAFE FREI", amount: "1 290 Ft", card: "Visa ••4821" });
    expect(plain(first.nudge)).toContain("New card saved: Visa ••4821 (billed in HUF)");
    const mine = await getDb().select().from(cards).where(eq(cards.userId, userId));
    expect(mine).toMatchObject([{ label: "Visa", last4: "4821", billingCurrency: "HUF", kind: "LOCAL_HUF" }]);
    const row = (await getDb().select().from(transactions).where(eq(transactions.id, first.transactionId)))[0]!;
    expect(row.cardId).toBe(mine[0]!.id);
    const n = await getDb().select().from(notifications).where(eq(notifications.kind, "CARD_LEARNED"));
    expect(n.map((x) => x.title)).toEqual(["New card: Visa ••4821"]);

    const second = await tap(token, { merchant: "SPAR", amount: "2 000 Ft", card: "Visa ••4821" });
    expect(second.nudge).not.toContain("New card saved");
    expect(await getDb().select().from(cards).where(eq(cards.userId, userId))).toHaveLength(1);
  });

  it("a multi-currency account is assumed to bill in the spend's currency", async () => {
    const userId = await hufUser();
    const token = await device(userId);
    await tap(token, { merchant: "Café de Flore", amount: "€4.50", card: "Revolut" });
    expect(await getDb().select().from(cards).where(eq(cards.userId, userId))).toMatchObject([{ label: "Revolut", last4: "", billingCurrency: "EUR", kind: "MULTI" }]);
  });

  it("reads the card name and last 4 digits from the hint", () => {
    expect(cardFromHint("Mastercard •••• 9876")).toEqual({ label: "Mastercard", last4: "9876" });
    expect(cardFromHint("Revolut")).toEqual({ label: "Revolut", last4: "" });
    expect(cardFromHint("1234")).toEqual({ label: "Card", last4: "1234" });
    expect(cardFromHint("   ")).toBeNull();
  });
});

describe("spending outside budgets", () => {
  it("a category with no budget gets the month so far, the usual month, and the share of income", async () => {
    const userId = await hufUser();
    await rememberCategoryCorrection(userId, normalizeMerchant("ZARA"), "shopping");
    await getDb().insert(budgets).values({ userId, category: "eating_out", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: 10_000_00 });
    await getDb().update(profiles).set({ incomes: [{ source: "Family", currency: "HUF", amountMinor: 200_000_00, cadence: "MONTHLY", nextDate: "2026-11-01" }] }).where(eq(profiles.userId, userId));
    // History: shopping in August and September (8 000 and 10 000 → usually 9 000), and eating out this month.
    const row = (occurredAt: string, category: string, amountMinor: number) => ({
      userId,
      source: "TEXT" as const,
      occurredAt: new Date(occurredAt),
      merchantRaw: "OLD",
      merchantNorm: `old ${category}`,
      amountMinor,
      currency: "HUF",
      homeAmountMinor: amountMinor,
      category,
      status: "SETTLED" as const,
      createdAt: new Date(occurredAt),
    });
    await getDb().insert(transactions).values([row("2026-08-01T10:00:00Z", "shopping", 8_000_00), row("2026-09-12T10:00:00Z", "shopping", 10_000_00), row("2026-10-05T10:00:00Z", "eating_out", 3_000_00)]);
    const token = await device(userId);

    const r = await tap(token, { merchant: "ZARA", amount: "12 000 Ft" });
    const lines = plain(r.nudge).split("\n");
    expect(lines[2]).toBe("Shopping: no budget · HUF 12,000.00 this month (1 purchase), usually HUF 9,000.00");
    // All spending 15 000 of 200 000 income = 7 %; 21 days left in October.
    expect(lines[3]).toBe("Outside budgets HUF 12,000.00 · all spending 7% of income · 21 days left");

    const n = (await getDb().select().from(notifications).where(eq(notifications.userId, userId)))[0]!;
    expect(n.kind).toBe("SPEND_UNBUDGETED");
    expect(n.title).toBe("Shopping: no budget");
    expect(plain(n.body)).toBe(
      "HUF 12,000.00 at Zara. Shopping this month: HUF 12,000.00 in 1 purchase, usually HUF 9,000.00 a month. Outside your budgets: HUF 12,000.00. All spending: HUF 15,000.00 (7% of monthly income), 21 days left this month.",
    );
    expect(n.data).toMatchObject({ key: "budget.unbudgeted", params: { category: "shopping", count: 1, spent: { amountMinor: 12_000_00, currency: "HUF" }, typical: { amountMinor: 9_000_00 }, incomeUsedPct: 7 } });
  });

  it("a user with no budgets at all is told none of the month is budgeted", async () => {
    const userId = await hufUser();
    const token = await device(userId);
    const r = await tap(token, { merchant: "CAFE FREI", amount: "1 290 Ft" });
    expect(plain(r.nudge).split("\n").slice(2)).toEqual(["Eating out: no budget · HUF 1,290.00 this month (1 purchase)", "None of this month's spending has a budget · all spending HUF 1,290.00 · 21 days left"]);
  });
});

describe("AI note (likely place and tip)", () => {
  it("adds the model's place and a tip that only quotes the server's numbers; the guess is kept on the transaction", async () => {
    const userId = await hufUser();
    await rememberCategoryCorrection(userId, normalizeMerchant("SQ *BB 0412"), "eating_out");
    await getDb().insert(budgets).values({ userId, category: "eating_out", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: 10_000_00 });
    const { model, calls } = fakeModel({ place: { name: "Blue Bottle Coffee", kind: "café", confidence: "high" }, tip: "About HUF 414 a day keeps eating out on track." });
    setPaymentNoteModelForTests(model);
    const token = await device(userId);
    const r = await tap(token, { merchant: "SQ *BB 0412", amount: "1 290 Ft", city: "Budapest", latitude: 47.5, longitude: 19.05 });
    const lines = plain(r.nudge).split("\n");
    expect(lines).toContain("Probably Blue Bottle Coffee, a café");
    expect(lines[lines.length - 1]).toBe("Tip: About HUF 414 a day keeps eating out on track.");
    // The model saw the merchant text quoted as data and the city, never the coordinates.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("<merchant_text>SQ *BB 0412</merchant_text>");
    expect(calls[0]).toContain("Budapest");
    expect(calls[0]).not.toContain("47.5");
    const row = (await getDb().select().from(transactions).where(eq(transactions.id, r.transactionId)))[0]!;
    expect(row.place).toMatchObject({ name: "Blue Bottle Coffee", kind: "café", source: "AI", processor: "Square", city: "Budapest" });
  });

  it("drops a tip with an invented number and a low-confidence place", async () => {
    const userId = await hufUser();
    setPaymentNoteModelForTests(fakeModel({ place: { name: "Somewhere", kind: "shop", confidence: "low" }, tip: "You could save HUF 50,000 a month by cooking." }).model);
    const token = await device(userId);
    const r = await tap(token, { merchant: "XYZ 123", amount: "1 290 Ft" });
    expect(r.nudge).not.toMatch(/Tip:|Probably/);
  });

  it("never calls the model without the user's AI consent", async () => {
    const userId = await hufUser({ aiConsent: false });
    const { model, calls } = fakeModel({ place: null, tip: null });
    setPaymentNoteModelForTests(model);
    const token = await device(userId);
    await tap(token, { merchant: "CAFE FREI", amount: "1 290 Ft" });
    expect(calls).toHaveLength(0);
  });

  it("a failing model leaves the plain notification", async () => {
    const userId = await hufUser();
    setPaymentNoteModelForTests(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error("provider down");
        },
      }),
    );
    const token = await device(userId);
    const r = await tap(token, { merchant: "CAFE FREI", amount: "1 290 Ft" });
    expect(plain(r.nudgeTitle)).toBe("Logged HUF 1,290.00 at Cafe Frei");
    expect(r.nudge).not.toContain("Tip:");
  });

  it("tipIsGrounded accepts numbers from the facts only", () => {
    const facts = { budgetLeft: "HUF 8,710.00", budgetLeftPct: 88, budgetPerDayLeft: "HUF 414" };
    expect(tipIsGrounded("HUF 414 a day keeps you on track", facts)).toBe(true);
    expect(tipIsGrounded("88% left: HUF 8,710.00 to go", facts)).toBe(true);
    expect(tipIsGrounded("Spend under HUF 300 a day", facts)).toBe(false);
    expect(tipIsGrounded("Nice choice, keep it up", facts)).toBe(true);
  });
});

describe("advice prompt", () => {
  it("the chat agent carries the money-advice prompt", () => {
    expect(SYSTEM_PROMPT).toContain(ADVICE_PROMPT);
    expect(ADVICE_PROMPT).toMatch(/not only categories with a budget/);
  });
});
