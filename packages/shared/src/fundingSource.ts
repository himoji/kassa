/*
 * (added 2026-10-16) Linked accounts ("funding sources"): a card or bank account the user links once and then sends
 * from, next to the Kassa wallet. Linking is a new way for money to move, so it is confirmed with the payments
 * passkey (challenge = linkHash), and a bank account also proves it is the user's with a one-tenge code (simulated).
 * A send from a linked account binds `fundingSourceId` into the signed order (order.ts): payments pulls the signed
 * funding amount from that account into the wallet and then pays out on the bank rail.
 *
 * Demo: cards are Stripe test cards (a real SetupIntent and PaymentIntent in test mode when Stripe keys are set, else
 * simulated); banks are the mock bank. No real money moves.
 */
import { z } from "zod";

import { jcsHash } from "./jcs.ts";
import { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "./webauthn.ts";

const Currency = z.string().regex(/^[A-Z]{3}$/);
const Country = z.string().regex(/^[A-Z]{2}$/);

export const FundingSourceKind = z.enum(["CARD", "BANK"]);
export type FundingSourceKind = z.infer<typeof FundingSourceKind>;
export const FundingSourceProvider = z.enum(["STRIPE", "MOCK_BANK"]);
export type FundingSourceProvider = z.infer<typeof FundingSourceProvider>;
export const FundingSourceStatus = z.enum(["PENDING", "ACTIVE", "REMOVED"]);
export type FundingSourceStatus = z.infer<typeof FundingSourceStatus>;

/** Stripe's test cards (the only cards a demo links). DECLINED (4000 0000 0000 0341) links fine and declines every charge. */
export const TestCard = z.enum(["VISA", "MASTERCARD", "DECLINED"]);
export type TestCard = z.infer<typeof TestCard>;
export const TEST_CARDS: Record<TestCard, { paymentMethod: string; brand: string; last4: string }> = {
  VISA: { paymentMethod: "pm_card_visa", brand: "Visa", last4: "4242" },
  MASTERCARD: { paymentMethod: "pm_card_mastercard", brand: "Mastercard", last4: "4444" },
  DECLINED: { paymentMethod: "pm_card_visa_chargeDeclined", brand: "Visa", last4: "0341" },
};

export const FundingSourceDto = z.object({
  id: z.string().uuid(),
  kind: FundingSourceKind,
  provider: FundingSourceProvider,
  /** "Visa ••4242", "Kaspi Gold ••4417". */
  label: z.string(),
  /** Bank name or card brand. */
  institution: z.string(),
  last4: z.string(),
  country: Country,
  currency: Currency,
  status: FundingSourceStatus,
  /** True when no real test-mode API stood behind the link (no Stripe keys, or the mock bank). */
  simulated: z.boolean(),
  createdAt: z.string().datetime(),
  verifiedAt: z.string().datetime().nullable(),
});
export type FundingSourceDto = z.infer<typeof FundingSourceDto>;

export const FundingSourcesResponse = z.object({ sources: z.array(FundingSourceDto) });
export type FundingSourcesResponse = z.infer<typeof FundingSourcesResponse>;

/** POST /funding-sources/card/start */
export const LinkCardRequest = z.object({ testCard: TestCard, currency: Currency });
export type LinkCardRequest = z.infer<typeof LinkCardRequest>;

/** POST /funding-sources/bank/start: any bank, by IBAN or local account number. */
export const LinkBankRequest = z.object({
  bankName: z.string().trim().min(2).max(60),
  /** IBAN or the bank's account number; only the last 4 characters are kept in the clear. */
  account: z
    .string()
    .trim()
    .min(6)
    .max(40)
    .regex(/^[A-Za-z0-9 ]+$/, "letters, digits and spaces"),
  country: Country,
  currency: Currency,
});
export type LinkBankRequest = z.infer<typeof LinkBankRequest>;

export const StartLinkResponse = z.object({
  source: FundingSourceDto,
  linkHash: z.string(),
  webauthnOptions: PublicKeyCredentialRequestOptionsJSON,
  /** BANK: the bank sent 1 unit with a code in the payment note. Mock bank only: the code, shown as simulated. */
  verification: z.object({ kind: z.enum(["PASSKEY", "MICRO_DEPOSIT"]), simulatedCode: z.string().optional() }),
});
export type StartLinkResponse = z.infer<typeof StartLinkResponse>;

/** POST /funding-sources/:id/confirm: passkey-gated (first call answers 428 with the challenge), plus a bank's code. */
export const ConfirmLinkRequest = z.object({
  challengeId: z.string().min(1).optional(),
  assertion: AuthenticationResponseJSON.optional(),
  code: z.string().regex(/^\d{4}$/).optional(),
});
export type ConfirmLinkRequest = z.infer<typeof ConfirmLinkRequest>;

/** GET /send/quote?payeeId&amountMinor&fundingSourceId: the live quote on the Send screen (signs nothing). */
export const SendQuoteResponse = z.object({
  /** NONE: the wallet cannot cover it (no route); UNKNOWN: balances could not be read, the bank checks at send. */
  status: z.enum(["OK", "NONE", "UNKNOWN"]),
  fundingCurrency: z.string().nullable(),
  /** Estimated debit (amount, conversion, fees) and the signed maximum the order will carry. */
  debitMinor: z.number().int().nullable(),
  maxDebitMinor: z.number().int().nullable(),
  markupBps: z.number().int().nullable(),
  arrivalDate: z.string().nullable(),
  /** The mock bank pays out the moment the transfer is funded (simulated). */
  instant: z.boolean(),
});
export type SendQuoteResponse = z.infer<typeof SendQuoteResponse>;

export type FundingSourceLinkCore = {
  v: 1;
  purpose: "kassa:link-funding-source";
  sourceId: string;
  userId: string;
  kind: FundingSourceKind;
  provider: FundingSourceProvider;
  label: string;
  currency: string;
  nonce: string;
};

/** The passkey challenge for linking a source: what will be able to pay, for whom, in which currency. */
export function fundingSourceLinkHash(core: FundingSourceLinkCore): string {
  return jcsHash(core);
}

/** Masked display of an account number or IBAN: its last 4 characters. */
export function last4Of(account: string): string {
  return account.replace(/\s+/g, "").slice(-4).toUpperCase();
}
