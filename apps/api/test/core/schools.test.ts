/* "Find your school" (2026-10-15): the directory, adding a school as a tuition recipient with its open invoice as a
 * bill, reusing a recipient added by hand, and the school portal's signed "payment received" notice, which only ever
 * speaks about a payment Kassa actually sent. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { IDS, TUITION_REFERENCE } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, notifications, obligations, payees, payments, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { deliverWebhooks, postSignedWebhook, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld | null = null;

async function seedDana(): Promise<SoftAuthenticator> {
  await seedDatabase(getDb(), await loadSeedData(), { reset: true });
  const auth = new SoftAuthenticator();
  const row = { userId: IDS.user, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  return auth;
}

const get = async (url: string) => app().inject({ method: "GET", url, headers: await bearer(IDS.user) });
const post = async (url: string, payload?: unknown) => app().inject({ method: "POST", url, headers: await bearer(IDS.user), ...(payload !== undefined ? { payload: payload as object } : {}) });

async function linkCard(auth: SoftAuthenticator, currency: string): Promise<string> {
  const start = (await post("/api/funding-sources/card/start", { testCard: "VISA", currency })).json();
  const gate = (await post(`/api/funding-sources/${start.source.id}/confirm`, {})).json();
  const res = await post(`/api/funding-sources/${start.source.id}/confirm`, { challengeId: gate.details.challengeId, assertion: auth.assert(gate.details.webauthnOptions.challenge) });
  expect(res.statusCode).toBe(200);
  return res.json().id;
}

describe("find your school", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setBalanceProviderForTests(null);
    setRailOverridesForTests({});
    await mw?.close();
    mw = await startMockWorld({ env: { MOCK_BANK_INSTANT: "true" } });
  });
  afterAll(async () => {
    await mw?.close();
  });

  it("searches the directory without exposing the schools' accounts", async () => {
    await seedDana();
    const res = await get("/api/schools?q=vienna");
    expect(res.statusCode).toBe(200);
    expect(res.json().schools).toEqual([{ id: "vienna", name: "Music Academy in Vienna", city: "Vienna", country: "AT", currency: "EUR", simulated: true }]);
    expect((await get("/api/schools")).json().schools).toHaveLength(4);
    expect((await post("/api/schools/nowhere/lookup", { studentId: "S1234567" })).statusCode).toBe(404);
    expect((await post("/api/schools/vienna/lookup", { studentId: "no" })).statusCode).toBe(400);
  });

  it("adds a school with its open invoice as a bill, once", async () => {
    await seedDana();
    const look = (await post("/api/schools/vienna/lookup", { studentId: "s1234567" })).json();
    expect(look.existingPayeeId).toBeNull();
    expect(look.invoices).toHaveLength(1);
    const inv = look.invoices[0];
    expect(inv).toMatchObject({ studentId: "S1234567", currency: "EUR", status: "OPEN", term: "Winter 2026" });

    const res = await post("/api/schools/vienna/link", { studentId: "S1234567" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Added from the directory, but still a new recipient: it cools like any other (I7).
    expect(body.payee).toMatchObject({ name: "Music Academy in Vienna", kind: "UNIVERSITY", category: "TUITION", status: "COOLING", currency: "EUR", details: { studentId: "S1234567", portalSchoolId: "vienna", term: "Winter 2026" } });
    expect(body.payee.portalLink).toBe("http://localhost:4001/mock/schools/vienna/portal?studentId=S1234567");
    expect(body.createdObligationIds).toHaveLength(1);
    const bill = (await getDb().select().from(obligations).where(eq(obligations.id, body.createdObligationIds[0])))[0]!;
    expect(bill).toMatchObject({ payeeId: body.payee.id, amountMinor: inv.amountMinor, currency: "EUR", dueDate: inv.dueDate, recurrence: "ONCE", reference: inv.reference, category: "tuition" });

    const again = (await post("/api/schools/vienna/link", { studentId: "S1234567" })).json();
    expect(again.payee.id).toBe(body.payee.id);
    expect(again.createdObligationIds).toEqual([]);
    expect((await post(`/api/payees/${body.payee.id}/school-invoices`)).json().createdObligationIds).toEqual([]);
    expect((await post("/api/schools/vienna/lookup", { studentId: "S1234567" })).json().existingPayeeId).toBe(body.payee.id);
  });

  it("recognises the tuition recipient Dana added by hand and does not import her bill twice", async () => {
    await seedDana();
    await getDb()
      .update(payees)
      .set({ detailsEnc: null })
      .where(eq(payees.id, IDS.payees.university));
    // Without a student ID there is nothing to match on: a new recipient would be made, so give it one first.
    const patch = await app().inject({ method: "PATCH", url: `/api/payees/${IDS.payees.university}`, headers: await bearer(IDS.user), payload: { details: { category: "TUITION", studentId: "KZ26-0417" } } });
    expect(patch.json().portalLink).toBeNull();
    const look = (await post("/api/schools/budapest/lookup", { studentId: "KZ26-0417" })).json();
    expect(look.existingPayeeId).toBe(IDS.payees.university);
    expect(look.invoices[0]).toMatchObject({ amountMinor: 240_000, reference: TUITION_REFERENCE });
    const linked = (await post("/api/schools/budapest/link", { studentId: "KZ26-0417" })).json();
    expect(linked.payee).toMatchObject({ id: IDS.payees.university, status: "VERIFIED", details: { portalSchoolId: "budapest", term: "Fall 2026" } });
    expect(linked.createdObligationIds).toEqual([]);
  });

  it("pays a bill now, once: the order settles the bill like the scheduler's would", async () => {
    const auth = await seedDana();
    const card = await linkCard(auth, "EUR");
    const res = await post(`/api/obligations/${IDS.obligations.tuition}/pay`, { fundingSourceId: card });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe("ASK");
    const view = await getOrderView(IDS.user, res.json().proposalId);
    expect(view.canonicalOrder).toMatchObject({ amountMinor: 240_000, currency: "EUR", purpose: `tuition ${TUITION_REFERENCE}` });
    const again = await post(`/api/obligations/${IDS.obligations.tuition}/pay`, {});
    expect(again.json()).toMatchObject({ decision: "REFUSE", reasonCodes: ["DUPLICATE_OBLIGATION_PAYMENT"] });
    expect((await post(`/api/obligations/${crypto.randomUUID()}/pay`, {})).statusCode).toBe(404);
  });

  it("refreshing a recipient that is not from the directory is refused", async () => {
    await seedDana();
    const res = await post(`/api/payees/${IDS.payees.landlord}/school-invoices`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("NOT_FROM_SCHOOL_DIRECTORY");
  });

  it("the portal books the tuition payment and tells Kassa; forged notices change nothing", async () => {
    const auth = await seedDana();
    const card = await linkCard(auth, "EUR");
    const pay = await post(`/api/payees/${IDS.payees.university}/pay`, { amountMinor: 240_000, currency: "EUR", purpose: `tuition ${TUITION_REFERENCE}`, fundingSourceId: card });
    expect(pay.statusCode).toBe(200);
    const view = await getOrderView(IDS.user, pay.json().proposalId);
    const approved = await approveOrder(IDS.user, view.canonicalOrder.proposalId, auth.assert(view.orderHash));
    expect(approved.paymentStatus).toBe("SENT");

    const portal = (await mw!.app.inject({ url: "/mock/schools/budapest/invoices?studentId=KZ26-0417" })).json();
    expect(portal.invoices[0]).toMatchObject({ status: "PAID", paidMinor: 240_000 });

    const delivered = await deliverWebhooks(mw!, app());
    const school = delivered.find((d) => d.kind === "school")!;
    expect(school.statusCode).toBe(200);
    expect(school.json).toMatchObject({ matched: true, changed: true });
    const payment = (await getDb().select().from(payments).where(eq(payments.proposalId, view.canonicalOrder.proposalId)))[0]!;
    expect(payment.details).toMatchObject({ schoolReceipt: { schoolId: "budapest", status: "PAID", paidMinor: 240_000 } });
    expect(await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "SCHOOL_PAYMENT_RECEIVED"))).toHaveLength(1);
    const note = await getDb().select().from(notifications).where(and(eq(notifications.userId, IDS.user), eq(notifications.kind, "SCHOOL_PAYMENT_RECEIVED")));
    expect(note[0]?.title).toBe("University in Budapest received your tuition");

    // The same notice again (a new delivery, so not a replay) changes nothing.
    const body = school.body as Record<string, unknown>;
    expect((await postSignedWebhook(app(), "school", { ...body, eventId: "again" })).json()).toMatchObject({ matched: true, changed: false });
    // A notice about a transfer Kassa never sent is only logged.
    expect((await postSignedWebhook(app(), "school", { ...body, eventId: "x1", customerTransactionId: crypto.randomUUID() })).json()).toMatchObject({ matched: false });
    // A notice claiming a different amount for our transfer is refused.
    const wrong = await postSignedWebhook(app(), "school", { ...body, eventId: "x2", amountMinor: 1 });
    expect(wrong.statusCode).toBe(409);
    // Unsigned: refused before anything is read.
    expect((await app().inject({ method: "POST", url: "/api/webhooks/mock/school", payload: body })).statusCode).toBe(401);
  });
});
