import { z } from "zod";

import { CurrencyCode, IsoDateTime, PositiveAmountMinor, Uuid } from "./primitives.ts";

/*
 * Track B (intelligence) response contracts not covered by dto.ts / appDto.ts. Additive only.
 */

/** Machine message the app localises with i18next (`key` = translation key, `params` = values). */
export const LocalisedMessage = z.object({
  key: z.string(),
  params: z.record(z.string(), z.unknown()),
  /** English rendering (logs, web toast fallback). */
  en: z.object({ title: z.string(), body: z.string() }),
});
export type LocalisedMessage = z.infer<typeof LocalisedMessage>;

/** POST /capture/event and POST /capture/shortcut result (spec §13). Triggers never approve (I6). */
export const CaptureEventResponse = z.object({
  status: z.enum(["LOGGED", "MERGED", "IGNORED_INCOMING", "UNPARSED"]),
  transactionId: Uuid.nullable(),
  /** Set when status = MERGED: the earlier sighting this one was merged into (dedupe). */
  mergedIntoId: Uuid.nullable(),
  /** "PARSER:<FORMAT>", "READER", or "FIELDS". */
  parsedBy: z.string().nullable(),
  merchantNorm: z.string().nullable(),
  amountMinor: PositiveAmountMinor.nullable(),
  currency: CurrencyCode.nullable(),
  homeAmountMinor: z.number().int().nullable(),
  category: z.string().nullable(),
  categorySource: z.enum(["USER", "MCC", "DICTIONARY", "READER", "DEFAULT"]).nullable(),
  notification: LocalisedMessage.nullable(),
});
export type CaptureEventResponse = z.infer<typeof CaptureEventResponse>;

/** POST /capture/settlement (mock bank statement line / demo trigger): reconciles a pending foreign charge. */
export const SettlementEventRequest = z.object({
  transactionId: Uuid.optional(),
  merchant: z.string().min(1).max(200).optional(),
  /** Original purchase amount (as captured). */
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  /** What the card account was actually debited. */
  settledAmountMinor: PositiveAmountMinor,
  settledCurrency: CurrencyCode,
  /** DCC receipts: the merchant's local price when the charge was made in the home currency. */
  localAmountMinor: PositiveAmountMinor.optional(),
  localCurrency: CurrencyCode.optional(),
  settledAt: IsoDateTime.optional(),
});
export type SettlementEventRequest = z.infer<typeof SettlementEventRequest>;

export const SettlementEventResponse = z.object({
  transactionId: Uuid,
  feeHomeMinor: z.number().int(),
  markupBps: z.number().int(),
  dcc: z.object({ overMidBps: z.number().int() }).nullable(),
  cardProfile: z
    .object({ cardId: Uuid, fromCurrency: CurrencyCode, toCurrency: CurrencyCode, medianMarkupBps: z.number().int(), samples: z.number().int() })
    .nullable(),
});
export type SettlementEventResponse = z.infer<typeof SettlementEventResponse>;
