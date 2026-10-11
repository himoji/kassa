/*
 * Demo Stage server-side actions (mock-world /mock/stage calls these with the demo admin token): POST
 * /api/demo/stage/shortcut-token mints an iOS Shortcut device token, /api/demo/stage/settlement reconciles a card
 * statement line (DCC flagged when the charge is in the home currency abroad), /api/demo/stage/document stores a
 * forwarded email for the Reader. Like the scenario triggers, they only log or store: nothing here proposes,
 * approves or pays (I6).
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { devices, ledgerEntries, notifications, payments, proposals } from "../../src/db/schema.ts";
import { agentDocuments } from "../../src/db/schema.intel.ts";
import { resetEnvCache, setEnvForTests } from "../../src/env.ts";
import { buildServer } from "../../src/server.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function seeded() {
  const { userId } = await seedDatabase(getDb(), await loadSeedData(), { reset: true });
  return { userId };
}

async function mintToken(payload: Record<string, unknown> = {}) {
  const res = await app().inject({ method: "POST", url: "/api/demo/stage/shortcut-token", payload });
  expect(res.statusCode).toBe(201);
  return res.json() as { deviceId: string; token: string };
}

async function capture(token: string, payload: Record<string, unknown>) {
  return app().inject({ method: "POST", url: "/api/capture/shortcut", headers: { authorization: `Bearer ${token}` }, payload });
}

async function countRows(userId: string) {
  const db = getDb();
  return {
    proposals: (await db.select().from(proposals).where(eq(proposals.userId, userId))).length,
    payments: (await db.select().from(payments).where(eq(payments.userId, userId))).length,
  };
}

describe("Demo Stage server-side actions", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("shortcut-token mints an IOS_SHORTCUT device for the demo user and the token works on /capture/shortcut", async () => {
    const { userId } = await seeded();
    const before = await countRows(userId);

    const { deviceId, token } = await mintToken();
    expect(token.startsWith("ksc_")).toBe(true);
    expect(deviceId).toMatch(UUID);

    const [device] = await getDb().select().from(devices).where(eq(devices.id, deviceId));
    expect(device).toMatchObject({ id: deviceId, userId, kind: "IOS_SHORTCUT" });
    // I13: only the hash of the token is stored.
    expect(device!.tokenHash).not.toBe(token);

    const res = await capture(token, { merchant: "Coffee Shop in Budapest", amount: "€4.20", currency: "EUR", card: "Debit card 4821" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "LOGGED", currency: "EUR", amountMinor: 420 });

    // The mint is recorded in the ledger (read the rows, filter the payload in code: jsonb).
    const ledgerRows = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "DEVICE_TOKEN_CREATED"));
    expect(ledgerRows.some((r) => (r.payload as { deviceId?: string }).deviceId === deviceId)).toBe(true);

    // Capture only logs (I6): nothing proposed or paid.
    expect(await countRows(userId)).toEqual(before);
  });

  it("shortcut-token rejects a body", async () => {
    await seeded();
    const res = await app().inject({ method: "POST", url: "/api/demo/stage/shortcut-token", payload: { userId: "x" } });
    expect(res.statusCode).toBe(400);
  });

  it("stage settlement flags DCC on a home-currency charge abroad", async () => {
    const { userId } = await seeded();
    const { token } = await mintToken();

    // Offline example rates (fixtures/fx-rates.json): HUF 392.50 and KZT 612.40 per EUR.
    const local = 1_299_000; // HUF minor units (HUF 12,990.00)
    const charged = Math.round((local * 612.4) / 392.5 * 1.06); // home-currency (KZT) charge with ~6 % DCC markup

    const cap = await capture(token, {
      merchant: "Gift Shop in Budapest",
      amount: `KZT ${(charged / 100).toFixed(2)}`,
      currency: "KZT",
      card: "Debit card 4821",
    });
    expect(cap.statusCode).toBe(200);
    const { transactionId } = cap.json() as { transactionId: string };
    expect(transactionId).toMatch(UUID);

    const settle = await app().inject({
      method: "POST",
      url: "/api/demo/stage/settlement",
      payload: {
        transactionId,
        amountMinor: charged,
        currency: "KZT",
        settledAmountMinor: charged,
        settledCurrency: "KZT",
        localAmountMinor: local,
        localCurrency: "HUF",
      },
    });
    expect(settle.statusCode).toBe(200);
    const body = settle.json() as { dcc: { overMidBps: number } | null };
    expect(body.dcc).not.toBeNull();
    expect(body.dcc!.overMidBps).toBeGreaterThanOrEqual(550);
    expect(body.dcc!.overMidBps).toBeLessThanOrEqual(650);

    const dccNotes = await getDb()
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.kind, "FEES_DCC")));
    expect(dccNotes.length).toBeGreaterThanOrEqual(1);

    // reconcileSettlement sets feeHomeMinor on the first settlement; the second call hits the
    // SETTLED && feeHomeMinor !== null guard and is refused with 409 SETTLEMENT_ALREADY_SETTLED.
    const again = await app().inject({
      method: "POST",
      url: "/api/demo/stage/settlement",
      payload: {
        transactionId,
        amountMinor: charged,
        currency: "KZT",
        settledAmountMinor: charged,
        settledCurrency: "KZT",
        localAmountMinor: local,
        localCurrency: "HUF",
      },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("SETTLEMENT_ALREADY_SETTLED");
  });

  it("stage settlement with no match returns 404 SETTLEMENT_NO_MATCH", async () => {
    await seeded();
    const res = await app().inject({
      method: "POST",
      url: "/api/demo/stage/settlement",
      payload: { merchant: "Nowhere", amountMinor: 999, currency: "EUR", settledAmountMinor: 999, settledCurrency: "KZT" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("SETTLEMENT_NO_MATCH");
  });

  it("stage document stores a forwarded email for the Reader and notifies the user", async () => {
    const { userId } = await seeded();
    const before = await countRows(userId);
    const dataB64 = Buffer.from("From: a@b.example\nSubject: new IBAN\n\nPlease pay to HU00 0000").toString("base64");

    const res = await app().inject({
      method: "POST",
      url: "/api/demo/stage/document",
      payload: { filename: "forwarded-email.txt", mediaType: "text/plain", kind: "email_change_request", dataB64 },
    });
    expect(res.statusCode).toBe(200);
    const { docId } = res.json() as { docId: string };
    expect(docId).toMatch(UUID);

    const [doc] = await getDb().select().from(agentDocuments).where(eq(agentDocuments.id, docId));
    expect(doc).toMatchObject({ userId, kind: "email_change_request", mediaType: "text/plain" });

    const inbox = await getDb()
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.kind, "INBOX_NEW_EMAIL")));
    expect(inbox.some((n) => (n.data as { docId?: string } | null)?.docId === docId)).toBe(true);

    // The document is data for the Reader, not an approval: no proposals or payments.
    expect(await countRows(userId)).toEqual(before);
  });

  it("stage document validates input", async () => {
    await seeded();
    const dataB64 = Buffer.from("hello").toString("base64");
    const post = (payload: Record<string, unknown>) => app().inject({ method: "POST", url: "/api/demo/stage/document", payload });

    expect((await post({ filename: "x.png", mediaType: "image/png", dataB64 })).statusCode).toBe(400);
    expect((await post({ filename: "x.txt", mediaType: "text/plain", dataB64: "not base64!!" })).statusCode).toBe(400);
    expect((await post({ mediaType: "text/plain", dataB64 })).statusCode).toBe(400);
  });

  describe("stage routes need the admin token when one is configured", () => {
    afterEach(() => resetEnvCache());

    it("POST /api/demo/stage/shortcut-token: no header and wrong token are 403, the right token is 201", async () => {
      await seeded();
      setEnvForTests({ DEMO_ADMIN_TOKEN: "s".repeat(40) });
      const server = await buildServer({ logger: false });
      try {
        const none = await server.inject({ method: "POST", url: "/api/demo/stage/shortcut-token", payload: {} });
        expect(none.statusCode).toBe(403);
        const wrong = await server.inject({
          method: "POST",
          url: "/api/demo/stage/shortcut-token",
          headers: { "x-kassa-demo-token": "s".repeat(39) },
          payload: {},
        });
        expect(wrong.statusCode).toBe(403);
        const right = await server.inject({
          method: "POST",
          url: "/api/demo/stage/shortcut-token",
          headers: { "x-kassa-demo-token": "s".repeat(40) },
          payload: {},
        });
        expect(right.statusCode).toBe(201);
      } finally {
        await server.close();
      }
    });
  });
});
