/*
 * The pull leg of a send from a linked account: charge the card (Stripe test PaymentIntent, off session, with the
 * saved PaymentMethod) or debit the bank (mock bank, simulated), then credit the same amount to the user's wallet in
 * the sandbox bank, from where the bank rail pays out as for any wallet send. Both legs are ledgered by the caller.
 *
 * A simulated pull (every bank account; a card when Stripe test keys are not set or the card was saved without them)
 * debits the linked account's simulated balance (linked_account_sim_balances, seeded on the first pull with
 * SIMULATED_LINKED_BALANCE) and is refused when that balance is short (LinkedBalanceShort), so a linked account
 * cannot add money that was never there. Only a real Stripe test-mode charge skips it.
 *
 * Idempotent per `reference` (Stripe idempotency key; the simulated debit's key; the mock bank's top-up reference), so
 * a retried execution pulls once. A decline throws PullDeclined and nothing is credited.
 */
import { randomUUID } from "node:crypto";

import { toMinor } from "@kassa/shared";
import { and, eq, gte, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { linkedAccountSimBalances, linkedAccountSimDebits } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { clock } from "../clock/index.ts";
import { stripe } from "../rails/issuing.ts";
import { creditWallet } from "../wallet/service.ts";
import type { FundingSourceRow } from "./store.ts";

export class PullDeclined extends Error {}

/** A simulated pull the linked account's simulated balance cannot cover. */
export class LinkedBalanceShort extends PullDeclined {
  constructor(
    readonly availableMinor: number,
    readonly currency: string,
  ) {
    super(`This linked account does not have enough (simulated) money for that: ${availableMinor} ${currency} minor units left`);
  }
}

/**
 * What a linked account holds before its first simulated pull, in major units of its currency (test money): about
 * EUR 10,000 each, enough for the demo's tuition and rent from a linked card, finite so pulls cannot go on forever.
 */
export const SIMULATED_LINKED_BALANCE: Readonly<Record<string, string>> = { KZT: "5000000", HUF: "4000000", CNY: "75000", EUR: "10000", USD: "10000" };

export function simulatedSeedMinor(currency: string): number {
  try {
    return toMinor(SIMULATED_LINKED_BALANCE[currency] ?? "10000", currency);
  } catch {
    return 1_000_000;
  }
}

/** The underlying account, not the source row: unlinking and linking the same account again keeps its balance. */
export function simAccountKey(source: Pick<FundingSourceRow, "id" | "kind" | "providerRef">): string {
  return `${source.kind}:${source.providerRef ?? source.id}`;
}

/**
 * Debit the simulated balance once per (user, reference), atomically: the debit row is claimed first (a concurrent
 * or retried pull with the same reference returns the first one's ref), then the balance goes down only if it covers
 * the amount; a short balance rolls the claim back and throws LinkedBalanceShort.
 */
async function debitSimulated(source: FundingSourceRow, amountMinor: number, currency: string, reference: string, refPrefix: string): Promise<string> {
  const accountKey = simAccountKey(source);
  return getDb().transaction(async (tx) => {
    const seed = simulatedSeedMinor(currency);
    await tx.insert(linkedAccountSimBalances).values({ userId: source.userId, accountKey, currency, balanceMinor: seed, seededMinor: seed }).onConflictDoNothing();
    const providerRef = `${refPrefix}_${randomUUID()}`;
    const claimed = await tx
      .insert(linkedAccountSimDebits)
      .values({ userId: source.userId, reference, accountKey, currency, amountMinor, providerRef, createdAt: clock.now() })
      .onConflictDoNothing()
      .returning({ providerRef: linkedAccountSimDebits.providerRef });
    if (claimed.length === 0) {
      const prior = (await tx.select().from(linkedAccountSimDebits).where(and(eq(linkedAccountSimDebits.userId, source.userId), eq(linkedAccountSimDebits.reference, reference))))[0]!;
      if (prior.accountKey !== accountKey || prior.amountMinor !== amountMinor || prior.currency !== currency) throw new PullDeclined("This pull reference was already used for a different pull");
      return prior.providerRef;
    }
    const key = and(eq(linkedAccountSimBalances.userId, source.userId), eq(linkedAccountSimBalances.accountKey, accountKey), eq(linkedAccountSimBalances.currency, currency));
    const debited = await tx
      .update(linkedAccountSimBalances)
      .set({ balanceMinor: sql`${linkedAccountSimBalances.balanceMinor} - ${amountMinor}`, updatedAt: clock.now() })
      .where(and(key, gte(linkedAccountSimBalances.balanceMinor, amountMinor)))
      .returning({ balanceMinor: linkedAccountSimBalances.balanceMinor });
    if (debited.length === 0) {
      const row = (await tx.select({ balanceMinor: linkedAccountSimBalances.balanceMinor }).from(linkedAccountSimBalances).where(key))[0];
      throw new LinkedBalanceShort(row?.balanceMinor ?? 0, currency);
    }
    return providerRef;
  });
}

/** The simulated balance a linked account has left (its seed before the first pull). */
export async function simulatedBalanceOf(source: FundingSourceRow): Promise<number> {
  const row = (
    await getDb()
      .select({ balanceMinor: linkedAccountSimBalances.balanceMinor })
      .from(linkedAccountSimBalances)
      .where(and(eq(linkedAccountSimBalances.userId, source.userId), eq(linkedAccountSimBalances.accountKey, simAccountKey(source)), eq(linkedAccountSimBalances.currency, source.currency)))
  )[0];
  return row?.balanceMinor ?? simulatedSeedMinor(source.currency);
}

export type PullResult = { providerRef: string; simulated: boolean; balanceAfterMinor: number | null };

/**
 * Charge the card or debit the bank (no wallet credit). Throws PullDeclined on a decline, LinkedBalanceShort when a
 * simulated pull is more than the account's simulated balance.
 */
export async function chargeSource(source: FundingSourceRow, amountMinor: number, currency: string, reference: string): Promise<{ ref: string; simulated: boolean }> {
  if (source.kind === "BANK") return { ref: await debitSimulated(source, amountMinor, currency, reference, "sim_bank_debit"), simulated: true };
  if (source.simulated || !env().stripeEnabled || !source.providerRef || !source.providerCustomer) {
    // A simulated test card behaves like Stripe's: the "declined" card declines every charge.
    if (source.providerRef === "pm_card_visa_chargeDeclined") throw new PullDeclined("Your card was declined (test card)");
    return { ref: await debitSimulated(source, amountMinor, currency, reference, "sim_card_charge"), simulated: true };
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
