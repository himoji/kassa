/* Recipients (2026-10-15): categories and details per payee, editing details without a new cooling period, removing a
 * recipient, and bills the user schedules themselves. */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { obligations, payees, proposals } from "../../src/db/schema.ts";
import { withReference } from "../../src/modules/agent/tools.ts";
import { clock, isoDate } from "../../src/modules/clock/index.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addObligation, addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();

const tuition = { category: "TUITION", studentId: "S1234567", portalUrl: "https://pay.example-university.test/kassa", term: "Fall 2026" } as const;

async function create(userId: string, payload: Record<string, unknown>) {
  return app().inject({ method: "POST", url: "/api/payees", headers: await bearer(userId), payload });
}

describe("recipients", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.setOffsetInMemoryForTests(0);
  });

  it("a recipient carries its category and details, encrypted at rest", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await create(userId, { name: "Budapest University", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, country: "HU", currency: "EUR", details: tuition });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ category: "TUITION", details: tuition, status: "COOLING" });
    const row = (await getDb().select().from(payees).where(eq(payees.id, res.json().id)))[0]!;
    expect(row.detailsEnc).not.toContain("S1234567");

    const list = (await app().inject({ method: "GET", url: "/api/payees", headers: await bearer(userId) })).json();
    expect(list.payees[0]).toMatchObject({ category: "TUITION", details: { studentId: "S1234567" } });
  });

  it("details must belong to the recipient's category", async () => {
    const { userId } = await createUserWithPasskey();
    const res = await create(userId, { name: "Mum", kind: "PERSON", account: IBAN_UNIVERSITY, country: "HU", currency: "HUF", details: tuition });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("DETAILS_CATEGORY_MISMATCH");
    const insurer = await create(userId, { name: "Insurer", kind: "INSURER", account: IBAN_UNIVERSITY, country: "HU", currency: "HUF", details: { category: "BILLS", billType: "UTILITIES", customerNumber: "C-1" } });
    expect(insurer.json().code).toBe("DETAILS_CATEGORY_MISMATCH");
  });

  it("a utility biller is a BILLS recipient whose orders count as utilities", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const res = await create(userId, { name: "City Power", kind: "BILLER", account: IBAN_UNIVERSITY, country: "HU", currency: "HUF", details: { category: "BILLS", billType: "UTILITIES", customerNumber: "778899" } });
    expect(res.json()).toMatchObject({ kind: "BILLER", category: "BILLS" });
    clock.setOffsetInMemoryForTests(24 * 3_600_000 + 1000);
    await signBaseRules(userId, auth);
    const r = await proposeOrder({ userId, createdBy: "USER", payeeId: res.json().id, amountMinor: 1_200_000, currency: "HUF", purpose: "Electricity" });
    const row = (await getDb().select().from(proposals).where(eq(proposals.id, r.proposalId)))[0]!;
    expect(row.category).toBe("utilities");
  });

  it("editing details does not restart the cooling period or touch the account", async () => {
    const { userId } = await createUserWithPasskey();
    const p = await addPayee(userId, { name: "Budapest University", kind: "UNIVERSITY", account: IBAN_UNIVERSITY });
    const before = (await getDb().select().from(payees).where(eq(payees.id, p.id)))[0]!;
    const res = await app().inject({ method: "PATCH", url: `/api/payees/${p.id}`, headers: await bearer(userId), payload: { details: { ...tuition, term: "Spring 2027" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "VERIFIED", details: { term: "Spring 2027" } });
    const after = (await getDb().select().from(payees).where(eq(payees.id, p.id)))[0]!;
    expect(after.accountHash).toBe(before.accountHash);
    expect(after.status).toBe("VERIFIED");

    const wrong = await app().inject({ method: "PATCH", url: `/api/payees/${p.id}`, headers: await bearer(userId), payload: { details: { category: "RENT" } } });
    expect(wrong.statusCode).toBe(422);
    // Someone else's recipient is not found.
    const other = await createUserWithPasskey();
    const foreign = await app().inject({ method: "PATCH", url: `/api/payees/${p.id}`, headers: await bearer(other.userId), payload: { details: null } });
    expect(foreign.statusCode).toBe(404);
  });

  it("a removed recipient disappears and can no longer be paid, even by an order drafted before", async () => {
    // No signed base rules: the order waits for the passkey instead of going through on its own.
    const { userId, auth } = await createUserWithPasskey();
    const p = await addPayee(userId, { name: "Old flatmate", kind: "PERSON" });
    const drafted = await proposeOrder({ userId, createdBy: "USER", payeeId: p.id, amountMinor: 500_000, currency: "HUF", purpose: "Share of bills" });
    const view = await getOrderView(userId, drafted.proposalId);

    const del = await app().inject({ method: "DELETE", url: `/api/payees/${p.id}`, headers: await bearer(userId) });
    expect(del.statusCode).toBe(204);
    const list = (await app().inject({ method: "GET", url: "/api/payees", headers: await bearer(userId) })).json();
    expect(list.payees).toHaveLength(0);

    const again = await proposeOrder({ userId, createdBy: "USER", payeeId: p.id, amountMinor: 500_000, currency: "HUF", purpose: "Share of bills" });
    expect(again.decision).toBe("REFUSE");
    await expect(approveOrder(userId, drafted.proposalId, auth.assert(view.orderHash))).rejects.toMatchObject({ code: "REFUSE_UNVERIFIED_PAYEE" });
  });

  it("a recipient with bills cannot be removed until its bills are", async () => {
    const { userId } = await createUserWithPasskey();
    const p = await addPayee(userId, { name: "Landlord in Budapest" });
    const o = await addObligation(userId, p.id);
    const del = await app().inject({ method: "DELETE", url: `/api/payees/${p.id}`, headers: await bearer(userId) });
    expect(del.statusCode).toBe(409);
    expect(del.json().code).toBe("PAYEE_HAS_BILLS");
    expect((await app().inject({ method: "DELETE", url: `/api/obligations/${o.id}`, headers: await bearer(userId) })).statusCode).toBe(204);
    expect((await app().inject({ method: "DELETE", url: `/api/payees/${p.id}`, headers: await bearer(userId) })).statusCode).toBe(204);
  });

  it("a user-made schedule gets its category from the recipient, not the caller", async () => {
    const { userId } = await createUserWithPasskey();
    const helper = await create(userId, { name: "Aigerim", kind: "PERSON", account: IBAN_UNIVERSITY, country: "HU", currency: "HUF", details: { category: "PEOPLE", relationship: "EMPLOYEE", note: "Wages" } });
    const due = isoDate(new Date(clock.now().getTime() + 10 * 86_400_000));
    const res = await app().inject({
      method: "POST",
      url: "/api/obligations",
      headers: await bearer(userId),
      payload: { payeeId: helper.json().id, amountMinor: 15_000_000, currency: "HUF", dueDate: due, recurrence: "MONTHLY", reference: "Wages" },
    });
    expect(res.statusCode).toBe(201);
    const row = (await getDb().select().from(obligations).where(eq(obligations.id, res.json().id)))[0]!;
    expect(row).toMatchObject({ category: "wages", recurrence: "MONTHLY", dueDate: due });

    const wrongCurrency = await app().inject({ method: "POST", url: "/api/obligations", headers: await bearer(userId), payload: { payeeId: helper.json().id, amountMinor: 100, currency: "EUR", dueDate: due, recurrence: "ONCE" } });
    expect(wrongCurrency.json().code).toBe("CURRENCY_MISMATCH");
    const past = await app().inject({ method: "POST", url: "/api/obligations", headers: await bearer(userId), payload: { payeeId: helper.json().id, amountMinor: 100, currency: "HUF", dueDate: "2000-01-01", recurrence: "ONCE" } });
    expect(past.json().code).toBe("DUE_DATE_PAST");
  });

  it("the agent's purpose gets the recipient's reference once", () => {
    expect(withReference("Tuition for the fall term", "Tuition S1234567 Fall 2026")).toBe("Tuition for the fall term · Tuition S1234567 Fall 2026");
    expect(withReference("Pay tuition s1234567", "S1234567")).toBe("Pay tuition s1234567");
    expect(withReference("Rent", undefined)).toBe("Rent");
  });
});
