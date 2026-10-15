/*
 * The pull leg of a send from a linked account: charge the card (Stripe test PaymentIntent, off session, with the
 * saved PaymentMethod) or debit the bank (mock bank, simulated), then credit the same amount to the user's wallet in
 * the sandbox bank, from where the bank rail pays out as for any wallet send. Both legs are ledgered by the caller.
 *
 * Idempotent per `reference` (Stripe idempotency key; the mock bank's top-up reference), so a retried execution
 * pulls once. A decline throws PullDeclined and nothing is credited.
 */
import { randomUUID } from "node:crypto";

import { env } from "../../env.ts";
import { stripe } from "../rails/issuing.ts";
import { creditWallet } from "../wallet/service.ts";
import type { FundingSourceRow } from "./store.ts";

export class PullDeclined extends Error {}

export type PullResult = { providerRef: string; simulated: boolean; balanceAfterMinor: number | null };

/** Charge the card or debit the bank (no wallet credit). Throws PullDeclined on a decline. */
export async function chargeSource(source: FundingSourceRow, amountMinor: number, currency: string, reference: string): Promise<{ ref: string; simulated: boolean }> {
  if (source.kind === "BANK") return { ref: `sim_bank_debit_${randomUUID()}`, simulated: true };
  if (source.simulated || !env().stripeEnabled || !source.providerRef || !source.providerCustomer) {
    // A simulated test card behaves like Stripe's: the "declined" card declines every charge.
    if (source.providerRef === "pm_card_visa_chargeDeclined") throw new PullDeclined("Your card was declined (test card)");
    return { ref: `sim_card_charge_${randomUUID()}`, simulated: true };
  }
  try {
    const pi = await stripe().paymentIntents.create(
      {
        amount: amountMinor,
        currency: currency.toLowerCase(),
        customer: source.providerCustomer,
        payment_method: source.providerRef,
        off_session: true,
        confirm: true,
        description: "Kassa send from a linked card (test mode)",
        metadata: { kassaUserId: source.userId, kassaFundingSource: source.id, kassaPull: reference },
      },
      { idempotencyKey: `kassa-pull-${reference}` },
    );
    if (pi.status !== "succeeded") throw new PullDeclined(`The card charge did not succeed (${pi.status})`);
    return { ref: pi.id, simulated: false };
  } catch (err) {
    if (err instanceof PullDeclined) throw err;
    const e = err as { type?: string; message?: string };
    if (e.type === "StripeCardError") throw new PullDeclined(e.message ?? "Your card was declined");
    throw err;
  }
}

export async function pullIntoWallet(source: FundingSourceRow, amountMinor: number, currency: string, reference: string): Promise<PullResult> {
  if (source.currency !== currency) throw new PullDeclined(`This account pays in ${source.currency}, not ${currency}`);
  const c = await chargeSource(source, amountMinor, currency, reference);
  const balanceAfterMinor = await creditWallet(source.userId, currency, amountMinor, `pull:${reference}`);
  return { providerRef: c.ref, simulated: c.simulated, balanceAfterMinor };
}
