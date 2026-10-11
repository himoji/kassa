import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { MockBank } from "../bank/bank.ts";
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

const QuoteBody = z.object({
  sourceCurrency: Currency,
  targetCurrency: Currency,
  sourceAmountMinor: Minor.optional(),
  targetAmountMinor: Minor.optional(),
  routeId: z.string().min(1).max(64).optional(),
  payOut: z.literal("BANK_TRANSFER").optional(),
  preferredPayIn: z.literal("BALANCE").optional(),
});

const AccountBody = z.object({
  currency: Currency,
  type: z.literal("iban"),
  profile: z.union([z.number().int().positive(), z.string().min(1).max(64)]),
  accountHolderName: z.string().min(1).max(140),
  details: z.object({
    legalType: z.enum(["PRIVATE", "BUSINESS"]).default("BUSINESS"),
    iban: z.string().min(15).max(42),
  }),
});

const TransferBody = z.object({
  targetAccount: z.number().int().positive(),
  quoteUuid: z.string().uuid(),
  // Wise requires a UUID idempotency key; RFC 9562.
  customerTransactionId: z.string().uuid(),
  // ISO 20022 unstructured remittance information is at most 140 characters.
  details: z.object({ reference: z.string().max(140).default("") }).default({ reference: "" }),
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
    const p = bank.resolveProfile(wiseParse(ProfileParam, req.params).p);
    const body = wiseParse(QuoteBody, req.body);
    const quote = await bank.createQuote(p, {
      sourceCurrency: body.sourceCurrency,
      targetCurrency: body.targetCurrency,
      ...(body.sourceAmountMinor !== undefined ? { sourceAmountMinor: body.sourceAmountMinor } : {}),
      ...(body.targetAmountMinor !== undefined ? { targetAmountMinor: body.targetAmountMinor } : {}),
      ...(body.routeId !== undefined ? { routeId: body.routeId } : {}),
    });
    return reply.code(200).send(quote);
  });

  app.get("/v3/profiles/:p/quotes/:id", async (req) => {
    const p = bank.resolveProfile(wiseParse(ProfileParam, req.params).p);
    const { id } = wiseParse(z.object({ id: z.string().uuid() }), req.params);
    return bank.getQuote(p, id);
  });

  app.post("/v1/accounts", async (req) => {
    const body = wiseParse(AccountBody, req.body);
    return bank.createRecipient({
      currency: body.currency,
      profile: bank.resolveProfile(body.profile),
      accountHolderName: body.accountHolderName,
      legalType: body.details.legalType,
      iban: body.details.iban,
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
    });
    return reply.code(200).send(transfer);
  });

  app.post("/v3/profiles/:p/transfers/:id/payments", async (req) => {
    const { p, id } = wiseParse(ProfileParam.extend({ id: z.coerce.number().int().positive() }), req.params);
    wiseParse(FundBody, req.body);
    return bank.fund(bank.resolveProfile(p), id);
  });

  app.get("/v1/transfers/:id", async (req) => {
    const { id } = wiseParse(IdParam, req.params);
    return bank.getTransfer(id);
  });

  app.get("/v4/profiles/:p/balances", async (req) => {
    const p = bank.resolveProfile(wiseParse(ProfileParam, req.params).p);
    const q = wiseParse(z.object({ types: z.string().optional() }), req.query);
    if (q.types !== undefined && !q.types.split(",").includes("STANDARD")) return [];
    return bank.listBalances(p);
  });

  // Demo helpers (not part of Wise's API).
  app.get("/bank/transfers", async () => {
    await bank.tick();
    return { transfers: bank.listTransfers(), simulated: true };
  });

  app.post("/bank/tick", async () => ({ changed: await bank.tick() }));
}
