/*
 * The live quote on the Send screen (GME-style: fee, FX and arrival before you tap Send). It runs the same route
 * choice the order will sign (rules/funding.ts chooseFunding), so what the sheet then shows matches; it signs nothing.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { SendQuoteResponse } from "@kassa/shared";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { payees, users } from "../../db/schema.ts";
import { HttpProblem, notFound } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { bankMode } from "../rails/bankApi.ts";
import { chooseFunding } from "../rules/funding.ts";
import { activeFundingSource } from "./store.ts";

export const SendQuoteQuery = z.object({
  payeeId: z.string().uuid(),
  amountMinor: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  fundingSourceId: z.string().uuid().optional(),
});


export async function sendQuote(userId: string, q: z.infer<typeof SendQuoteQuery>): Promise<SendQuoteResponse> {
  const db = getDb();
  const payee = (await db.select().from(payees).where(and(eq(payees.id, q.payeeId), eq(payees.userId, userId), isNull(payees.archivedAt))))[0];
  if (!payee) throw notFound("Recipient");
  const user = (await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)))[0]!;
  const source = q.fundingSourceId ? await activeFundingSource(userId, q.fundingSourceId) : null;
  if (q.fundingSourceId && !source) throw new HttpProblem(422, "FUNDING_SOURCE_UNAVAILABLE", "That card or bank account is not linked (any more)");
  const choice = await chooseFunding({ userId, homeCurrency: user.homeCurrency, amountMinor: q.amountMinor, currency: payee.currency, now: clock.now(), linkedCurrency: source?.currency });
  const f = choice.status === "NONE" ? null : choice.funding;
  return {
    status: choice.status,
    fundingCurrency: f?.currency ?? null,
    debitMinor: f?.estimatedAmountMinor ?? null,
    maxDebitMinor: f?.maxAmountMinor ?? null,
    markupBps: f?.markupBps ?? null,
    arrivalDate: f?.arrivalDate ?? null,
    instant: bankMode() === "mock",
  };
}
