/*
 * (2026-10-19) The bank reference is built from structured data, never cut from the planner's purpose
 * (rails/reference.ts). A judge copy's 23-character invoice reference used to be cut at 35 characters of the purpose
 * ("Tuition term fee RF43RUB2026F042171"), so the school never matched the payment. End to end against the mock
 * school with a judge-copy reference: the invoice is booked PAID and Kassa is told.
 */
import { buildRfReference, suggestedReference } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { judgeCopyReference, judgeCopyStudentId, judgeCopySuffix } from "../../../../fixtures/judge-copy.ts";
import { IDS, TUITION_REFERENCE } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { obligations, payees, payments, profiles, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { withReference } from "../../src/modules/agent/tools.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { readDetails } from "../../src/modules/payees/crypto.ts";
import { BANK_REFERENCE_MAX, buildBankReference, rfReferencesIn } from "../../src/modules/rails/reference.ts";
import { mockWorld } from "../../src/modules/rails/http.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

describe("buildBankReference", () => {
  const ref23 = judgeCopyReference(TUITION_REFERENCE, "1B6409");

  it("puts the bill's reference first, whole, and fills the rest from the purpose", () => {
    expect(ref23).toHaveLength(23);
    const purpose = `Tuition term fee ${ref23} · Tuition KZ26-0417-1B6409 Fall 2026`;
    const r = buildBankReference([ref23, "KZ26-0417-1B6409"], purpose);
    expect(r.startsWith(ref23)).toBe(true);
    expect(r.length).toBeLessThanOrEqual(BANK_REFERENCE_MAX);
    // The student ID (16) does not fit after the reference: skipped whole, never cut.
    expect(r).not.toContain("KZ26");
    expect(r).toBe(`${ref23} Tuition`);
  });

  it("keeps both identifiers when they fit, and never repeats one the purpose also holds", () => {
    expect(buildBankReference([TUITION_REFERENCE, "KZ26-0417"], `tuition ${TUITION_REFERENCE}`)).toBe(`${TUITION_REFERENCE} KZ26-0417 tuition`);
    expect(buildBankReference(["HF-APT4B-RENT"], "Rent October · Rent HF-APT4B-RENT")).toBe("HF-APT4B-RENT Rent October · Rent");
  });

  it("without structured data, the purpose cut at a word boundary", () => {
    expect(buildBankReference([], "Dinner with friends at the lake house last Saturday")).toBe("Dinner with friends at the lake");
    expect(buildBankReference([null, ""], "Gift")).toBe("Gift");
  });

  it("only a first part longer than the limit is ever cut", () => {
    const long = "A".repeat(50);
    expect(buildBankReference([long, "X1"], "p")).toBe("A".repeat(35));
  });

  it("finds ISO 11649 references in free text only with valid check digits", () => {
    const valid = buildRfReference("539007547034");
    expect(rfReferencesIn(`pay ${valid} now`)).toEqual([valid]);
    expect(rfReferencesIn(`pay ${valid.slice(0, -1)}9 now`)).toEqual([]);
    expect(rfReferencesIn(`Tuition term fee ${ref23} · x`)).toEqual([ref23]);
    // Printed in groups of four.
    expect(rfReferencesIn(valid.replace(/(.{4})/g, "$1 ").trim())).toEqual([valid]);
  });
});

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld | null = null;

describe("judge-copy tuition reaches the school whole (end to end)", () => {
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

  async function seedJudgeCopyIdentifiers() {
    await seedDatabase(getDb(), await loadSeedData(), { reset: true });
    const auth = new SoftAuthenticator();
    const row = { userId: IDS.user, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
    await getDb().insert(webauthnCredentialsRules).values(row);
    await getDb().insert(webauthnCredentialsPayments).values(row);
    // What auth/demoClaim.ts ownSchoolIdentifiers gives a judge copy: its own student ID and invoice reference.
    const copyOf = "6f1d7c4e-1111-4222-8333-944455556666";
    const studentId = judgeCopyStudentId("KZ26-0417", copyOf);
    const reference = judgeCopyReference(TUITION_REFERENCE, judgeCopySuffix(copyOf));
    const patch = await app().inject({ method: "PATCH", url: `/api/payees/${IDS.payees.university}`, headers: await bearer(IDS.user), payload: { details: { category: "TUITION", studentId, term: "Fall 2026" } } });
    expect(patch.statusCode, patch.body).toBe(200);
    await getDb().update(obligations).set({ reference }).where(eq(obligations.id, IDS.obligations.tuition));
    return { auth, studentId, reference };
  }

  /** EUR in the wallet for the tuition (a test top-up in the mock bank), so the order is a plain bank transfer. */
  async function fundEur(): Promise<void> {
    const profileId = (await getDb().select({ id: profiles.bankProfileId }).from(profiles).where(eq(profiles.userId, IDS.user)))[0]!.id!;
    await mockWorld("POST", "/bank/top-ups", { profileId, currency: "EUR", amountMinor: 500_000, reference: `test-eur-${randomUUID()}` });
  }

  it("the planner's long purpose no longer cuts the 23-character reference; the school books the invoice PAID", async () => {
    const { auth, studentId, reference } = await seedJudgeCopyIdentifiers();
    expect(reference).toHaveLength(23);
    const payee = (await getDb().select().from(payees).where(eq(payees.id, IDS.payees.university)))[0]!;
    // Exactly what propose_order sends: the model's purpose plus the payee's suggested reference (agent/tools.ts).
    const purpose = withReference(`Tuition term fee ${reference}`, suggestedReference(readDetails(payee)));
    expect(purpose.slice(0, 35)).not.toContain(reference); // the old reference: cut
    await fundEur();
    const r = await proposeOrder({ userId: IDS.user, createdBy: "AGENT", payeeId: IDS.payees.university, amountMinor: 240_000, currency: "EUR", purpose, category: "tuition", obligationId: IDS.obligations.tuition });
    expect(r.decision, JSON.stringify(r)).toBe("ASK");
    const view = await getOrderView(IDS.user, r.proposalId);
    const approved = await approveOrder(IDS.user, r.proposalId, auth.assert(view.orderHash));
    expect(approved.paymentStatus).toBe("SENT");

    const portal = (await mw!.app.inject({ url: `/mock/schools/budapest/invoices?studentId=${studentId}` })).json();
    expect(portal.invoices[0]).toMatchObject({ reference, status: "PAID", paidMinor: 240_000 });
    const unmatched = (await mw!.app.inject({ url: "/mock/schools/budapest/portal" })).body;
    expect(unmatched).not.toContain("Tuition term fee RF");

    const delivered = await deliverWebhooks(mw!, app());
    const school = delivered.find((d) => d.kind === "school")!;
    expect(school.json).toMatchObject({ matched: true, changed: true });
    const payment = (await getDb().select().from(payments).where(eq(payments.proposalId, r.proposalId)))[0]!;
    expect(payment.details).toMatchObject({ schoolReceipt: { schoolId: "budapest", status: "PAID" } });
  });

  it("an order not linked to the bill still sends the RF reference it names first", async () => {
    const { auth, studentId, reference } = await seedJudgeCopyIdentifiers();
    await fundEur();
    const r = await proposeOrder({ userId: IDS.user, createdBy: "AGENT", payeeId: IDS.payees.university, amountMinor: 240_000, currency: "EUR", purpose: `Tuition for the autumn term, invoice ${reference}`, category: "tuition" });
    const view = await getOrderView(IDS.user, r.proposalId);
    expect((await approveOrder(IDS.user, r.proposalId, auth.assert(view.orderHash))).paymentStatus).toBe("SENT");
    const portal = (await mw!.app.inject({ url: `/mock/schools/budapest/invoices?studentId=${studentId}` })).json();
    expect(portal.invoices[0]).toMatchObject({ reference, status: "PAID" });
  });
});
