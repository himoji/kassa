/*
 * School payment portals: the directory, a student's invoice (seeded or generated once, deterministically), and
 * payments booked from the mock bank's payouts: matched by the invoice reference (signed "school" webhook), or kept
 * as unmatched without one. The portal page renders for a student.
 */
import { randomUUID } from "node:crypto";

import { isValidIban, isValidRfReference } from "@kassa/shared";
import { afterAll, describe, expect, it } from "vitest";

import { buildMockWorld, type MockWorld } from "../src/app.ts";
import { StaticRates } from "../src/bank/rates.ts";
import { ManualClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { SCHOOLS } from "../src/school/schools.ts";
import { RecordingSink } from "../src/webhooks.ts";
import { MOCK_BANK_PROFILE_ID, TUITION_REFERENCE } from "../../../fixtures/seed-data.ts";

const clock = new ManualClock(Date.parse("2026-10-27T18:00:00Z"));
const worlds: MockWorld[] = [];

async function world() {
  const sink = new RecordingSink();
  const w = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", MOCK_HMAC_SECRET: "s3cret", MOCK_BANK_INSTANT: "true" } as NodeJS.ProcessEnv),
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
    const empty = await w.app.inject({ url: "/mock/schools/budapest/portal?studentId=%3Cscript%3E" });
    expect(empty.body).not.toContain("<script>alert");
    expect(empty.body).toContain("Enter your student ID");
  });
});
