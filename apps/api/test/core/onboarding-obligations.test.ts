/*
 * Onboarding → bills (DECISIONS 2026-10-13): the chat's bills become obligations linked to placeholder payees
 * (COOLING, no account yet, no coolingUntil). They show on GET /obligations as "account details needed" and stay
 * unpayable on every path (rules, approve, verify callback) until real account details exist. The rent mandate is
 * offered after the base rules are signed (POST /onboarding/confirm returns it).
 */
import { randomUUID } from "node:crypto";

import { OnboardingConfirmResponse, type OnboardingProfileDraft } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { obligations, payees, proposals } from "../../src/db/schema.ts";
import { onboardingDrafts } from "../../src/db/schema.intel.ts";
import { clock, DAY_MS } from "../../src/modules/clock/index.ts";
import { verifyCallback } from "../../src/modules/payees/service.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

/** Dana's draft as the REPLAY onboarding chat ends (fixtures/agent-recordings/onboarding.json). */
const DRAFT: OnboardingProfileDraft = {
  displayName: "Dana",
  homeCurrency: "KZT",
  region: "EU",
  preset: "SMART",
  moneyMode: "CAPPED_WALLET",
  notificationMode: "EACH",
  incomes: [{ source: "Parents", currency: "KZT", amountMinor: 60_000_000, cadence: "MONTHLY", nextDate: "2026-11-25" }],
  obligations: [
    { payeeName: "Landlord in Budapest", payeeKind: "LANDLORD", amountMinor: 18_000_000, currency: "HUF", dueDate: "2026-11-01", recurrence: "MONTHLY", category: "rent" },
    { payeeName: "University in Budapest", payeeKind: "UNIVERSITY", amountMinor: 240_000, currency: "EUR", dueDate: "2026-10-31", recurrence: "TERM", category: "tuition" },
    { payeeName: "Student Insurer in EU", payeeKind: "INSURER", amountMinor: 9_600, currency: "EUR", dueDate: "2026-11-15", recurrence: "TERM", category: "insurance" },
    // No due date: cannot be placed on the calendar, so it is not created.
    { payeeName: "Gym in Budapest", payeeKind: "MERCHANT", amountMinor: 1_000_000, currency: "HUF", dueDate: null, recurrence: "MONTHLY", category: "health" },
  ],
  budgets: [{ category: "groceries", limitHomeMinor: 9_000_000 }],
  cards: [],
};

async function onboard(draft: OnboardingProfileDraft = DRAFT) {
  const { userId, auth } = await createUserWithPasskey();
  const h = await bearer(userId);
  const conversationId = randomUUID();
  await t.db().insert(onboardingDrafts).values({ conversationId, userId, draft, complete: true, updatedAt: clock.now() });
  const opt = (await app().inject({ method: "POST", url: "/api/onboarding/confirm/options", headers: h, payload: { conversationId } })).json();
  const res = await app().inject({
    method: "POST",
    url: "/api/onboarding/confirm",
    headers: h,
    payload: { conversationId, challengeId: opt.challengeId, core: opt.core, assertion: auth.assert(opt.rulesHash) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { userId, auth, h, confirm: OnboardingConfirmResponse.parse(res.json()) };
}

describe("onboarding draft → obligations with placeholder payees", () => {
  beforeAll(async () => {
    await ensureIntelTables(t.db());
  });
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("creates the dated bills, linked to COOLING payees with no account, shown as needing payee details", async () => {
    const { userId, h } = await onboard();
    const list = (await app().inject({ method: "GET", url: "/api/obligations", headers: h })).json().obligations as Array<Record<string, unknown>>;
    expect(list.map((o) => [o.payeeName, o.category, o.amountMinor, o.currency, o.dueDate, o.payeeStatus, o.payeeAccountMissing])).toEqual([
      ["University in Budapest", "tuition", 240_000, "EUR", "2026-10-31", "COOLING", true],
      ["Landlord in Budapest", "rent", 18_000_000, "HUF", "2026-11-01", "COOLING", true],
      ["Student Insurer in EU", "insurance", 9_600, "EUR", "2026-11-15", "COOLING", true],
    ]);
    const rows = await t.db().select().from(payees).where(eq(payees.userId, userId));
    expect(rows).toHaveLength(3);
    for (const p of rows) expect(p).toMatchObject({ status: "COOLING", accountEnc: null, accountHash: null, coolingUntil: null, verifiedAt: null });
    const dto = (await app().inject({ method: "GET", url: "/api/payees", headers: h })).json().payees as Array<Record<string, unknown>>;
    expect(dto.every((p) => p.accountMissing === true && p.accountMasked === "")).toBe(true);
  });

  it("offers the rent mandate after the base rules are signed", async () => {
    const { userId, confirm } = await onboard();
    const landlord = (await t.db().select().from(payees).where(eq(payees.userId, userId))).find((p) => p.kind === "LANDLORD")!;
    expect(confirm.onboarded).toBe(true);
    expect(confirm.suggestedMandate).toMatchObject({ payeeIds: [landlord.id], categories: ["rent"], currency: "HUF", period: "MONTH", maxPerPaymentMinor: 20_000_000 });
    expect(confirm.suggestedMandatePayees).toEqual([{ id: landlord.id, name: "Landlord in Budapest" }]);
  });

  it("no rent in the draft → no mandate offered", async () => {
    const { confirm } = await onboard({ ...DRAFT, obligations: DRAFT.obligations.filter((o) => o.category !== "rent") });
    expect(confirm.suggestedMandate).toBeNull();
    expect(confirm.suggestedMandatePayees).toEqual([]);
  });

  it("a placeholder payee is unpayable: refused by the rules even long after creation, and cannot be verified", async () => {
    const { userId } = await onboard();
    const bill = (await t.db().select().from(obligations).where(eq(obligations.userId, userId))).find((o) => o.category === "tuition")!;
    const propose = () => proposeOrder({ userId, createdBy: "USER", payeeId: bill.payeeId, amountMinor: bill.amountMinor, currency: bill.currency, purpose: "Tuition", obligationId: bill.id });
    const now = await propose();
    expect(now.decision).toBe("REFUSE");
    expect(now.reasonCodes).toEqual(expect.arrayContaining(["REFUSE_UNVERIFIED_PAYEE", "PAYEE_ACCOUNT_MISSING"]));
    const stored = (await t.db().select().from(proposals).where(eq(proposals.id, now.proposalId)))[0]!;
    expect(stored.canonicalOrder).toBeNull();
    expect(stored.orderHash).toBeNull();

    clock.setOffsetInMemoryForTests(30 * DAY_MS);
    const later = await propose();
    expect(later.decision).toBe("REFUSE");
    expect(later.reasonCodes).toContain("PAYEE_ACCOUNT_MISSING");
    await expect(verifyCallback(userId, bill.payeeId)).rejects.toMatchObject({ status: 409, code: "PAYEE_ACCOUNT_MISSING" });
    const p = (await t.db().select().from(payees).where(eq(payees.id, bill.payeeId)))[0]!;
    expect(p.status).toBe("COOLING");
  });

  it("re-uses an existing payee of the same name and kind instead of duplicating it", async () => {
    const twice: OnboardingProfileDraft = { ...DRAFT, obligations: [DRAFT.obligations[0]!, { ...DRAFT.obligations[0]!, dueDate: "2026-12-01" }] };
    const { userId } = await onboard(twice);
    expect(await t.db().select().from(payees).where(eq(payees.userId, userId))).toHaveLength(1);
    expect(await t.db().select().from(obligations).where(eq(obligations.userId, userId))).toHaveLength(2);
  });
  it("review-sheet planner edits: added budgets and a new monthly salary are signed and applied", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const h = await bearer(userId);
    const conversationId = randomUUID();
    await t.db().insert(onboardingDrafts).values({ conversationId, userId, draft: DRAFT, complete: true, updatedAt: clock.now() });
    const payload = {
      conversationId,
      budgets: [{ category: "groceries", limitHomeMinor: 8_000_000 }],
      // "groceries" is already in the draft: the added copy is dropped, the edit above wins.
      addedBudgets: [{ category: "eating_out", limitHomeMinor: 3_000_000 }, { category: "groceries", limitHomeMinor: 1 }],
      monthlyIncomeMinor: 70_000_000,
    };
    const opt = (await app().inject({ method: "POST", url: "/api/onboarding/confirm/options", headers: h, payload })).json();
    expect(opt.draft.budgets).toEqual([
      { category: "groceries", limitHomeMinor: 8_000_000 },
      { category: "eating_out", limitHomeMinor: 3_000_000 },
    ]);
    expect(opt.draft.incomes[0]).toMatchObject({ source: "Parents", amountMinor: 70_000_000, cadence: "MONTHLY" });
    // The planner's basis in KZT: the new salary, and the HUF rent plus the EUR term bills spread per month.
    expect(opt.planBasis.monthlyIncomeMinor).toBe(70_000_000);
    expect(opt.planBasis.fixedMonthlyMinor).toBeGreaterThan(0);
    const res = await app().inject({ method: "POST", url: "/api/onboarding/confirm", headers: h, payload: { conversationId, challengeId: opt.challengeId, core: opt.core, assertion: auth.assert(opt.rulesHash) } });
    expect(res.statusCode, res.body).toBe(200);
    const budgets = (await app().inject({ method: "GET", url: "/api/budgets", headers: h })).json().budgets as Array<{ category: string; limitHomeMinor: number }>;
    expect(Object.fromEntries(budgets.map((b) => [b.category, b.limitHomeMinor]))).toEqual({ groceries: 8_000_000, eating_out: 3_000_000 });
  });
});
