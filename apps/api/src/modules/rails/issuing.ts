/*
 * One-time virtual cards (spec §11 Stripe Issuing + FakeIssuing). Same interface and the SAME
 * authorization logic for both providers (`authorizeCardUse`): approve only if the card is unused,
 * not canceled, not expired (Clock), the currency matches, amount ≤ max, and
 * normalize(merchant) == expectedMerchantNorm. Deterministic, no LLM, a handful of indexed queries
 * (Stripe real-time authorization budget, target < 1 s).
 */
import type { CanonicalOrder, ReasonCode } from "@kassa/shared";
import { and, eq, isNull, lt } from "drizzle-orm";
import { randomBytes, randomInt } from "node:crypto";
import Stripe from "stripe";

import { getDb } from "../../db/client.ts";
import { issuedCards, profiles, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { addMs, clock, MINUTE_MS } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { sealPii } from "../privacy/keys.ts";
import { toHome } from "../money/fx.ts";
import { updatePaymentStatus } from "../payments/status.ts";
import { normalizeName } from "../screening/normalize.ts";
import type { ExecCtx, Rail, RailResult } from "./types.ts";

export const CARD_TTL_MS = 15 * MINUTE_MS;

/** Merchant normalisation for card matching: transliterate, lowercase, strip legal suffixes. */
export function normalizeMerchant(name: string): string {
  return normalizeName(name, { stripLegal: true });
}

let stripeClient: Stripe | null = null;
export function stripe(): Stripe {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  stripeClient ??= new Stripe(key);
  return stripeClient;
}

async function ensureCardholder(userId: string): Promise<string> {
  const db = getDb();
  const p = (await db.select({ id: profiles.stripeCardholderId }).from(profiles).where(eq(profiles.userId, userId)))[0];
  if (p?.id) return p.id;
  const u = (await db.select({ name: users.displayName }).from(users).where(eq(users.id, userId)))[0];
  // Test cardholder; the address is a fictitious Budapest address (Issuing requires one).
  const ch = await stripe().issuing.cardholders.create({
    type: "individual",
    name: (u?.name ?? "Kassa User").slice(0, 24),
    billing: { address: { line1: "Example utca 1", city: "Budapest", postal_code: "1051", country: "HU" } },
    metadata: { kassaUserId: userId },
  });
  await db.update(profiles).set({ stripeCardholderId: ch.id }).where(eq(profiles.userId, userId));
  return ch.id;
}

export const issuingRail: Rail = {
  id: "CARD_ISSUING",
  async execute(order: CanonicalOrder, ctx: ExecCtx): Promise<RailResult> {
    const provider = env().ISSUING_PROVIDER;
    const expiresAt = addMs(ctx.now, CARD_TTL_MS);
    let cardId: string;
    let last4: string;
    if (provider === "stripe") {
      // EU Issuing cards are denominated in the issuing balance currency (EUR); a HUF charge is converted
      // by Stripe. The Stripe-side limit is the order amount converted at mid + 3% headroom; OUR check in
      // authorizeCardUse compares the merchant amount/currency against the exact signed order.
      const cardCurrency = env().STRIPE_ISSUING_CURRENCY;
      const limit =
        cardCurrency === order.currency
          ? order.amountMinor
          : Math.ceil(((await toHome(order.amountMinor, order.currency, cardCurrency, ctx.now)).amountMinor * 103) / 100);
      const card = await stripe().issuing.cards.create({
        cardholder: await ensureCardholder(order.userId),
        currency: cardCurrency.toLowerCase(),
        type: "virtual",
        status: "active",
        spending_controls: {
          spending_limits: [
            { amount: limit, interval: "per_authorization" },
            { amount: limit, interval: "all_time" },
          ],
        },
        metadata: { kassaPaymentId: ctx.paymentId, kassaProposalId: order.proposalId },
      });
      cardId = card.id;
      last4 = card.last4;
    } else {
      cardId = `fic_${randomBytes(12).toString("hex")}`;
      last4 = String(randomInt(0, 10_000)).padStart(4, "0");
    }
    await ctx.db.insert(issuedCards).values({
      stripeCardId: cardId,
      approvalId: ctx.approvalId,
      expectedMerchantNorm: normalizeMerchant(order.payeeName),
      maxAmountMinor: order.amountMinor,
      currency: order.currency,
      expiresAt,
      paymentId: ctx.paymentId,
      userId: order.userId,
      provider,
      last4,
      createdAt: ctx.now,
    });
    return {
      status: "PROCESSING",
      railRef: cardId,
      details: { cardId, last4, provider, expiresAt: expiresAt.toISOString(), simulated: provider === "fake" },
    };
  },
};

export type AuthorizationRequest = { cardId: string; amountMinor: number; currency: string; merchantName: string };
export type AuthorizationDecision = { approved: boolean; reasonCode: ReasonCode | null; paymentId: string | null };

/**
 * Decide an authorization. On approval the card is marked used immediately (single use: a second
 * authorization is declined CARD_ALREADY_USED even before the transaction settles).
 */
export async function authorizeCardUse(req: AuthorizationRequest): Promise<AuthorizationDecision> {
  const db = getDb();
  const now = clock.now();
  const card = (await db.select().from(issuedCards).where(eq(issuedCards.stripeCardId, req.cardId)))[0];
  let reason: ReasonCode | null = null;
  if (!card) reason = "NO_APPROVAL";
  else if (card.usedAt) reason = "CARD_ALREADY_USED";
  else if (card.canceledAt || card.expiresAt.getTime() <= now.getTime()) reason = "CARD_EXPIRED";
  else if (card.currency !== req.currency.toUpperCase()) reason = "CURRENCY_MISMATCH";
  else if (!Number.isSafeInteger(req.amountMinor) || req.amountMinor <= 0 || req.amountMinor > card.maxAmountMinor) {
    reason = "AMOUNT_OVER_LIMIT";
  } else if (normalizeMerchant(req.merchantName) !== card.expectedMerchantNorm) reason = "MERCHANT_MISMATCH";

  if (!reason && card) {
    // Atomic single use: only one concurrent authorization can flip usedAt.
    const won = await db
      .update(issuedCards)
      .set({ usedAt: now })
      .where(and(eq(issuedCards.stripeCardId, card.stripeCardId), isNull(issuedCards.usedAt)))
      .returning({ id: issuedCards.stripeCardId });
    if (won.length === 0) reason = "CARD_ALREADY_USED";
  }
  const approved = reason === null;
  await ledger.append("CARD_AUTHORIZATION", {
    userId: card?.userId ?? null,
    paymentId: card?.paymentId ?? null,
    cardId: req.cardId,
    amountMinor: req.amountMinor,
    currency: req.currency,
    // Merchant of the user's purchase is personal: sealed with the user's key; unknown cards have no owner.
    ...(card?.userId ? await sealPii(card.userId, { merchantNorm: normalizeMerchant(req.merchantName) }) : { merchantNorm: normalizeMerchant(req.merchantName) }),
    approved,
    reasonCodes: reason ? [reason] : [],
  });
  return { approved, reasonCode: reason, paymentId: card?.paymentId ?? null };
}

/** After capture (Stripe issuing_transaction.created, or immediately for FakeIssuing): settle + cancel. */
export async function settleCard(cardId: string, merchantName: string): Promise<void> {
  const db = getDb();
  const card = (await db.select().from(issuedCards).where(eq(issuedCards.stripeCardId, cardId)))[0];
  if (!card) return;
  await cancelCard(card.stripeCardId, card.provider, "used");
  await updatePaymentStatus(card.paymentId, "SENT", { source: `issuing:${card.provider}`, merchantName });
}

async function cancelCard(cardId: string, provider: string, why: string): Promise<void> {
  const db = getDb();
  const now = clock.now();
  const rows = await db
    .update(issuedCards)
    .set({ canceledAt: now })
    .where(and(eq(issuedCards.stripeCardId, cardId), isNull(issuedCards.canceledAt)))
    .returning();
  if (rows.length === 0) return;
  if (provider === "stripe") {
    try {
      await stripe().issuing.cards.update(cardId, { status: "canceled" });
    } catch (err) {
      console.warn(`[issuing] cancel ${cardId} failed: ${(err as Error).message}`);
    }
  }
  await ledger.append("CARD_CANCELED", { userId: rows[0]!.userId, paymentId: rows[0]!.paymentId, cardId, why });
}

/** Scheduler job (spec §11 step 6): cancel unused cards after expiresAt; the payment is CANCELED. */
export async function expireCards(): Promise<number> {
  const db = getDb();
  const now = clock.now();
  const due = await db
    .select()
    .from(issuedCards)
    .where(and(isNull(issuedCards.usedAt), isNull(issuedCards.canceledAt), lt(issuedCards.expiresAt, now)));
  for (const c of due) {
    await cancelCard(c.stripeCardId, c.provider, "expired");
    await updatePaymentStatus(c.paymentId, "CANCELED", { source: "card-expiry", reasonCodes: ["CARD_EXPIRED"] });
  }
  return due.length;
}

/** FakeIssuing checkout (mock shop → POST /api/webhooks/mock/issuing): authorize and, if approved, capture. */
export async function fakeCharge(req: AuthorizationRequest): Promise<AuthorizationDecision> {
  const d = await authorizeCardUse(req);
  if (d.approved) await settleCard(req.cardId, req.merchantName);
  return d;
}
