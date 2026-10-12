import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { isSupportedCurrency, toMinor } from "@kassa/shared";
import { z } from "zod";

import type { MockBank } from "../bank/bank.ts";
import type { Clock } from "../clock.ts";
import { HttpError, parseWith } from "../errors.ts";
import type { WebhookSink } from "../webhooks.ts";

/*
 * Event emitters (spec §17). Both only produce signed webhooks; the API must treat them as
 * triggers that can log or draft, never approve (I6).
 *   POST /pos/emit {sku, level, unit?, storeId?, requestedQuantity?}  -> webhook pos
 *   POST /remittance/incoming {amountMinor | amount, currency, sender?, profileId?} -> credits the
 *     mock bank wallet, webhook remittance ("money from home").
 */

const PosBody = z.object({
  sku: z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,31}$/),
  level: z.number().int().min(0).max(1_000_000),
  unit: z.string().min(1).max(16).default("pcs"),
  // mock-world storeId (= the API's merchants.slug): "bud" (Budapest, default) or "sha" (Shanghai).
  storeId: z.string().min(1).max(64).default("bud"),
  // A7: a fake/compromised POS may ask for an absurd quantity; it is passed through as data.
  requestedQuantity: z.number().int().positive().max(1_000_000).optional(),
});

const RemittanceBody = z
  .object({
    amountMinor: z.number().int().positive().refine(Number.isSafeInteger).optional(),
    /** Decimal major-unit string ("400000"), converted with ISO 4217 exponents; spec §17 says `amount`. */
    amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    sender: z.string().min(1).max(140).default("Parents (simulated)"),
    profileId: z.union([z.number().int().positive(), z.string().min(1).max(64)]).optional(),
  })
  .refine((b) => (b.amountMinor === undefined) !== (b.amount === undefined), { message: "give exactly one of amountMinor or amount" });

export function eventRoutes(
  app: FastifyInstance,
  deps: { clock: Clock; webhooks: WebhookSink; bank: MockBank; defaultProfileId: number },
): void {
  app.post("/pos/emit", async (req, reply) => {
    const b = parseWith(PosBody, req.body);
    const occurredAt = (await deps.clock.now()).toISOString();
    const event = {
      eventId: randomUUID(),
      type: "stock.level",
      storeId: b.storeId,
      sku: b.sku,
      level: b.level,
      unit: b.unit,
      ...(b.requestedQuantity !== undefined ? { requestedQuantity: b.requestedQuantity } : {}),
      occurredAt,
      simulated: true,
    };
    const entry = deps.webhooks.send("pos", event);
    return reply.code(202).send({ event, webhookId: entry.id });
  });

  app.post("/remittance/incoming", async (req, reply) => {
    const b = parseWith(RemittanceBody, req.body);
    if (!isSupportedCurrency(b.currency)) throw new HttpError(400, "BAD_REQUEST", `Unsupported currency ${b.currency}`);
    let amountMinor: number;
    try {
      amountMinor = b.amountMinor ?? toMinor(b.amount!, b.currency);
    } catch (err) {
      throw new HttpError(400, "BAD_REQUEST", err instanceof Error ? err.message : "bad amount");
    }
    const profile = deps.bank.resolveProfile(b.profileId ?? deps.defaultProfileId);
    const receivedAt = (await deps.clock.now()).toISOString();
    const balanceAfterMinor = deps.bank.credit(profile, b.currency, amountMinor);
    const event = {
      eventId: randomUUID(),
      type: "remittance.incoming",
      profileId: profile,
      amountMinor,
      currency: b.currency,
      sender: { name: b.sender },
      receivedAt,
      balanceAfterMinor,
      simulated: true,
    };
    const entry = deps.webhooks.send("remittance", event);
    return reply.code(202).send({ event, webhookId: entry.id });
  });
}
