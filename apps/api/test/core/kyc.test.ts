/*
 * Identity check (KYC), sandbox (2026-10-16): POST /kyc/start runs the simulated check in mock-world and keeps only
 * the outcome, document type and country, the sealed last 4 characters and timestamps; GET /kyc reports the
 * standing. Above the threshold (EUR 1,000.00, converted to the home currency) rules refuse KYC_REQUIRED, payments
 * refuses it again on its own, and a day's top-ups above it are refused. All documents here are fictitious.
 */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { kycChecks, ledgerEntries, payments, users } from "../../src/db/schema.ts";
import { toKycDto } from "../../src/modules/kyc/status.ts";
import { executeApproval } from "../../src/modules/payments/index.ts";
import { eraseUser, exportUserData } from "../../src/modules/privacy/service.ts";
import { decide, type DecideFacts } from "../../src/modules/rules/decide.ts";
import { approveOrder, getOrderView, proposeOrder, registerExecutor } from "../../src/modules/rules/index.ts";
import { setMockWorldTransportForTests } from "../../src/modules/rails/http.ts";
import { setSanctionsListForTests } from "../../src/modules/screening/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment } from "../helpers/fixtures.ts";
import { startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld | null = null;

/** A fictitious passport in the fixture user's name ("Test User"). */
const NUMBER = "TX8812345";
const doc = (over: Record<string, unknown> = {}, liveness: "PASS" | "FAIL" | "INCONCLUSIVE" = "PASS") => ({
  document: { type: "PASSPORT", number: NUMBER, country: "KZ", fullName: "Test User", dateOfBirth: "1999-03-14", expiresOn: "2031-05-31", ...over },
  liveness: { result: liveness },
});

async function start(userId: string, body: unknown) {
  return app().inject({ method: "POST", url: "/api/kyc/start", headers: await bearer(userId), payload: body as object });
}

async function status(userId: string) {
  return (await app().inject({ method: "GET", url: "/api/kyc", headers: await bearer(userId) })).json();
}

async function ledgerOf(userId: string) {
  return getDb().select().from(ledgerEntries).where(sql`${ledgerEntries.payload}->>'userId' = ${userId}`);
}

describe("identity check (KYC), sandbox", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setSanctionsListForTests([]);
    await mw?.close();
    mw = await startMockWorld();
  });
  afterAll(async () => {
    await mw?.close();
  });

  it("needs a signed-in user", async () => {
    expect((await app().inject({ method: "POST", url: "/api/kyc/start", payload: doc() })).statusCode).toBe(401);
    expect((await app().inject({ method: "GET", url: "/api/kyc" })).statusCode).toBe(401);
  });

  it("verifies a matching document; stores the outcome, type, country and sealed last 4 only, and ledgers it", async () => {
    const { userId } = await createUserWithPasskey({ kyc: "NONE" });
    const before = await status(userId);
    expect(before).toMatchObject({ status: "NONE", latest: null, homeCurrency: "KZT", simulated: true });
    expect(before.thresholdHomeMinor).toBeGreaterThan(0);

    const res = await start(userId, doc());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ outcome: "VERIFIED", reasonCodes: [], documentType: "PASSPORT", documentCountry: "KZ", documentLast4: "2345", simulated: true });
    expect(await status(userId)).toMatchObject({ status: "VERIFIED", latest: { documentLast4: "2345" } });

    // Nothing of the document but type, country and (sealed) last 4 is stored or ledgered.
    const rows = await getDb().select().from(kycChecks).where(eq(kycChecks.userId, userId));
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows) + JSON.stringify(await ledgerOf(userId));
    for (const secret of [NUMBER, "1999-03-14", "Test User", "2031-05-31", "2345"]) expect(stored).not.toContain(secret);
    const entries = (await ledgerOf(userId)).filter((e) => e.type === "KYC_VERIFIED");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.payload).toMatchObject({ outcome: "VERIFIED", documentType: "PASSPORT", documentCountry: "KZ", simulated: true });
    expect(typeof (entries[0]!.payload as { pii?: unknown }).pii).toBe("string");
  });

  it.each([
    ["name mismatch vs the account's display name", doc({ fullName: "Other Someone" }), "REJECTED", ["NAME_MISMATCH"]],
    ["document expired", doc({ expiresOn: "2020-01-31" }), "REJECTED", ["DOCUMENT_EXPIRED"]],
    ["under 18", doc({ dateOfBirth: "2015-06-01" }), "REJECTED", ["UNDER_18"]],
    ["liveness failed", doc({}, "FAIL"), "REJECTED", ["LIVENESS_FAILED"]],
    ["liveness inconclusive", doc({}, "INCONCLUSIVE"), "REVIEW", ["LIVENESS_INCONCLUSIVE"]],
  ] as const)("%s → %s with reason codes, ledgered", async (_label, body, outcome, reasons) => {
    const { userId } = await createUserWithPasskey({ kyc: "NONE" });
    const res = await start(userId, body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ outcome, reasonCodes: reasons });
    expect((await status(userId)).status).toBe(outcome);
    expect((await ledgerOf(userId)).filter((e) => e.type === `KYC_${outcome}`)).toHaveLength(1);
  });

  it("refuses a malformed document (400) and answers 503 when the identity checker is down", async () => {
    const { userId } = await createUserWithPasskey({ kyc: "NONE" });
    expect((await start(userId, doc({ country: "Kazakhstan" }))).statusCode).toBe(400);
    await mw!.close();
    mw = null;
    // Simulate the outage in-process: with no transport the client would call MOCK_WORLD_URL for real, which answers
    // whenever a dev mock world runs on :4001 (bun run dev), and the check would then succeed.
    setMockWorldTransportForTests(async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED (identity checker down)");
    });
    const down = await start(userId, doc());
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: "KYC_UNAVAILABLE" });
    expect(await getDb().select().from(kycChecks)).toHaveLength(0);
    setMockWorldTransportForTests(null);
  });

  it("rules: above the threshold without VERIFIED → REFUSE KYC_REQUIRED; below it, or once verified, as before", async () => {
    const { userId } = await createUserWithPasskey({ kyc: "NONE" });
    const university = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const big = await proposeOrder({ userId, createdBy: "USER", payeeId: university.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" });
    expect(big).toMatchObject({ decision: "REFUSE", reasonCodes: ["KYC_REQUIRED"] });
    const small = await proposeOrder({ userId, createdBy: "USER", payeeId: university.id, amountMinor: 50_000, currency: "EUR", purpose: "Fee" });
    expect(small.decision).toBe("ASK");

    // A REVIEW is not enough.
    await start(userId, doc({}, "INCONCLUSIVE"));
    expect((await proposeOrder({ userId, createdBy: "USER", payeeId: university.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" })).reasonCodes).toEqual(["KYC_REQUIRED"]);
    await start(userId, doc());
    expect((await proposeOrder({ userId, createdBy: "USER", payeeId: university.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" })).decision).toBe("ASK");
  });

  it("payments re-checks on its own: an order signed while verified is refused after a later failed check", async () => {
    const { userId, auth } = await createUserWithPasskey({ kyc: "NONE" });
    await start(userId, doc());
    const university = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const r = await proposeOrder({ userId, createdBy: "USER", payeeId: university.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" });
    expect(r.decision).toBe("ASK");
    const view = await getOrderView(userId, r.proposalId);
    registerExecutor(null);
    const approved = await approveOrder(userId, r.proposalId, auth.assert(view.orderHash));
    offlineEnvironment();
    // The latest check now fails (e.g. the document was found expired): the standing is REJECTED.
    await start(userId, doc({ expiresOn: "2021-01-01" }));
    const res = await executeApproval(approved.approvalId);
    expect(res).toMatchObject({ paymentId: null, status: "FAILED", reasonCodes: ["KYC_REQUIRED"] });
    expect(await getDb().select().from(payments)).toHaveLength(0);
    expect((await ledgerOf(userId)).filter((e) => e.type === "PAYMENT_REFUSED" && JSON.stringify(e.payload).includes("KYC_REQUIRED"))).toHaveLength(1);
  });

  it("handoff is not gated: the user pays in their own wallet", async () => {
    const { userId } = await createUserWithPasskey({ kyc: "NONE", region: "CN" });
    const university = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const r = await proposeOrder({ userId, createdBy: "USER", payeeId: university.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" });
    expect(r.decision).toBe("HANDOFF");
  });

  it("top-ups: a day's total above the threshold needs VERIFIED (422 KYC_REQUIRED, ledgered)", async () => {
    const { userId } = await createUserWithPasskey({ kyc: "NONE", moneyMode: "CAPPED_WALLET" });
    const topUp = async (amountMinor: number) =>
      app().inject({ method: "POST", url: "/api/wallet/top-ups", headers: await bearer(userId), payload: { amountMinor, currency: "EUR", method: "APPLE_PAY", idempotencyKey: randomUUID() } });
    expect((await topUp(60_000)).statusCode).toBe(200); // EUR 600
    const over = await topUp(60_000); // EUR 1,200 today
    expect(over.statusCode).toBe(422);
    expect(over.json()).toMatchObject({ code: "KYC_REQUIRED", reasonCodes: ["KYC_REQUIRED"] });
    expect((await ledgerOf(userId)).filter((e) => e.type === "WALLET_TOPUP_REFUSED")).toHaveLength(1);
    await start(userId, doc());
    expect((await topUp(60_000)).statusCode).toBe(200);
  });

  it("export includes the checks; erasure keeps the outcome (AMLD record keeping) and the last 4 become unreadable", async () => {
    const { userId } = await createUserWithPasskey({ kyc: "NONE" });
    await start(userId, doc());
    const exported = await exportUserData(userId);
    expect(exported.data.identityChecks).toMatchObject([{ outcome: "VERIFIED", documentLast4: "2345" }]);
    await eraseUser(userId);
    const rows = await getDb().select().from(kycChecks).where(eq(kycChecks.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "VERIFIED", documentType: "PASSPORT", documentCountry: "KZ" });
    const u = (await getDb().select().from(users).where(eq(users.id, userId)))[0]!;
    expect(u.erasedAt).not.toBeNull();
    expect((await toKycDto(rows[0]!)).documentLast4).toBeNull();
  });
});

describe("decide step 6b (KYC)", () => {
  const base: DecideFacts = {
    now: new Date("2026-10-16T10:00:00Z"),
    frozen: false,
    payee: { status: "VERIFIED", coolingUntil: null, hasAccount: true },
    rail: "BANK_TRANSFER",
    screeningHit: false,
    caps: { amountHomeMinor: 1_000_000, perPaymentHomeMinor: 9e9, dailyHomeMinor: 9e9, monthlyHomeMinor: 9e9, usedTodayHomeMinor: 0, usedThisMonthHomeMinor: 0, reserveBreached: false },
    preset: "SMART",
    effective: { agentAutonomy: "PLAN_AHEAD", paymentPolicy: "RISK_BASED", moneyMode: "CAPPED_WALLET" },
    region: "EU",
    mandate: { id: "m1" },
    mandateOutOfScope: false,
    riskScore: 0,
    agentRequestedConfirm: false,
    triggerOrigin: false,
    smallAutoLimitHomeMinor: 0,
    baseRulesSigned: true,
  };

  it("refuses even inside a mandate; flags a trigger origin; earlier hard refusals keep their codes", () => {
    expect(decide({ ...base, kycRequired: true })).toMatchObject({ decision: "REFUSE", reasonCodes: ["KYC_REQUIRED"] });
    expect(decide({ ...base, kycRequired: true, triggerOrigin: true }).reasonCodes).toEqual(["KYC_REQUIRED", "TRIGGER_ORIGIN"]);
    expect(decide({ ...base, kycRequired: true, screeningHit: true }).reasonCodes).toEqual(["REFUSE_SANCTIONS"]);
    expect(decide({ ...base, kycRequired: true, region: "CN" }).decision).toBe("HANDOFF");
    expect(decide({ ...base, kycRequired: false }).decision).toBe("AUTO");
  });
});
