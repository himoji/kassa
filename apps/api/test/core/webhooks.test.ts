/* I13 webhook authentication + FakeIssuing one-time card (spec §11): HMAC, 5-min window on the demo Clock, single use. */
import { mockWebhookHeaders } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { issuedCards, payments, transactions } from "../../src/db/schema.ts";
import { env } from "../../src/env.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { proposeOrder } from "../../src/modules/rules/index.ts";
import { useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();

function signed(url: string, body: unknown, tsSeconds = Math.floor(clock.nowMs() / 1000)) {
  const raw = JSON.stringify(body);
  return app().inject({
    method: "POST",
    url,
    payload: raw,
    headers: { "content-type": "application/json", ...mockWebhookHeaders(env().MOCK_HMAC_SECRET, raw, tsSeconds) },
  });
}

/** SMART + capped wallet + signed base rules → a small merchant order is AUTO via a one-time card. */
async function issuedCard() {
  const { userId, auth } = await createUserWithPasskey({ moneyMode: "CAPPED_WALLET" });
  const shop = await addPayee(userId, { name: "Pizza Shop in Budapest", kind: "MERCHANT", account: "pizza shop in", currency: "HUF" });
  await signBaseRules(userId, auth);
  const r = await proposeOrder({ userId, createdBy: "USER", payeeId: shop.id, amountMinor: 450_000, currency: "HUF", purpose: "Pizza" });
  expect(r.decision).toBe("AUTO");
  const card = (await getDb().select().from(issuedCards))[0]!;
  return { userId, card };
}

describe("mock webhooks HMAC (I13)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.setOffsetInMemoryForTests(0);
  });

  it("accepts a valid signature and rejects a bad one / a missing one", async () => {
    expect((await signed("/api/webhooks/mock/pos", { sku: "dough", level: "low" })).statusCode).toBe(200);
    const bad = await app().inject({
      method: "POST",
      url: "/api/webhooks/mock/pos",
      payload: JSON.stringify({ sku: "dough" }),
      headers: { "content-type": "application/json", "x-kassa-timestamp": String(Math.floor(clock.nowMs() / 1000)), "x-kassa-signature": "00".repeat(32) },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe("WEBHOOK_SIGNATURE_INVALID");
    const none = await app().inject({ method: "POST", url: "/api/webhooks/mock/pos", payload: { sku: "dough" } });
    expect(none.statusCode).toBe(401);
  });

  it("rejects a body altered after signing", async () => {
    const raw = JSON.stringify({ amountMinor: 1 });
    const headers = mockWebhookHeaders(env().MOCK_HMAC_SECRET, raw, Math.floor(clock.nowMs() / 1000));
    const res = await app().inject({ method: "POST", url: "/api/webhooks/mock/pos", payload: JSON.stringify({ amountMinor: 1000 }), headers: { "content-type": "application/json", ...headers } });
    expect(res.statusCode).toBe(401);
  });

  it("enforces the 5-minute window against the DEMO clock", async () => {
    const old = Math.floor(clock.nowMs() / 1000) - 301;
    expect((await signed("/api/webhooks/mock/pos", { a: 1 }, old)).json().code).toBe("WEBHOOK_REPLAY_WINDOW");
    // After a +3 day demo jump, mock-world signs with demo time: still valid.
    clock.setOffsetInMemoryForTests(3 * 86_400_000);
    expect((await signed("/api/webhooks/mock/pos", { a: 1 })).statusCode).toBe(200);
    clock.setOffsetInMemoryForTests(0);
  });

  it("Stripe webhook without configuration is refused (no unsigned path)", async () => {
    const res = await app().inject({ method: "POST", url: "/api/webhooks/stripe", payload: { type: "issuing_authorization.request" } });
    expect(res.statusCode).toBe(503);
  });
});

describe("FakeIssuing one-time card", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.setOffsetInMemoryForTests(0);
  });

  it("approves the exact charge once, declines the second, then the payment is SENT", async () => {
    const { userId, card } = await issuedCard();
    const charge = (over: Record<string, unknown> = {}) =>
      signed("/api/rails/fake-issuing/authorize", {
        authorizationId: crypto.randomUUID(),
        cardId: card.stripeCardId,
        amountMinor: 450_000,
        currency: "HUF",
        merchant: { name: "Pizza Shop in Budapest", mcc: "5814", city: "Budapest", country: "HU" },
        occurredAt: clock.now().toISOString(),
        ...over,
      });
    expect((await charge({ amountMinor: 450_001 })).json()).toEqual({ approved: false, reasonCode: "AMOUNT_OVER_LIMIT" });
    expect((await charge({ currency: "EUR" })).json()).toEqual({ approved: false, reasonCode: "CURRENCY_MISMATCH" });
    expect((await charge({ merchant: { name: "Burger Place" } })).json()).toEqual({ approved: false, reasonCode: "MERCHANT_MISMATCH" });
    expect((await charge()).json()).toEqual({ approved: true });
    expect((await charge()).json()).toEqual({ approved: false, reasonCode: "CARD_ALREADY_USED" });
    const p = (await getDb().select().from(payments).where(eq(payments.userId, userId)))[0]!;
    expect(p.status).toBe("SENT");
    const tx = await getDb().select().from(transactions).where(eq(transactions.paymentId, p.id));
    expect(tx[0]).toMatchObject({ source: "KASSA_PAYMENT", amountMinor: 450_000, currency: "HUF" });
  });

  it("declines an expired card (15 min, Clock)", async () => {
    const { card } = await issuedCard();
    clock.setOffsetInMemoryForTests(16 * 60_000);
    const res = await signed("/api/rails/fake-issuing/authorize", { cardId: card.stripeCardId, amountMinor: 450_000, currency: "HUF", merchant: { name: "Pizza Shop in Budapest" } });
    expect(res.json()).toEqual({ approved: false, reasonCode: "CARD_EXPIRED" });
    clock.setOffsetInMemoryForTests(0);
  });

  it("the authorize endpoint itself requires the HMAC", async () => {
    const { card } = await issuedCard();
    const res = await app().inject({ method: "POST", url: "/api/rails/fake-issuing/authorize", payload: { cardId: card.stripeCardId, amountMinor: 450_000, currency: "HUF", merchant: { name: "Pizza Shop in Budapest" } } });
    expect(res.statusCode).toBe(401);
  });
});
