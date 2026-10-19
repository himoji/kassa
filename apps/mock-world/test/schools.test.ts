/*
 * School payment portals: the directory, a student's invoice (seeded or generated once, deterministically), and
 * payments booked from the mock bank's payouts: matched by the invoice reference (signed "school" webhook), or kept
 * as unmatched without one. The portal page renders for a student.
 * (2026-10-19) Invoices only for the student: their date of birth (with a per-student limit on wrong ones) or a Kassa
 * portal link; on a deployed build the plain GET answers only Kassa's signed request.
 */
import { randomUUID } from "node:crypto";

import { DEMO_TOKEN_HEADER, isValidIban, isValidRfReference, MOCK_REQUEST_AUTH_HEADER, mockRequestAuth, schoolPortalAccess } from "@kassa/shared";
import { afterAll, describe, expect, it } from "vitest";

import { buildMockWorld, type MockWorld } from "../src/app.ts";
import { StaticRates } from "../src/bank/rates.ts";
import { ManualClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { DOB_MAX_FAILURES, SCHOOLS, studentDateOfBirth } from "../src/school/schools.ts";
import { RecordingSink } from "../src/webhooks.ts";
import { DANA_DATE_OF_BIRTH, MOCK_BANK_PROFILE_ID, TUITION_REFERENCE } from "../../../fixtures/seed-data.ts";
import { judgeCopyStudentId } from "../../../fixtures/judge-copy.ts";

const clock = new ManualClock(Date.parse("2026-10-27T18:00:00Z"));
const worlds: MockWorld[] = [];

const SECRET = "s3cret";

async function world(env: Record<string, string> = {}) {
  const sink = new RecordingSink();
  const w = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", MOCK_HMAC_SECRET: SECRET, MOCK_BANK_INSTANT: "true", ...env } as NodeJS.ProcessEnv),
    clock,
    webhooks: sink,
    rates: new StaticRates(),
    logger: false,
    startTicker: false,
  });
  worlds.push(w);
  return { w, sink };
}
afterAll(async () => {
  for (const w of worlds) await w.app.close();
});

async function payToSchool(w: MockWorld, schoolId: string, amountMinor: number, reference: string) {
  const s = SCHOOLS[schoolId]!;
  await w.bank.topUp(MOCK_BANK_PROFILE_ID, s.currency, amountMinor * 2, randomUUID());
  const quote = await w.bank.createQuote(MOCK_BANK_PROFILE_ID, { sourceCurrency: s.currency, targetCurrency: s.currency, targetAmountMinor: amountMinor });
  const recipient = await w.bank.createRecipient({ currency: s.currency, profile: MOCK_BANK_PROFILE_ID, accountHolderName: s.name, legalType: "BUSINESS", iban: s.iban });
  const { transfer } = await w.bank.createTransfer({ targetAccount: recipient.id, quoteUuid: quote.id, customerTransactionId: randomUUID(), reference, instant: true });
  await w.bank.fund(MOCK_BANK_PROFILE_ID, transfer.id);
  return transfer;
}

describe("school portals", () => {
  it("lists and searches the directory; every school has a valid IBAN", async () => {
    const { w } = await world();
    const all = (await w.app.inject({ url: "/mock/schools" })).json() as { schools: { id: string; account: { iban: string } }[] };
    expect(all.schools.map((s) => s.id)).toEqual(["budapest", "debrecen", "vienna", "almaty"]);
    for (const s of all.schools) expect(isValidIban(s.account.iban)).toBe(true);
    const found = (await w.app.inject({ url: "/mock/schools?q=almaty" })).json() as { schools: { id: string }[] };
    expect(found.schools.map((s) => s.id)).toEqual(["almaty"]);
    expect((await w.app.inject({ url: "/mock/schools/nowhere/invoices?studentId=AB12" })).statusCode).toBe(404);
    expect((await w.app.inject({ url: "/mock/schools/budapest/invoices?studentId=a" })).statusCode).toBe(422);
  });

  it("knows the seeded student's invoice and generates the same invoice for a new student every time", async () => {
    const { w } = await world();
    const seeded = (await w.app.inject({ url: "/mock/schools/budapest/invoices?studentId=kz26-0417" })).json() as { invoices: { amountMinor: number; reference: string; dueDate: string }[] };
    expect(seeded.invoices[0]).toMatchObject({ amountMinor: 240_000, reference: TUITION_REFERENCE, dueDate: "2026-10-31" });
    const a = (await w.app.inject({ url: "/mock/schools/vienna/invoices?studentId=S1234567" })).json() as { invoices: { amountMinor: number; reference: string }[] };
    const { w: w2 } = await world();
    const b = (await w2.app.inject({ url: "/mock/schools/vienna/invoices?studentId=S1234567" })).json() as typeof a;
    expect(a.invoices[0]!.amountMinor).toBe(b.invoices[0]!.amountMinor);
    expect(a.invoices[0]!.reference).toBe(b.invoices[0]!.reference);
    expect(isValidRfReference(a.invoices[0]!.reference)).toBe(true);
    expect(a.invoices[0]!.amountMinor).toBeGreaterThanOrEqual(150_000);
    expect(a.invoices[0]!.amountMinor).toBeLessThanOrEqual(250_000);
  });

  it("books a payout with the reference against the invoice and tells Kassa; one without it stays unmatched", async () => {
    const { w, sink } = await world();
    const t = await payToSchool(w, "budapest", 240_000, `tuition ${TUITION_REFERENCE}`);
    const inv = (await w.app.inject({ url: "/mock/schools/budapest/invoices?studentId=KZ26-0417" })).json() as { invoices: { status: string; paidMinor: number; payments: { transferId: number }[] }[] };
    expect(inv.invoices[0]).toMatchObject({ status: "PAID", paidMinor: 240_000 });
    expect(inv.invoices[0]!.payments[0]!.transferId).toBe(t.id);
    const events = sink.sent.filter((e) => e.kind === "school");
    expect(events).toHaveLength(1);
    expect(events[0]!.body).toMatchObject({ type: "invoice.payment_received", schoolId: "budapest", studentId: "KZ26-0417", status: "PAID", amountMinor: 240_000, transferId: t.id, customerTransactionId: t.customerTransactionId });
    // The bank's own "sent" webhook goes first.
    const bankSent = sink.sent.findIndex((e) => e.kind === "bank" && (e.body as { data: { current_state: string } }).data.current_state === "outgoing_payment_sent");
    expect(bankSent).toBeLessThan(sink.sent.findIndex((e) => e.kind === "school"));

    await payToSchool(w, "budapest", 10_000, "tuition");
    const after = (await w.app.inject({ url: "/mock/schools/budapest/invoices?studentId=KZ26-0417" })).json() as { unmatched: { amountMinor: number }[] };
    expect(after.unmatched).toMatchObject([{ amountMinor: 10_000 }]);
    expect(sink.sent.filter((e) => e.kind === "school")).toHaveLength(1);

    await w.app.inject({ method: "POST", url: "/mock/reset" });
    const reset = (await w.app.inject({ url: "/mock/schools/budapest/invoices?studentId=KZ26-0417" })).json() as { invoices: { status: string }[]; unmatched: unknown[] };
    expect(reset.invoices[0]!.status).toBe("OPEN");
    expect(reset.unmatched).toEqual([]);
  });

  it("a part payment leaves the rest due", async () => {
    const { w } = await world();
    const ref = ((await w.app.inject({ url: "/mock/schools/almaty/invoices?studentId=KZ-555" })).json() as { invoices: { reference: string; amountMinor: number }[] }).invoices[0]!;
    await payToSchool(w, "almaty", 50_000_00, ref.reference);
    const inv = (await w.app.inject({ url: "/mock/schools/almaty/invoices?studentId=KZ-555" })).json() as { invoices: { status: string; paidMinor: number }[] };
    expect(inv.invoices[0]).toMatchObject({ status: "PARTLY_PAID", paidMinor: 50_000_00 });
  });

  it("renders the portal page", async () => {
    const { w } = await world();
    const page = await w.app.inject({ url: "/mock/schools/budapest/portal?studentId=KZ26-0417" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("University in Budapest: tuition payments");
    expect(page.body).toContain("KZ26-0417");
    // Asks the student to sign in: no invoice is on the page and none is loaded without the date of birth.
    expect(page.body).toContain("Sign in to see your invoices");
    expect(page.body).toContain('let creds = null;');
    const empty = await w.app.inject({ url: "/mock/schools/budapest/portal?studentId=%3Cscript%3E" });
    expect(empty.body).not.toContain("<script>alert");
    expect(empty.body).toContain("Sign in with your student ID and date of birth");
    // Opened from Kassa with a valid link: signed in. A link for another student or an expired one is ignored.
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const fromKassa = await w.app.inject({ url: `/mock/schools/budapest/portal?studentId=KZ26-0417&access=${schoolPortalAccess(SECRET, "budapest", "KZ26-0417", exp)}` });
    expect(fromKassa.body).toContain("Signed in from Kassa as student KZ26-0417");
    for (const access of [schoolPortalAccess(SECRET, "budapest", "CN26-0331", exp), schoolPortalAccess(SECRET, "budapest", "KZ26-0417", exp - 7200)]) {
      const p = await w.app.inject({ url: `/mock/schools/budapest/portal?studentId=KZ26-0417&access=${access}` });
      expect(p.body).toContain('let creds = null;');
    }
  });

  it("shows a student's invoices only with their date of birth or a Kassa link; a wrong date reads the same for every ID", async () => {
    const { w } = await world();
    const ask = (school: string, body: Record<string, unknown>) => w.app.inject({ method: "POST", url: `/mock/schools/${school}/invoices`, payload: body });
    const dana = await ask("budapest", { studentId: "kz26-0417", dateOfBirth: DANA_DATE_OF_BIRTH });
    expect(dana.statusCode).toBe(200);
    expect(dana.json().invoices[0]).toMatchObject({ studentId: "KZ26-0417", reference: TUITION_REFERENCE });
    // A judge copy of Dana has her date; a generated student has one only the school (and its secret) knows.
    const copy = judgeCopyStudentId("KZ26-0417", "0b7e6a1e-3d1c-4b8e-9a51-1f1f1f1f1f1f");
    expect((await ask("budapest", { studentId: copy, dateOfBirth: DANA_DATE_OF_BIRTH })).statusCode).toBe(200);
    const generated = studentDateOfBirth(SECRET, SCHOOLS.vienna!, "S1234567");
    expect(generated).toMatch(/^(199[6-9]|200[0-7])-\d{2}-\d{2}$/);
    expect(studentDateOfBirth("another-secret", SCHOOLS.vienna!, "S1234567")).not.toBe(generated);
    expect((await ask("vienna", { studentId: "S1234567", dateOfBirth: generated })).statusCode).toBe(200);

    const refusals = [
      await ask("budapest", { studentId: "KZ26-0417" }),
      await ask("budapest", { studentId: "KZ26-0417", dateOfBirth: "2005-03-15" }),
      await ask("budapest", { studentId: "ZZ99-0001", dateOfBirth: "2005-03-15" }),
      await ask("budapest", { studentId: "KZ26-0417", access: schoolPortalAccess("not-the-secret", "budapest", "KZ26-0417", Math.floor(Date.now() / 1000) + 60) }),
    ];
    for (const r of refusals) {
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual(refusals[0]!.json());
    }
    expect(refusals[0]!.json().code).toBe("STUDENT_NOT_VERIFIED");
    const link = schoolPortalAccess(SECRET, "budapest", "KZ26-0417", Math.floor(Date.now() / 1000) + 60);
    expect((await ask("budapest", { studentId: "KZ26-0417", access: link })).statusCode).toBe(200);
    // The link is for one student at one school.
    expect((await ask("budapest", { studentId: "CN26-0331", access: link })).statusCode).toBe(403);
  });

  it("stops checking a student's date of birth after too many wrong ones", async () => {
    const { w } = await world();
    const ask = (dateOfBirth: string, studentId = "KZ26-0417") => w.app.inject({ method: "POST", url: "/mock/schools/budapest/invoices", payload: { studentId, dateOfBirth } });
    // Wrong dates count; right ones do not.
    expect((await ask(DANA_DATE_OF_BIRTH)).statusCode).toBe(200);
    for (let i = 0; i < DOB_MAX_FAILURES; i++) expect((await ask(`1990-01-${String(i + 1).padStart(2, "0")}`)).statusCode).toBe(403);
    const locked = await ask(DANA_DATE_OF_BIRTH);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe("TOO_MANY_ATTEMPTS");
    // Per student: others are unaffected; a Kassa link still works (the school confirmed that student before).
    expect((await ask(studentDateOfBirth(SECRET, SCHOOLS.budapest!, "S1234567"), "S1234567")).statusCode).toBe(200);
    const link = schoolPortalAccess(SECRET, "budapest", "KZ26-0417", Math.floor(Date.now() / 1000) + 60);
    expect((await w.app.inject({ method: "POST", url: "/mock/schools/budapest/invoices", payload: { studentId: "KZ26-0417", access: link } })).statusCode).toBe(200);
  });

  it("deployed build: the plain invoice read answers only Kassa's signed request or the operator", async () => {
    const token = "demo-admin-token-for-school-tests-0123456789";
    const { w } = await world({ NODE_ENV: "production", DEMO_ADMIN_TOKEN: token, API_URL: "http://api.test", MOCK_PUBLIC_URL: "http://mock.test" });
    const url = "/mock/schools/budapest/invoices?studentId=KZ26-0417";
    const anon = await w.app.inject({ url });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().code).toBe("KASSA_AUTH_REQUIRED");
    expect((await w.app.inject({ url, headers: { [MOCK_REQUEST_AUTH_HEADER]: mockRequestAuth("not-the-secret", "GET", url, "", Math.floor(Date.now() / 1000)) } })).statusCode).toBe(401);
    expect((await w.app.inject({ url, headers: { [MOCK_REQUEST_AUTH_HEADER]: mockRequestAuth(SECRET, "GET", url, "", Math.floor(Date.now() / 1000)) } })).statusCode).toBe(200);
    expect((await w.app.inject({ url, headers: { [DEMO_TOKEN_HEADER]: token } })).statusCode).toBe(200);
    // The student's own way in still works.
    expect((await w.app.inject({ method: "POST", url: "/mock/schools/budapest/invoices", payload: { studentId: "KZ26-0417", dateOfBirth: DANA_DATE_OF_BIRTH } })).statusCode).toBe(200);
  });
});
