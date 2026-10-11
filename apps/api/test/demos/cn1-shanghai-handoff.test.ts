/*
 * D-CN1 Shanghai exchange semester: region CN → every payment is HANDOFF in CNY; the dorm fee QR matches and is
 * paid; a swapped QR is caught (QR_PAYEE_MISMATCH); the CNY need is covered from KZT/USD; the AI notice mentions
 * PIPL cross-border processing.
 * Runs against the real handoff rail and the in-process mock world (QR wallet, mock bank balances), like A5.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { payments, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { forecastCoverage, getRoutes } from "../../src/modules/fx/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment, signBaseRules, useRealHandoff } from "../helpers/fixtures.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";
import { IDS } from "../../../../fixtures/seed-data.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;

/** Seeded Dana (no personas), with a passkey in both credential tables and signed base rules. */
async function seededDana() {
  const { userId } = await seedDatabase(getDb(), await loadSeedData(), { reset: true });
  const auth = new SoftAuthenticator();
  const row = { userId, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  await signBaseRules(userId, auth);
  return { userId, auth };
}

/** Tightening (EU → CN) applies instantly, no passkey. */
async function switchToCn(userId: string): Promise<void> {
  const res = await app().inject({ method: "PATCH", url: "/api/settings", headers: await bearer(userId), payload: { region: "CN" } });
  expect(res.statusCode).toBe(200);
  expect(res.json().settings.region).toBe("CN");
}

async function setSwap(enabled: boolean): Promise<void> {
  const res = await mw.app.inject({ method: "POST", url: "/mock/qr/attack/swap", payload: { enabled } });
  expect(res.statusCode).toBe(200);
}

describe("D-CN1 Shanghai exchange semester: handoff in CNY, QR checks, CNY coverage", () => {
  beforeAll(async () => {
    mw = await startMockWorld();
  });
  afterAll(async () => {
    await mw.close();
  });
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    // The real handoff rail talks to the mock world; real mock-bank balances (as A5 and funding.test).
    useRealHandoff(); // X7: real handoff rail + real QR preflight against the in-process mock world
    setBalanceProviderForTests(null);
    await setSwap(false);
  });

  it("AI notice: region CN adds the PIPL cross-border line; EU does not", async () => {
    const { userId } = await seededDana();

    const before = await app().inject({ method: "GET", url: "/api/privacy/ai-notice", headers: await bearer(userId) });
    expect(before.statusCode).toBe(200);
    expect(before.json().text).not.toContain("PIPL");

    await switchToCn(userId);

    const after = await app().inject({ method: "GET", url: "/api/privacy/ai-notice", headers: await bearer(userId) });
    expect(after.statusCode).toBe(200);
    expect(after.json().text).toContain("Region CN (PIPL)");
    expect(after.json().text).toContain("cross-border");

    const me = await app().inject({ method: "GET", url: "/api/me", headers: await bearer(userId) });
    expect(me.statusCode).toBe(200);
    expect(me.json().aiNotice.text).toContain("PIPL");

    const anonCn = await app().inject({ method: "GET", url: "/api/privacy/ai-notice?region=CN" });
    expect(anonCn.statusCode).toBe(200);
    expect(anonCn.json().text).toContain("PIPL");

    const anonEu = await app().inject({ method: "GET", url: "/api/privacy/ai-notice" });
    expect(anonEu.statusCode).toBe(200);
    expect(anonEu.json().text).not.toContain("PIPL");

    // Y3: the CN notice asks for the separate consent; the agent refuses until Dana gives it, then works.
    expect(after.json().crossBorderConsentRequired).toBe(true);
    const h = await bearer(userId);
    await app().inject({ method: "POST", url: "/api/privacy/ai-consent", headers: h, payload: { consent: true } });
    const chat = { conversationId: "00000000-0000-4000-8000-00000000c0c1", text: "Pay the Dorm Office in Shanghai my November dorm fee" };
    const refused = await app().inject({ method: "POST", url: "/api/agent/message", headers: h, payload: chat });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("PIPL_CONSENT_REQUIRED");
    const given = await app().inject({ method: "POST", url: "/api/privacy/pipl-consent", headers: h, payload: { consent: true } });
    expect(given.statusCode, given.body).toBe(200);
    expect(given.json().piplConsentAt).toBeTruthy();
    await ensureIntelTables(t.db());
    const ok = await app().inject({ method: "POST", url: "/api/agent/message", headers: h, payload: chat });
    expect(ok.statusCode).toBe(200);
  });

  it("dorm fee ¥1,800: HANDOFF in CNY, QR MATCH, paid in the QR wallet → SENT", async () => {
    const { userId, auth } = await seededDana();
    await switchToCn(userId);

    const p = await proposeOrder({
      userId,
      createdBy: "AGENT",
      payeeId: IDS.payees.dormOffice,
      amountMinor: 180_000,
      currency: "CNY",
      purpose: "Dorm fee November 2026",
    });
    expect(p.decision).toBe("HANDOFF");
    expect(p.reasonCodes).toEqual(["HANDOFF_REGION"]);

    const view = await getOrderView(userId, p.proposalId);
    expect(view.canonicalOrder).toMatchObject({
      rail: "HANDOFF",
      amountMinor: 180_000,
      currency: "CNY",
      payeeName: "Dorm Office in Shanghai",
      homeCurrency: "KZT",
      // offlineEnvironment() forces money/fx's labelled test fallback (1 CNY = ₸67.00): ¥1,800 = ₸120,600.00.
      // The sim (FX_OFFLINE example table, 1 CNY = ₸73.78) shows ₸132,809.64 for the same order.
      homeAmountMinor: 12_060_000,
    });

    const res = await approveOrder(userId, p.proposalId, auth.assert(view.orderHash));
    expect(res.paymentStatus).toBe("PROCESSING");
    expect(res.reasonCodes).toEqual([]);

    const handoff = await app().inject({ method: "GET", url: `/api/handoff/${res.paymentId}`, headers: await bearer(userId) });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json()).toMatchObject({
      check: "MATCH",
      qrPayeeName: "Dorm Office in Shanghai",
      verifiedPayeeName: "Dorm Office in Shanghai",
      amountMinor: 180_000,
      currency: "CNY",
    });
    expect(handoff.json().walletUrl).toEqual(expect.any(String));

    const [pay] = await getDb().select().from(payments).where(eq(payments.id, res.paymentId!));
    expect(pay).toBeDefined();
    const details = pay!.details as { qrPaymentId: string; qrPayload: string };
    expect(details.qrPayload).toContain("5802CN");
    expect(details.qrPayload).toContain("Shanghai");

    const paid = await mw.app.inject({ method: "POST", url: `/mock/qr/${details.qrPaymentId}/pay`, payload: {} });
    expect(paid.statusCode).toBe(200);
    await deliverWebhooks(mw, app());

    const [after] = await getDb().select().from(payments).where(eq(payments.id, res.paymentId!));
    expect(after!.status).toBe("SENT");
  });

  it("bedding set ¥349 with a swapped QR: QR_PAYEE_MISMATCH before signing, no passkey prompt, nothing paid", async () => {
    const { userId, auth } = await seededDana();
    await switchToCn(userId);
    await setSwap(true);

    const p = await proposeOrder({
      userId,
      createdBy: "AGENT",
      payeeId: IDS.payees.cnShop,
      amountMinor: 34_900,
      currency: "CNY",
      purpose: "Bedding set",
    });
    expect(p.decision).toBe("HANDOFF");

    // X7: the QR is checked when the order is shown, before the passkey prompt — nothing to sign, approve refused.
    const view = await getOrderView(userId, p.proposalId);
    expect(view.webauthnOptions).toBeNull();
    expect(view.reasonCodes).toContain("QR_PAYEE_MISMATCH");
    expect(view.handoff).toMatchObject({
      check: "QR_PAYEE_MISMATCH",
      qrPayeeName: "Unknown Trading Company",
      verifiedPayeeName: "Buy Everything Shop from China",
    });
    await expect(approveOrder(userId, p.proposalId, auth.assert(view.orderHash))).rejects.toMatchObject({ status: 409, code: "QR_PAYEE_MISMATCH" });
    expect(await getDb().select().from(payments).where(eq(payments.userId, userId))).toHaveLength(0);

    const sent = await getDb()
      .select()
      .from(payments)
      .where(and(eq(payments.userId, userId), eq(payments.status, "SENT")));
    expect(sent).toHaveLength(0);
  });

  it("the CNY need is covered from KZT or USD: routes into CNY and the coverage forecast", async () => {
    const { userId } = await seededDana();

    // Balances come from the mock bank profile 16000001: KZT 900,000 / USD 450 / HUF 120,000 / EUR 300, no CNY.
    const kzt = await getRoutes({ userId, fromCurrency: "KZT", toCurrency: "CNY", amountMinor: 180_000, dueDate: "2026-11-15" });
    expect(kzt.homeCurrency).toBe("KZT");
    expect(kzt.routes.map((r) => r.routeId)).toEqual(["kzt-mock-bank:KZT", "kzt-card:KZT", "kzt-home-bank:KZT"]);
    expect(kzt.routes[0]!.costHomeMinor).toBe(172_045);

    const usd = await getRoutes({ userId, fromCurrency: "USD", toCurrency: "CNY", amountMinor: 180_000, dueDate: "2026-11-15" });
    expect(usd.routes.map((r) => r.routeId)).toEqual(["usd-mock-bank:USD", "usd-card:USD"]);
    expect(usd.routes[0]!.costHomeMinor).toBe(138_776);

    const f = await forecastCoverage(userId);
    const cny = f.currencies.find((c) => c.currency === "CNY");
    expect(cny).toBeDefined();
    expect(cny!.shortfall).toEqual({ date: "2026-11-15", amountMinor: 180_000 });
    expect(f.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromCurrency: "KZT",
          toCurrency: "CNY",
          amountMinor: 180_000,
          byDate: "2026-11-15",
          route: expect.objectContaining({ routeId: "kzt-mock-bank:KZT" }),
        }),
      ]),
    );
  });
});
