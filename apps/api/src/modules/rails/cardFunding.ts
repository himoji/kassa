/*
 * (added 2026-10-19) A one-time card charge is paid from the user's wallet. Kassa's issuer (authorizeCardUse) asks the
 * mock bank to debit the wallet once it has re-verified the card; the authorization is approved only if the debit
 * succeeded. The mock bank picks the balance (the charge currency when it covers it, else the cheapest covering
 * balance converted at the bank's own price, apps/mock-world/src/bank/bank.ts cardDebit) and is idempotent per
 * authorization id, so a retried call never debits twice.
 *
 * With the Wise sandbox there is no wallet to debit by card (its balances are Wise's): SKIPPED, the card checks alone
 * decide, as before.
 */
import { bankMode } from "./bankApi.ts";
import { mockWorld, MockWorldError } from "./http.ts";
import { bankProfileFor } from "./mockBank.ts";

export type CardDebitRequest = { userId: string; cardId: string; authorizationId: string; amountMinor: number; currency: string };

export type CardDebitOutcome =
  | { kind: "DEBITED"; currency: string; amountMinor: number; balanceAfterMinor: number; created: boolean }
  | { kind: "SKIPPED" }
  /** No balance covers the charge (mock bank 422). */
  | { kind: "INSUFFICIENT" }
  /** The bank refused it (no wallet, a different charge already on this card) or could not be reached. */
  | { kind: "FAILED"; error: string };

type CardDebitResponse = { debited?: { valueMinor?: unknown; currency?: unknown }; balanceAfterMinor?: unknown; created?: unknown };

let override: ((req: CardDebitRequest) => Promise<CardDebitOutcome>) | null = null;

/** Tests without a mock world (offlineEnvironment) stand in for the bank; null restores the real call. */
export function setCardDebitForTests(fn: ((req: CardDebitRequest) => Promise<CardDebitOutcome>) | null): void {
  override = fn;
}

async function call(profile: number, req: CardDebitRequest): Promise<CardDebitResponse> {
  return mockWorld<CardDebitResponse>("POST", "/bank/card-debits", {
    profileId: profile,
    authorizationId: req.authorizationId,
    cardId: req.cardId,
    amountMinor: req.amountMinor,
    currency: req.currency,
  });
}

/** Debit the wallet for an approved card charge. Never throws: anything but DEBITED/SKIPPED must decline. */
export async function debitWalletForCard(req: CardDebitRequest): Promise<CardDebitOutcome> {
  if (override) return override(req);
  if (bankMode() !== "mock") return { kind: "SKIPPED" };
  try {
    const profile = await bankProfileFor(req.userId);
    let r: CardDebitResponse;
    try {
      r = await call(profile, req);
    } catch (err) {
      // An answer from the bank is final; a lost one (timeout, 5xx) is retried once with the same key, which debits
      // at most once either way.
      if (err instanceof MockWorldError && err.status < 500) throw err;
      r = await call(profile, req);
    }
    const valueMinor = r.debited?.valueMinor;
    const currency = r.debited?.currency;
    if (typeof valueMinor !== "number" || typeof currency !== "string" || typeof r.balanceAfterMinor !== "number") {
      return { kind: "FAILED", error: "malformed card debit answer" };
    }
    return { kind: "DEBITED", currency, amountMinor: valueMinor, balanceAfterMinor: r.balanceAfterMinor, created: r.created === true };
  } catch (err) {
    if (err instanceof MockWorldError && err.status === 422) return { kind: "INSUFFICIENT" };
    return { kind: "FAILED", error: (err as Error).message };
  }
}
