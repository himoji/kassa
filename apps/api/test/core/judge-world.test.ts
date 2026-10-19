/*
 * (added 2026-10-18) Judge build, the outside world per copy:
 * - each copy of Dana has its own student ID and tuition reference (fixtures/judge-copy.ts), so the school portal keeps
 *   one invoice per copy: one reviewer paying tuition never shows as paid in another's copy;
 * - "Find your school" with the seeded student ID means the copy's own;
 * - POST /demo/money-from-home credits the signed-in user's own wallet only (judge build or a dev sign-in session).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { judgeCopyReference, judgeCopyStudentId, judgeCopySuffix } from "../../../../fixtures/judge-copy.ts";
import { TUITION_REFERENCE } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { obligations, payees, profiles } from "../../src/db/schema.ts";
import { resetEnvCache, setEnvForTests } from "../../src/env.ts";
import { mintAccessTokenForTests } from "../../src/modules/auth/session.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase, type SeedData } from "../../src/modules/demo/seed.ts";
import { mockWorld } from "../../src/modules/rails/http.ts";
import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;
let seed: SeedData;

beforeAll(async () => {
  await ensureIntelTables(t.db());
  mw = await startMockWorld();
  seed = await loadSeedData();
});

afterAll(async () => {
  await mw.close();
});

beforeEach(async () => {
  await seedDatabase(getDb(), seed, { reset: true, personas: true });
});

afterEach(() => {
  resetEnvCache();
  clock.setOffsetInMemoryForTests(0);
});

const judgeEnv = () => setEnvForTests({ DEMO_ENABLED: "true", JUDGE_MODE: "true" });

async function login() {
  const res = await app().inject({ method: "POST", url: "/api/auth/dev/login", payload: { client: "native", demoClaim: true } });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { user: { id: string }; tokens: { accessToken: string } };
  return { id: body.user.id, h: { authorization: `Bearer ${body.tokens.accessToken}` } };
}

async function tuitionOf(userId: string) {
  const rows = await getDb()
    .select({ o: obligations, p: payees })
    .from(obligations)
    .innerJoin(payees, eq(payees.id, obligations.payeeId))
    .where(and(eq(obligations.userId, userId), eq(payees.kind, "UNIVERSITY")));
  return rows[0]!;
}

const walletOf = async (userId: string) => (await getDb().select({ id: profiles.bankProfileId }).from(profiles).where(eq(profiles.userId, userId)))[0]!.id!;
const kztOf = async (profile: number) =>
  (await mockWorld<{ currency: string; amount: { valueMinor: number } }[]>("GET", `/v4/profiles/${profile}/balances`)).find((b) => b.currency === "KZT")?.amount.valueMinor ?? 0;

describe("judge build: the school portal keeps one invoice per copy", () => {
  it("each copy has its own student ID and tuition reference, and its own open invoice", async () => {
    judgeEnv();
    const a = await login();
    const b = await login();
    for (const s of [a, b]) {
      const { o } = await tuitionOf(s.id);
      expect(o.reference).toBe(judgeCopyReference(TUITION_REFERENCE, judgeCopySuffix(s.id)));
      expect(o.amountMinor).toBe(240_000);
      // "Find your school" with the seeded student ID (the portal's example) answers with the copy's own invoice.
      const res = await app().inject({ method: "POST", url: "/api/schools/budapest/lookup", headers: s.h, payload: { studentId: "KZ26-0417" } });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { invoices: { studentId: string; reference: string; amountMinor: number; status: string }[]; existingPayeeId: string | null };
      expect(body.invoices).toEqual([expect.objectContaining({ studentId: judgeCopyStudentId("KZ26-0417", s.id), reference: o.reference, amountMinor: 240_000, status: "OPEN" })]);
      // ...and it is the copy's own seeded tuition recipient (its details carry the copy's student ID).
      expect(body.existingPayeeId).toBe((await tuitionOf(s.id)).p.id);
    }
    expect((await tuitionOf(a.id)).o.reference).not.toBe((await tuitionOf(b.id)).o.reference);
  });

  it("a payment with copy A's reference marks only A's invoice paid", async () => {
    judgeEnv();
    const a = await login();
    const b = await login();
    const ref = (await tuitionOf(a.id)).o.reference!;
    // The bank pays the school with A's reference (what A's tuition payment sends).
    const school = (await mockWorld<{ schools: { id: string; account: { iban: string } }[] }>("GET", "/schools?q=Budapest")).schools.find((s) => s.id === "budapest")!;
    const pa = await walletOf(a.id);
    const quote = await mw.bank.createQuote(pa, { sourceCurrency: "EUR", targetCurrency: "EUR", targetAmountMinor: 240_000 });
    await mw.bank.topUp(pa, "EUR", quote.sourceAmountMinor, `test:${a.id}`);
    const recipient = await mw.bank.createRecipient({ currency: "EUR", profile: pa, accountHolderName: "University in Budapest", legalType: "BUSINESS", iban: school.account.iban });
    const { transfer } = await mw.bank.createTransfer({ targetAccount: recipient.id, quoteUuid: quote.id, customerTransactionId: crypto.randomUUID(), reference: ref, instant: true });
    await mw.bank.fund(pa, transfer.id);
    // Step-by-step states in tests: move the demo clock past the payout.
    clock.setOffsetInMemoryForTests(clock.offsetMs() + 120_000);
    await mw.bank.tick();
    expect((await mw.bank.getTransfer(transfer.id)).status).toBe("outgoing_payment_sent");

    const statusFor = async (s: { h: Record<string, string> }) =>
      (await app().inject({ method: "POST", url: "/api/schools/budapest/lookup", headers: s.h, payload: { studentId: "KZ26-0417" } })).json().invoices[0].status;
    expect(await statusFor(a)).toBe("PAID");
    expect(await statusFor(b)).toBe("OPEN");
    // The seeded student's invoice (shared by nobody now) is untouched too.
    expect((await mockWorld<{ invoices: { status: string }[] }>("GET", "/schools/budapest/invoices?studentId=KZ26-0417")).invoices[0]!.status).toBe("OPEN");
  });
});

describe("POST /demo/money-from-home: the signed-in user's own wallet only", () => {
  it("judge build: credits KZT 1,000,000 to the caller's copy, nobody else's", async () => {
    judgeEnv();
    const a = await login();
    const b = await login();
    const [pa, pb] = [await walletOf(a.id), await walletOf(b.id)];
    const [beforeA, beforeB, beforeDana] = [await kztOf(pa), await kztOf(pb), await kztOf(seed.mockBankProfileId)];
    expect(beforeA).toBe(90_000_000); // the seeded KZT 900,000: not rich by default

    const res = await app().inject({ method: "POST", url: "/api/demo/money-from-home", headers: a.h, payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ currency: "KZT", amountMinor: 100_000_000, balanceAfterMinor: beforeA + 100_000_000, simulated: true });
    expect(await kztOf(pa)).toBe(beforeA + 100_000_000);
    expect(await kztOf(pb)).toBe(beforeB);
    expect(await kztOf(seed.mockBankProfileId)).toBe(beforeDana);
    // The bank's signed notice names A's own profile (the API maps it back to A).
    const notice = mw.pending.filter((w) => w.kind === "remittance").at(-1)!.body as { profileId: number };
    expect(notice.profileId).toBe(pa);
  });

  it("outside the judge build: dev sign-in sessions only", async () => {
    setEnvForTests({ DEMO_ENABLED: "true" });
    const userId = seed.user.id;
    const plain = await app().inject({ method: "POST", url: "/api/demo/money-from-home", headers: { authorization: `Bearer ${await mintAccessTokenForTests(userId)}` }, payload: {} });
    expect(plain.statusCode, plain.body).toBe(403);
    expect(plain.json().code).toBe("NOT_DEMO_SESSION");
    const lite = await app().inject({ method: "POST", url: "/api/demo/money-from-home", headers: { authorization: `Bearer ${await mintAccessTokenForTests(userId, { scope: "lite" })}` }, payload: {} });
    expect(lite.statusCode).toBe(403);
    const before = await kztOf(seed.mockBankProfileId);
    const dev = await app().inject({ method: "POST", url: "/api/demo/money-from-home", headers: { authorization: `Bearer ${await mintAccessTokenForTests(userId, { dev: true })}` }, payload: {} });
    expect(dev.statusCode, dev.body).toBe(200);
    expect(await kztOf(seed.mockBankProfileId)).toBe(before + 100_000_000);
    expect((await app().inject({ method: "POST", url: "/api/demo/money-from-home", payload: {} })).statusCode).toBe(401);
  });
});
