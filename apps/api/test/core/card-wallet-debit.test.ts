/*
 * (added 2026-10-19) A one-time card charge is paid from the user's mock-bank wallet: Kassa's issuer approves only once
 * the wallet is debited (same currency, or another balance converted at the bank's price), declines INSUFFICIENT_FUNDS
 * with nothing debited when no balance covers it, and a replayed authorization debits once. The card checks (merchant,
 * amount cap, expiry, single use) still come first.
 */
import { mockWebhookHeaders } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { issuedCards, ledgerEntries, payments } from "../../src/db/schema.ts";
import { env } from "../../src/env.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { setMockWorldTransportForTests } from "../../src/modules/rails/http.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { ensureWalletProfile } from "../../src/modules/wallet/service.ts";
import { useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, offlineEnvironment, signBaseRules, useRealCardDebit } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;

beforeEach(async () => {
  await t.reset();
  offlineEnvironment();
  useRealCardDebit();
  clock.setOffsetInMemoryForTests(0);
  mw = await startMockWorld();
});
afterEach(async () => {
  await mw.close();
});

/** A wallet user with the given balances and an approved HUF 4,500 pizza order → one-time card. */
async function cardFor(balances: { currency: string; amountMinor: number }[]) {
  const { userId, auth } = await createUserWithPasskey({ moneyMode: "CAPPED_WALLET" });
  const profile = await ensureWalletProfile(userId);
  for (const b of balances) await mw.bank.credit(profile, b.currency, b.amountMinor);
  const shop = await addPayee(userId, { name: "Pizza Shop in Budapest", kind: "MERCHANT", account: "pizza shop in", currency: "HUF" });
  await signBaseRules(userId, auth);
  const r = await proposeOrder({ userId, createdBy: "USER", payeeId: shop.id, amountMinor: 450_000, currency: "HUF", purpose: "Pizza" });
  // AUTO (small-auto) or, for a first payment to the shop, approved with the passkey: either way a one-time card.
  if (r.decision === "ASK") await approveOrder(userId, r.proposalId, auth.assert((await getOrderView(userId, r.proposalId)).orderHash));
  else expect(r.decision).toBe("AUTO");
  const card = (await getDb().select().from(issuedCards).where(eq(issuedCards.userId, userId)))[0]!;
  const balance = async (currency: string) => (await mw.bank.listBalances(profile)).find((b) => b.currency === currency)?.amount.valueMinor ?? 0;
  return { userId, profile, card, balance };
}

/** What the FakeIssuerClient sends (HMAC-signed body). */
function authorize(cardId: string, over: Record<string, unknown> = {}) {
  const raw = JSON.stringify({
    authorizationId: crypto.randomUUID(),
    cardId,
    amountMinor: 450_000,
    currency: "HUF",
    merchant: { name: "Pizza Shop in Budapest", mcc: "5814", city: "Budapest", country: "HU" },
    occurredAt: clock.now().toISOString(),
    ...over,
  });
  return app().inject({
    method: "POST",
    url: "/api/rails/fake-issuing/authorize",
    payload: raw,
    headers: { "content-type": "application/json", ...mockWebhookHeaders(env().MOCK_HMAC_SECRET, raw, Math.floor(clock.nowMs() / 1000)) },
  });
}

const authorizations = async () => (await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "CARD_AUTHORIZATION"))).map((e) => e.payload as Record<string, unknown>);

describe("card charges debit the wallet", () => {
  it("same currency: approved, the HUF balance pays exactly the charge, the payment is SENT", async () => {
    const { userId, card, balance } = await cardFor([{ currency: "HUF", amountMinor: 1_000_000 }, { currency: "EUR", amountMinor: 10_000 }]);
    expect((await authorize(card.stripeCardId)).json()).toEqual({ approved: true });
    expect(await balance("HUF")).toBe(550_000);
    expect(await balance("EUR")).toBe(10_000);
    expect((await getDb().select().from(payments).where(eq(payments.userId, userId)))[0]!.status).toBe("SENT");
    expect(await authorizations()).toEqual([expect.objectContaining({ approved: true, walletDebit: { currency: "HUF", amountMinor: 450_000, replayed: false } })]);
  });

  it("no HUF balance: another balance pays the bank's conversion price (FX from the mock bank's rates)", async () => {
    const { profile, card, balance } = await cardFor([{ currency: "EUR", amountMinor: 10_000 }]);
    const quote = await mw.bank.createQuote(profile, { sourceCurrency: "EUR", targetCurrency: "HUF", targetAmountMinor: 450_000 });
    expect((await authorize(card.stripeCardId)).json()).toEqual({ approved: true });
    expect(await balance("EUR")).toBe(10_000 - quote.sourceAmountMinor);
    expect(quote.sourceAmountMinor).toBeGreaterThan(1_146); // HUF 4,500 ≈ EUR 11.46 at the fixture mid rate, plus markup and fee
    expect(await authorizations()).toEqual([expect.objectContaining({ approved: true, walletDebit: { currency: "EUR", amountMinor: quote.sourceAmountMinor, replayed: false } })]);
  });

  it("no balance covers it: declined INSUFFICIENT_FUNDS, nothing debited, the card stays usable until it expires", async () => {
    const { userId, profile, card, balance } = await cardFor([{ currency: "HUF", amountMinor: 400_000 }, { currency: "EUR", amountMinor: 100 }]);
    expect((await authorize(card.stripeCardId)).json()).toEqual({ approved: false, reasonCode: "INSUFFICIENT_FUNDS" });
    expect(await balance("HUF")).toBe(400_000);
    expect(await balance("EUR")).toBe(100);
    expect((await getDb().select().from(issuedCards).where(eq(issuedCards.stripeCardId, card.stripeCardId)))[0]!.usedAt).toBeNull();
    expect((await getDb().select().from(payments).where(eq(payments.userId, userId)))[0]!.status).not.toBe("SENT");
    // Topped up: the next authorization goes through and debits once.
    await mw.bank.credit(profile, "HUF", 100_000);
    expect((await authorize(card.stripeCardId)).json()).toEqual({ approved: true });
    expect(await balance("HUF")).toBe(50_000);
    expect((await authorizations()).map((a) => a.reasonCodes)).toEqual([["INSUFFICIENT_FUNDS"], []]);
  });

  it("a replayed authorization debits once (declined CARD_ALREADY_USED, and the bank keys the debit by authorization id)", async () => {
    const { profile, card, balance } = await cardFor([{ currency: "HUF", amountMinor: 1_000_000 }]);
    const authorizationId = crypto.randomUUID();
    expect((await authorize(card.stripeCardId, { authorizationId })).json()).toEqual({ approved: true });
    expect((await authorize(card.stripeCardId, { authorizationId })).json()).toEqual({ approved: false, reasonCode: "CARD_ALREADY_USED" });
    expect(await balance("HUF")).toBe(550_000);
    // The bank itself, asked again for the same authorization: the recorded debit, nothing moves.
    const again = await mw.app.inject({
      method: "POST",
      url: "/mock/bank/card-debits",
      payload: { profileId: profile, authorizationId, cardId: card.stripeCardId, amountMinor: 450_000, currency: "HUF" },
    });
    expect(again.json()).toMatchObject({ created: false, debited: { currency: "HUF", valueMinor: 450_000 } });
    expect(await balance("HUF")).toBe(550_000);
  });

  it("the card checks still come first: a charge over the cap or at another merchant is declined without touching the wallet", async () => {
    const { card, balance } = await cardFor([{ currency: "HUF", amountMinor: 1_000_000 }]);
    expect((await authorize(card.stripeCardId, { amountMinor: 450_001 })).json()).toEqual({ approved: false, reasonCode: "AMOUNT_OVER_LIMIT" });
    expect((await authorize(card.stripeCardId, { merchant: { name: "Burger Place" } })).json()).toEqual({ approved: false, reasonCode: "MERCHANT_MISMATCH" });
    expect(await balance("HUF")).toBe(1_000_000);
  });

  it("the bank cannot be reached: declined RAIL_ERROR (fail closed), card released", async () => {
    const { card, balance } = await cardFor([{ currency: "HUF", amountMinor: 1_000_000 }]);
    setMockWorldTransportForTests(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect((await authorize(card.stripeCardId)).json()).toEqual({ approved: false, reasonCode: "RAIL_ERROR" });
    expect((await getDb().select().from(issuedCards).where(eq(issuedCards.stripeCardId, card.stripeCardId)))[0]!.usedAt).toBeNull();
    expect(await balance("HUF")).toBe(1_000_000);
  });
});
