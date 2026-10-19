/*
 * (added 2026-10-18) The mock world's state on a deployed build lives in Postgres (migration 0024_mock_world_state,
 * apps/mock-world/src/store): two "instances" (two mock worlds on one database, as two serverless instances) see the
 * same balances, transfers, QR codes and school invoices; a cold start (a new instance) loses nothing; money moved from
 * both instances at once is never lost or overdrawn; a reset anywhere reaches every instance.
 */
import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildMockWorld, seedWallets, type MockWorld } from "../../../mock-world/src/app.ts";
import { StaticRates } from "../../../mock-world/src/bank/rates.ts";
import { ManualClock } from "../../../mock-world/src/clock.ts";
import { loadConfig } from "../../../mock-world/src/config.ts";
import { SCHOOLS } from "../../../mock-world/src/school/schools.ts";
import { postgresStore } from "../../../mock-world/src/store/postgres.ts";
import type { SqlClient } from "../../../mock-world/src/store/types.ts";
import { RecordingSink } from "../../../mock-world/src/webhooks.ts";
import { judgeCopyReference, judgeCopyStudentId, judgeCopySuffix } from "../../../../fixtures/judge-copy.ts";
import { MOCK_BANK_PROFILE_ID, TUITION_REFERENCE } from "../../../../fixtures/seed-data.ts";
import { MIGRATIONS_DIR } from "../../src/db/client.ts";
import { pgliteSqlClient } from "../../src/db/mockWorldSql.ts";

let pg: PGlite;
let sql: SqlClient;
const clock = new ManualClock(Date.parse("2026-10-27T18:00:00Z"));
const open: MockWorld[] = [];

beforeAll(async () => {
  pg = new PGlite();
  await migrate(drizzle(pg), { migrationsFolder: MIGRATIONS_DIR });
  sql = pgliteSqlClient(pg);
});

afterAll(async () => {
  for (const w of open) await w.app.close();
  await pg.close();
});

beforeEach(async () => {
  // Every test starts from a fresh world: one reset through a throwaway instance.
  const w = await instance();
  await w.app.inject({ method: "POST", url: "/mock/reset", payload: {} });
});

/** A new "serverless instance": its own mock world (own memory, own caches) on the shared database. */
async function instance(): Promise<MockWorld> {
  const w = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", MOCK_HMAC_SECRET: "s3cret", MOCK_BANK_INSTANT: "true" } as NodeJS.ProcessEnv),
    clock,
    rates: new StaticRates(),
    webhooks: new RecordingSink(),
    logger: false,
    startTicker: false,
    store: await postgresStore(sql, seedWallets()),
  });
  open.push(w);
  return w;
}

const balancesOf = async (w: MockWorld, profile: number | string) => {
  const res = await w.app.inject({ method: "GET", url: `/mock/v4/profiles/${profile}/balances` });
  expect(res.statusCode, res.body).toBe(200);
  return Object.fromEntries((res.json() as { currency: string; amount: { valueMinor: number } }[]).map((b) => [b.currency, b.amount.valueMinor]));
};

const post = (w: MockWorld, url: string, payload: unknown) => w.app.inject({ method: "POST", url, payload: payload as object });

describe("mock world state shared by instances (Postgres)", () => {
  it("says where it keeps its state", async () => {
    const res = await (await instance()).app.inject({ method: "GET", url: "/mock/health" });
    expect(res.json().persistence).toBe("postgres");
  });

  it("a judge copy's wallet and its top-ups survive a cold start and show on every instance", async () => {
    const a = await instance();
    const profileId = 31_234_567;
    const userId = randomUUID();
    expect((await post(a, "/mock/bank/wallets", { profileId, aliases: [userId] })).statusCode).toBe(200);
    for (const [currency, amountMinor] of [["KZT", 90_000_000], ["USD", 45_000], ["HUF", 12_000_000], ["EUR", 30_000]] as const) {
      const r = await post(a, "/mock/bank/top-ups", { profileId, currency, amountMinor, reference: `seed:${userId}:${currency}` });
      expect(r.statusCode, r.body).toBe(200);
    }

    const b = await instance(); // a cold start elsewhere
    expect(await balancesOf(b, profileId)).toEqual({ KZT: 90_000_000, USD: 45_000, HUF: 12_000_000, EUR: 30_000 });
    expect(await balancesOf(b, userId)).toEqual(await balancesOf(a, profileId));

    // The judges' report: a top-up after a restart answered from an empty wallet. Now it adds to the real balance.
    const top = await post(b, "/mock/bank/top-ups", { profileId, currency: "KZT", amountMinor: 3_000_000, reference: `tap:${randomUUID()}` });
    expect(top.json().balanceAfterMinor).toBe(93_000_000);
    // Retried on the other instance: once only, same answer.
    const ref = `tap:${randomUUID()}`;
    const first = await post(a, "/mock/bank/top-ups", { profileId, currency: "EUR", amountMinor: 500, reference: ref });
    const again = await post(b, "/mock/bank/top-ups", { profileId, currency: "EUR", amountMinor: 500, reference: ref });
    expect(again.json()).toMatchObject({ balanceAfterMinor: first.json().balanceAfterMinor, created: false });
    expect((await post(b, "/mock/bank/top-ups", { profileId, currency: "EUR", amountMinor: 501, reference: ref })).statusCode).toBe(409);
    expect((await balancesOf(a, profileId)).EUR).toBe(30_500);
  });

  it("money moved from two instances at once is never lost and never overdraws", async () => {
    const [a, b] = [await instance(), await instance()];
    const profileId = 32_000_001;
    await post(a, "/mock/bank/wallets", { profileId, aliases: [] });
    // 20 credits of 1,000 from both instances at once.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(i % 2 ? a : b, "/mock/remittance/incoming", { profileId, amountMinor: 1_000, currency: "EUR" })),
    );
    expect((await balancesOf(b, profileId)).EUR).toBe(20_000);

    // Five transfers of EUR 60 (plus the route fee) prepared on alternating instances, funded at once: only what fits.
    const transfers = [];
    for (let i = 0; i < 5; i++) {
      const w = i % 2 ? a : b;
      const quote = await w.bank.createQuote(profileId, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 6_000 });
      const recipient = await w.bank.createRecipient({ currency: "EUR", profile: profileId, accountHolderName: "Student Insurer in EU", legalType: "BUSINESS", iban: "HU92104051760049812600000008" });
      const { transfer } = await w.bank.createTransfer({ targetAccount: recipient.id, quoteUuid: quote.id, customerTransactionId: randomUUID(), reference: `t${i}`, instant: true });
      transfers.push({ w, transfer });
    }
    const cost = transfers[0]!.transfer.sourceAmountMinor;
    const results = await Promise.allSettled(transfers.map(({ w, transfer }) => w.bank.fund(profileId, transfer.id)));
    const funded = results.filter((r) => r.status === "fulfilled").length;
    expect(funded).toBe(Math.floor(20_000 / cost));
    expect((await balancesOf(a, profileId)).EUR).toBe(20_000 - funded * cost);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "transfer.insufficient_funds" });
  });

  it("a transfer, a QR code and a school invoice made on one instance are seen and moved on by another", async () => {
    const a = await instance();
    const b = await instance();
    // Transfer: created and funded through A's routes (instant), read back through B's (the API's status poll).
    const school = SCHOOLS.budapest!;
    const studentId = judgeCopyStudentId("KZ26-0417", randomUUID());
    const inv = (await b.app.inject({ method: "GET", url: `/mock/schools/budapest/invoices?studentId=${studentId}` })).json().invoices[0];
    expect(inv).toMatchObject({ studentId, amountMinor: 240_000, status: "OPEN" });
    await post(a, "/mock/bank/top-ups", { profileId: MOCK_BANK_PROFILE_ID, currency: "EUR", amountMinor: 300_000, reference: `t:${randomUUID()}` });
    const quote = (await post(a, `/mock/v3/profiles/${MOCK_BANK_PROFILE_ID}/quotes`, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: inv.amountMinor })).json();
    const account = (await post(a, "/mock/v1/accounts", { currency: "EUR", profile: MOCK_BANK_PROFILE_ID, accountHolderName: school.name, type: "iban", details: { iban: school.iban } })).json();
    const transfer = (await post(a, "/mock/v1/transfers", { targetAccount: account.id, quoteUuid: quote.id, customerTransactionId: randomUUID(), details: { reference: inv.reference }, instant: true })).json();
    const funded = await post(a, `/mock/v3/profiles/${MOCK_BANK_PROFILE_ID}/transfers/${transfer.id}/payments`, { type: "BALANCE" });
    expect(funded.statusCode, funded.body).toBe(200);

    const seen = await b.app.inject({ method: "GET", url: `/mock/v1/transfers/${transfer.id}` });
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json().status).toBe("outgoing_payment_sent");
    // The school portal on B shows the invoice paid; a fresh instance too.
    const paid = (await b.app.inject({ method: "GET", url: `/mock/schools/budapest/invoices?studentId=${studentId}` })).json().invoices[0];
    expect(paid.status).toBe("PAID");
    const c = await instance();
    expect((await c.app.inject({ method: "GET", url: `/mock/schools/budapest/invoices?studentId=${studentId}` })).json().invoices[0].status).toBe("PAID");
    // ...while the seeded student's invoice is untouched.
    expect((await c.app.inject({ method: "GET", url: "/mock/schools/budapest/invoices?studentId=KZ26-0417" })).json().invoices[0].status).toBe("OPEN");

    // QR: created by the API through A, paid in the browser through B.
    const qr = (await post(a, "/mock/qr/payments", { payeeName: "Dorm Office in Shanghai", amountMinor: 180_000, currency: "CNY" })).json();
    expect((await post(b, `/mock/qr/${qr.paymentId}/pay`, {})).statusCode).toBe(200);
    expect((await a.app.inject({ method: "GET", url: `/mock/qr/payments/${qr.paymentId}` })).json().status).toBe("PAID");
    expect((await post(a, `/mock/qr/${qr.paymentId}/pay`, {})).statusCode).toBe(409);
  });

  it("a reset on one instance reaches the others (balances, entities, seeded wallets)", async () => {
    const [a, b] = [await instance(), await instance()];
    const qr = (await post(a, "/mock/qr/payments", { payeeName: "Dorm Office in Shanghai", amountMinor: 100, currency: "CNY" })).json();
    await post(a, "/mock/remittance/incoming", { profileId: MOCK_BANK_PROFILE_ID, amountMinor: 100_000_000, currency: "KZT" });
    expect((await b.app.inject({ method: "GET", url: `/mock/qr/payments/${qr.paymentId}` })).statusCode).toBe(200);
    const kzt = (await balancesOf(b, MOCK_BANK_PROFILE_ID)).KZT!;

    expect((await post(a, "/mock/reset", {})).statusCode).toBe(200);
    expect((await b.app.inject({ method: "GET", url: `/mock/qr/payments/${qr.paymentId}` })).statusCode).toBe(404);
    expect((await balancesOf(b, MOCK_BANK_PROFILE_ID)).KZT).toBe(kzt - 100_000_000);
    // The API's demo reset truncates every table: the next instance reseeds the persona wallets.
    await pg.exec("truncate mock_world_wallets, mock_world_balances, mock_world_aliases, mock_world_top_ups, mock_world_entities, mock_world_meta");
    expect((await balancesOf(b, MOCK_BANK_PROFILE_ID)).KZT).toBe(kzt - 100_000_000);
    const c = await instance();
    expect((await balancesOf(c, MOCK_BANK_PROFILE_ID)).KZT).toBe(kzt - 100_000_000);
  });

  it("a judge copy's tuition reference books against that copy's invoice even before anyone looked it up", async () => {
    const a = await instance();
    const userId = randomUUID();
    const studentId = judgeCopyStudentId("KZ26-0417", userId);
    const reference = judgeCopyReference(TUITION_REFERENCE, judgeCopySuffix(userId));
    await post(a, "/mock/bank/top-ups", { profileId: MOCK_BANK_PROFILE_ID, currency: "EUR", amountMinor: 300_000, reference: `t:${randomUUID()}` });
    const school = SCHOOLS.budapest!;
    const quote = await a.bank.createQuote(MOCK_BANK_PROFILE_ID, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 240_000 });
    const recipient = await a.bank.createRecipient({ currency: "EUR", profile: MOCK_BANK_PROFILE_ID, accountHolderName: school.name, legalType: "BUSINESS", iban: school.iban });
    const { transfer } = await a.bank.createTransfer({ targetAccount: recipient.id, quoteUuid: quote.id, customerTransactionId: randomUUID(), reference: `Tuition ${reference}`, instant: true });
    await a.bank.fund(MOCK_BANK_PROFILE_ID, transfer.id);
    await a.sync.push();

    const b = await instance();
    const own = (await b.app.inject({ method: "GET", url: `/mock/schools/budapest/invoices?studentId=${studentId}` })).json();
    expect(own.invoices[0]).toMatchObject({ reference, status: "PAID" });
    expect(own.unmatched).toHaveLength(0);
    expect((await b.app.inject({ method: "GET", url: "/mock/schools/budapest/invoices?studentId=KZ26-0417" })).json().invoices[0].status).toBe("OPEN");
  });
});
