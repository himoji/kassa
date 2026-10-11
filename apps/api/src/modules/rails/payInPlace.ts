/*
 * Pay in place (spec §11): a Stripe PaymentIntent (test mode) for the exact order amount; the app
 * confirms it (Payment Element / PaymentSheet). On payment_intent.succeeded, payments proceeds to issue
 * the one-time card for that order (issuing rail, same payment row). Without Stripe keys a simulated
 * intent is used ("fake_pi_…"), confirmed by the demo endpoint.
 */
import type { CanonicalOrder } from "@kassa/shared";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { payees, payments, proposals } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { decryptAccount } from "../payees/crypto.ts";
import { updatePaymentStatus } from "../payments/status.ts";
import { issuingRail, stripe } from "./issuing.ts";
import type { ExecCtx, Rail, RailResult } from "./types.ts";

export const payInPlaceRail: Rail = {
  id: "PAY_IN_PLACE",
  async execute(order: CanonicalOrder, ctx: ExecCtx): Promise<RailResult> {
    if (env().stripeEnabled) {
      const pi = await stripe().paymentIntents.create({
        amount: order.amountMinor,
        currency: order.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: { kassaPaymentId: ctx.paymentId, kassaProposalId: order.proposalId },
      });
      return { status: "CREATED", railRef: pi.id, details: { intentId: pi.id, provider: "stripe" } };
    }
    const id = `fake_pi_${randomBytes(12).toString("hex")}`;
    return {
      status: "CREATED",
      railRef: id,
      details: { intentId: id, provider: "fake", clientSecret: `${id}_secret_${randomBytes(8).toString("hex")}`, simulated: true },
    };
  },
};

/** Client secret for the app (POST /payments/:id/intent). */
export async function intentClientSecret(details: Record<string, unknown>): Promise<{ clientSecret: string; publishableKey: string }> {
  const e = env();
  if (details.provider === "stripe" && typeof details.intentId === "string") {
    const pi = await stripe().paymentIntents.retrieve(details.intentId);
    if (!pi.client_secret) throw new Error("PaymentIntent has no client secret");
    return { clientSecret: pi.client_secret, publishableKey: e.STRIPE_PUBLISHABLE_KEY ?? "" };
  }
  return { clientSecret: String(details.clientSecret ?? ""), publishableKey: e.STRIPE_PUBLISHABLE_KEY ?? "pk_test_simulated" };
}

/** payment_intent.succeeded (Stripe webhook or simulated confirm): issue the one-time card. */
export async function onIntentSucceeded(intentId: string): Promise<boolean> {
  const db = getDb();
  const p = (await db.select().from(payments).where(eq(payments.railRef, intentId)))[0];
  if (!p || p.rail !== "PAY_IN_PLACE" || p.status !== "CREATED") return false;
  const prop = (await db.select().from(proposals).where(eq(proposals.id, p.proposalId)))[0];
  const order = prop?.canonicalOrder;
  if (!order) return false;
  const payee = (await db.select().from(payees).where(eq(payees.id, order.payeeId)))[0];
  // No account details (onboarding placeholder): nothing to pay to; rules and payments refuse such orders earlier.
  if (!payee || payee.accountEnc === null) return false;
  await ledger.append("PAY_IN_PLACE_SUCCEEDED", { userId: p.userId, paymentId: p.id, intentId });
  const card = await issuingRail.execute(order, {
    db,
    paymentId: p.id,
    approvalId: p.approvalId,
    now: clock.now(),
    payee: { id: payee.id, name: payee.name, kind: payee.kind, account: decryptAccount(payee.userId, payee.accountEnc) },
  });
  await updatePaymentStatus(p.id, "PROCESSING", { source: "pay-in-place", details: { card: card.details, intentId } });
  return true;
}
