/*
 * Credit record v2/v3 (security review 2026-10-18; v3 2026-10-19, test/security/credit-record-v3.test.ts): only evidenced figures are signed, only for the selected items.
 * The period is clamped to [account opened, today]; income months come from money Kassa saw arrive, not from the
 * declared profile income; bills are the obligation periods that fell due, and refused duplicate proposals do not count.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { obligations, payments, profiles } from "../../src/db/schema.ts";
import { pdfLines } from "../../src/modules/credit-record/routes.ts";
import { clock, DAY_MS, isoDate } from "../../src/modules/clock/index.ts";
import { addDays } from "../../src/modules/fx/dates.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { updatePaymentStatus } from "../../src/modules/payments/status.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

beforeEach(async () => {
  await t.reset();
  offlineEnvironment();
  clock.setOffsetInMemoryForTests(0);
});

async function exportRecord(userId: string, payload: Record<string, unknown>) {
  const res = await app().inject({ method: "POST", url: "/api/credit-record/export", headers: await bearer(userId), payload });
  return res;
}

async function verify(verifyId: string) {
  const res = await app().inject({ method: "GET", url: `/api/public/verify/${verifyId}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

describe("credit record v2", () => {
  it("a minutes-old account cannot sign 26 years of history: the period is clamped and says so", async () => {
    const { userId } = await createUserWithPasskey();
    // Declared monthly income: no longer evidence.
    await getDb()
      .update(profiles)
      .set({ incomes: [{ source: "Parents", currency: "KZT", amountMinor: 30_000_000, cadence: "MONTHLY", nextDate: null }] as never })
      .where(eq(profiles.userId, userId));
    const res = await exportRecord(userId, { from: "2000-01-01", to: "2099-12-31", items: ["BILLS"] });
    expect(res.statusCode, res.body).toBe(200);
    const v = await verify(res.json().verifyId);
    const today = isoDate(clock.now());
    expect(v).toMatchObject({ valid: true, version: 3, period: { from: today, to: today }, requestedPeriod: { from: "2000-01-01", to: "2099-12-31" }, accountOpenedOn: today, items: ["BILLS"] });
    // Only the selected item's figures, plus the period length.
    expect(v.summary).toEqual({ monthsCovered: 1, billsTotal: 0, billsPaidOnTime: 0 });

    const withIncome = await exportRecord(userId, { from: "2000-01-01", to: "2099-12-31", items: ["INCOME"] });
    const vi = await verify(withIncome.json().verifyId);
    expect(vi.summary).toEqual({ monthsCovered: 1, incomeMonths: 0 });
  });

  it("refuses a period that ends before the account was opened", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await exportRecord(userId, { from: "2000-01-01", to: "2000-12-31", items: ["BILLS"] });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("PERIOD_OUTSIDE_ACCOUNT");
  });

  it("counts income months from money that arrived, per calendar month", async () => {
    const { userId } = await createUserWithPasskey();
    await ledger.append("TRIGGER_REMITTANCE", { userId, eventId: "e1" });
    await ledger.append("WALLET_RECEIVED", { userId, eventId: "e2", amountMinor: 100, currency: "KZT" });
    // Someone else's money and a self top-up are not this user's income.
    await ledger.append("TRIGGER_REMITTANCE", { userId: null, eventId: "e3" });
    await ledger.append("WALLET_TOPUP", { userId, homeAmountMinor: 100 });
    const today = isoDate(clock.now());
    const res = await exportRecord(userId, { from: "2000-01-01", to: today, items: ["INCOME", "BILLS"] });
    const v = await verify(res.json().verifyId);
    expect(v.summary.incomeMonths).toBe(1);
    expect(v.items).toEqual(["BILLS", "INCOME"]);
  });

  it("bills: due periods only, paid by the due day; a refused duplicate does not count", async () => {
    const { userId, auth } = await createUserWithPasskey();
    await signBaseRules(userId, auth);
    const uni = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" });
    const today = isoDate(clock.now());
    const [paidBill, missedBill] = await getDb()
      .insert(obligations)
      .values([
        { userId, payeeId: uni.id, amountMinor: 240_000, currency: "EUR", dueDate: addDays(today, 4), recurrence: "TERM", reference: "RF39RUB2026F04217", category: "tuition" },
        { userId, payeeId: uni.id, amountMinor: 10_000, currency: "EUR", dueDate: addDays(today, 2), recurrence: "TERM", reference: "FEE", category: "tuition" },
      ])
      .returning();
    const propose = () =>
      proposeOrder({ userId, createdBy: "AGENT", payeeId: uni.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition", category: "tuition", obligationId: paidBill!.id, dueDate: paidBill!.dueDate });
    const r = await propose();
    const view = await getOrderView(userId, r.proposalId);
    await approveOrder(userId, r.proposalId, auth.assert(view.orderHash));
    const pay = (await getDb().select().from(payments).where(eq(payments.proposalId, r.proposalId)))[0]!;
    await updatePaymentStatus(pay.id, "SENT", { source: "test" });
    expect((await propose()).decision).toBe("REFUSE");

    // Before the due dates: the period ends today. The tuition paid early counts (sent today, due in 4 days: on time,
    // 2026-10-19); the fee has not fallen due yet.
    let v = await verify((await exportRecord(userId, { from: today, to: addDays(today, 30), items: ["BILLS"] })).json().verifyId);
    expect(v.summary).toMatchObject({ billsTotal: 1, billsPaidOnTime: 1 });
    expect(v.period.to).toBe(today);

    // After both due dates the missed fee counts too, not on time.
    clock.setOffsetInMemoryForTests(5 * DAY_MS);
    const later = isoDate(clock.now());
    v = await verify((await exportRecord(userId, { from: today, to: later, items: ["BILLS"] })).json().verifyId);
    expect(v.summary).toEqual({ monthsCovered: v.summary.monthsCovered, billsTotal: 2, billsPaidOnTime: 1 });
    expect(missedBill).toBeTruthy();
  });

  it("the PDF prints only the selected items and the clamp", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await exportRecord(userId, { from: "2000-01-01", to: "2099-12-31", items: ["INCOME"] });
    const json = await app().inject({ method: "GET", url: `/api/public/credit-record/${res.json().verifyId}.json` });
    const { bundle, sha256, keyId } = json.json();
    const lines = pdfLines(bundle, sha256, keyId).join("\n");
    expect(lines).toContain("Months with money received (recorded by Kassa): 0");
    expect(lines).toContain("Requested: 2000-01-01 to 2099-12-31");
    expect(lines).not.toContain("Bills");
    const pdf = await app().inject({ method: "GET", url: `/api/public/credit-record/${res.json().verifyId}.pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.body).not.toContain("Bills paid");
  });
});
