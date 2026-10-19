import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { currencyExponent, toMinor } from "@kassa/shared";

import type { MockBank, RecipientAccount } from "../bank/bank.ts";
import { BankError } from "../bank/bank.ts";

/*
 * Wise-shaped mock bank routes (spec §11), mounted under /mock:
 *   POST /v3/profiles/:p/quotes             GET /v3/profiles/:p/quotes/:id
 *   POST /v1/accounts                       GET /v1/accounts/:id
 *   POST /v1/transfers                      GET /v1/transfers/:id
 *   POST /v3/profiles/:p/transfers/:id/payments
 *   GET  /v4/profiles/:p/balances
 * plus demo helpers GET /bank/transfers (log) and POST /bank/tick (advance now).
 * Errors use Wise's `{ errors: [{ code, message, path }] }` shape.
 */

const Currency = z.string().regex(/^[A-Z]{3}$/);
const Minor = z.number().int().positive().refine(Number.isSafeInteger);
const ProfileParam = z.object({ p: z.string().min(1).max(64) });
const IdParam = z.object({ id: z.coerce.number().int().positive() });

// Wise sends decimal major units (sourceAmount / targetAmount); Kassa's own client also sends minor units.
const Decimal = z.union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?$/)]);
const QuoteBody = z.object({
  sourceCurrency: Currency,
  targetCurrency: Currency,
  sourceAmountMinor: Minor.optional(),
  targetAmountMinor: Minor.optional(),
  sourceAmount: Decimal.nullish(),
  targetAmount: Decimal.nullish(),
  routeId: z.string().min(1).max(64).optional(),
  // BALANCE (added 2026-10-18): a quote for a conversion into the profile's own balance (balance-movements).
  payOut: z.enum(["BANK_TRANSFER", "BALANCE"]).optional(),
  preferredPayIn: z.literal("BALANCE").optional(),
});

/** A decimal amount in minor units (rounded to the currency exponent, as Wise does). */
function minorFrom(value: number | string, currency: string): number {
  const n = Number(value);
  try {
    return toMinor(n.toFixed(currencyExponent(currency)), currency);
  } catch {
    throw new BankError(422, "NOT_VALID", "Amount is not valid", "targetAmount");
  }
}

const Holder = {
  currency: Currency,
  profile: z.union([z.number().int().positive(), z.string().min(1).max(64)]),
  accountHolderName: z.string().min(1).max(140),
};
const Legal = { legalType: z.enum(["PRIVATE", "BUSINESS"]).default("BUSINESS") };
const Digits = (min: number, max: number) => z.string().transform((v) => v.replace(/[\s-]+/g, "")).pipe(z.string().regex(new RegExp(`^\\d{${min},${max}}$`)));

// Wise recipient types: iban (SEPA etc.), chinese_alipay and chinese_card (CNY), aba (USD ACH).
const AccountBody = z.discriminatedUnion("type", [
  z.object({ ...Holder, type: z.literal("iban"), details: z.object({ ...Legal, iban: z.string().min(15).max(42) }) }),
  z.object({ ...Holder, type: z.literal("chinese_alipay"), details: z.object({ ...Legal, accountNumber: z.string().min(5).max(64) }) }),
  z.object({ ...Holder, type: z.literal("chinese_card"), details: z.object({ ...Legal, cardNumber: Digits(16, 19) }) }),
  z.object({ ...Holder, type: z.literal("kassa_wallet"), details: z.object({ ...Legal, walletProfile: z.union([z.number().int().positive(), z.string().min(1).max(64)]) }) }),
  z.object({
    ...Holder,
    type: z.literal("aba"),
    details: z.object({ ...Legal, abartn: Digits(9, 9), accountNumber: Digits(4, 17), accountType: z.enum(["CHECKING", "SAVINGS"]).default("CHECKING") }),
  }),
]);

const TransferBody = z.object({
  targetAccount: z.number().int().positive(),
  quoteUuid: z.string().uuid(),
  // Wise requires a UUID idempotency key; RFC 9562.
  customerTransactionId: z.string().uuid(),
  // ISO 20022 unstructured remittance information is at most 140 characters.
  details: z.object({ reference: z.string().max(140).default("") }).default({ reference: "" }),
  /** Kassa extension (not Wise's): deliver as soon as funded, when the bank runs instant payouts (MOCK_BANK_INSTANT). */
  instant: z.boolean().optional(),
});

const FundBody = z.object({ type: z.literal("BALANCE") });

function wiseParse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    throw new BankError(422, "NOT_VALID", first?.message ?? "Invalid request", first?.path.join("."));
  }
  return r.data;
}

export function bankRoutes(app: FastifyInstance, bank: MockBank): void {
  app.post("/v3/profiles/:p/quotes", async (req, reply) => {
    const p = await bank.resolveProfile(wiseParse(ProfileParam, req.params).p);
    const body = wiseParse(QuoteBody, req.body);
    const sourceAmountMinor = body.sourceAmountMinor ?? (body.sourceAmount != null ? minorFrom(body.sourceAmount, body.sourceCurrency) : undefined);
    const targetAmountMinor = body.targetAmountMinor ?? (body.targetAmount != null ? minorFrom(body.targetAmount, body.targetCurrency) : undefined);
    const quote = await bank.createQuote(p, {
      sourceCurrency: body.sourceCurrency,
      targetCurrency: body.targetCurrency,
      ...(sourceAmountMinor !== undefined ? { sourceAmountMinor } : {}),
      ...(targetAmountMinor !== undefined ? { targetAmountMinor } : {}),
      ...(body.routeId !== undefined ? { routeId: body.routeId } : {}),
    });
    return reply.code(200).send(quote);
  });

  app.get("/v3/profiles/:p/quotes/:id", async (req) => {
    const p = await bank.resolveProfile(wiseParse(ProfileParam, req.params).p);
    const { id } = wiseParse(z.object({ id: z.string().uuid() }), req.params);
    return bank.getQuote(p, id);
  });

  app.post("/v1/accounts", async (req) => {
    const body = wiseParse(AccountBody, req.body);
    const { legalType, ...fields } = body.details;
    const account =
      body.type === "kassa_wallet"
        ? { type: "kassa_wallet" as const, walletProfile: await bank.resolveProfile((fields as { walletProfile: number | string }).walletProfile) }
        : ({ type: body.type, ...fields } as RecipientAccount);
    return bank.createRecipient({
      currency: body.currency,
      profile: await bank.resolveProfile(body.profile),
      accountHolderName: body.accountHolderName,
      legalType,
      account,
    });
  });

  app.get("/v1/accounts/:id", async (req) => {
    const { id } = wiseParse(IdParam, req.params);
    return bank.getRecipient(id);
  });

  app.post("/v1/transfers", async (req, reply) => {
    const body = wiseParse(TransferBody, req.body);
    const { transfer } = await bank.createTransfer({
      targetAccount: body.targetAccount,
      quoteUuid: body.quoteUuid,
      customerTransactionId: body.customerTransactionId,
      reference: body.details.reference,
      instant: body.instant === true,
    });
    return reply.code(200).send(transfer);
  });

  app.post("/v3/profiles/:p/transfers/:id/payments", async (req) => {
    const { p, id } = wiseParse(ProfileParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    wiseParse(FundBody, req.body);
    return bank.fund(await bank.resolveProfile(p), id);
  });

  app.get("/v1/transfers/:id", async (req) => {
    const { id } = wiseParse(IdParam, req.params);
    return bank.getTransfer(id);
  });

  // (added 2026-10-18) Wise balance conversion: own balance → own balance at a quote of this profile.
  app.post("/v2/profiles/:p/balance-movements", async (req) => {
    const p = await bank.resolveProfile(wiseParse(ProfileParam, req.params).p);
    const body = wiseParse(z.object({ quoteId: z.string().uuid(), customerTransactionId: z.string().min(1).max(64) }), req.body);
    return bank.convert(p, body);
  });

  app.get("/v4/profiles/:p/balances", async (req) => {
    const p = await bank.resolveProfile(wiseParse(ProfileParam, req.params).p);
    const q = wiseParse(z.object({ types: z.string().optional() }), req.query);
    if (q.types !== undefined && !q.types.split(",").includes("STANDARD")) return [];
    return bank.listBalances(p);
  });

  // Kassa helpers (not part of Wise's API): open a wallet for a new user; add test money from a wallet tap.
  app.post("/bank/wallets", async (req) => {
    const body = wiseParse(z.object({ profileId: z.number().int().positive(), aliases: z.array(z.string().min(1).max(64)).max(4).default([]) }), req.body);
    return bank.openWallet(body.profileId, body.aliases);
  });

  app.post("/bank/top-ups", async (req) => {
    const body = wiseParse(z.object({ profileId: z.union([z.number().int().positive(), z.string().min(1).max(64)]), currency: Currency, amountMinor: Minor, reference: z.string().min(8).max(64) }), req.body);
    const profile = await bank.resolveProfile(body.profileId);
    return { profileId: profile, currency: body.currency, amountMinor: body.amountMinor, ...(await bank.topUp(profile, body.currency, body.amountMinor, body.reference)), simulated: true };
  });

  // (added 2026-10-19) Kassa's issuer pays an approved one-time card charge from the wallet (bank.cardDebit).
  app.post("/bank/card-debits", async (req) => {
    const body = wiseParse(
      z.object({
        profileId: z.union([z.number().int().positive(), z.string().min(1).max(64)]),
        authorizationId: z.string().min(1).max(64),
        cardId: z.string().min(1).max(64),
        amountMinor: Minor,
        currency: Currency,
      }),
      req.body,
    );
    const profile = await bank.resolveProfile(body.profileId);
    return bank.cardDebit(profile, { authorizationId: body.authorizationId, cardId: body.cardId, amountMinor: body.amountMinor, currency: body.currency });
  });

  // Demo helpers (not part of Wise's API).
  app.get("/bank/transfers", async () => {
    await bank.tick();
    return { transfers: bank.listTransfers(), simulated: true };
  });

  app.post("/bank/tick", async () => ({ changed: await bank.tick() }));
}
