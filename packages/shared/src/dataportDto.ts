import { z } from "zod";

import { OnboardingIncomeDraft, OnboardingObligationDraft } from "./appDto.ts";
import { CreateCardRequest } from "./dto.ts";
import { Region } from "./enums.ts";
import { CurrencyCode, IsoDate, IsoDateTime, PositiveAmountMinor } from "./primitives.ts";

/*
 * Data import / export (GET /export, POST /import/preview, POST /import/commit).
 * The export is Kassa's own portable format (`kassa-export` v1); importing it back is exact. Any other JSON (a bank
 * or another app's export) is mapped by the server: it finds the arrays of records, matches their field names to
 * Kassa's (multilingual synonyms, fuzzy), parses amounts, currencies and dates, and shows a preview first.
 */

export const ImportTransaction = z.object({
  occurredAt: IsoDateTime,
  merchant: z.string().min(1).max(140),
  amountMinor: PositiveAmountMinor,
  currency: CurrencyCode,
  category: z.string().max(40).nullable(),
  cardLast4: z.string().regex(/^\d{4}$/).nullable(),
  mcc: z.string().regex(/^\d{4}$/).nullable(),
});
export type ImportTransaction = z.infer<typeof ImportTransaction>;

export const ImportBudget = z.object({ category: z.string().regex(/^[a-z0-9_]{1,32}$/), limitHomeMinor: PositiveAmountMinor });
export type ImportBudget = z.infer<typeof ImportBudget>;

/** What an import adds. Budgets are applied by the app through PUT /budgets (raising one needs the passkey). */
export const ImportItems = z.object({
  transactions: z.array(ImportTransaction).max(5000),
  bills: z.array(OnboardingObligationDraft).max(200),
  cards: z.array(CreateCardRequest).max(50),
  budgets: z.array(ImportBudget).max(20),
});
export type ImportItems = z.infer<typeof ImportItems>;

/** Kassa's export format, version 1. */
export const KassaExport = z.object({
  format: z.literal("kassa-export"),
  version: z.literal(1),
  exportedAt: IsoDateTime,
  profile: z.object({ displayName: z.string(), homeCurrency: CurrencyCode, region: Region, incomes: z.array(OnboardingIncomeDraft) }),
  cards: ImportItems.shape.cards,
  budgets: z.array(ImportBudget.extend({ periodStart: IsoDate })),
  bills: ImportItems.shape.bills,
  transactions: ImportItems.shape.transactions,
});
export type KassaExport = z.infer<typeof KassaExport>;

/** POST /import/preview: the file's text (JSON). */
export const ImportPreviewRequest = z.object({ text: z.string().min(2).max(4_000_000) });
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequest>;

export const ImportMapping = z.object({
  /** Where the records were found ("$" = the top level, "$.data.items"). */
  path: z.string(),
  kind: z.enum(["transactions", "bills", "cards", "budgets"]),
  /** Kassa field → the source field it was read from. */
  fields: z.record(z.string(), z.string()),
  rows: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
});
export type ImportMapping = z.infer<typeof ImportMapping>;

export const ImportPreviewResponse = z.object({
  source: z.enum(["kassa", "mapped"]),
  items: ImportItems,
  mappings: z.array(ImportMapping),
  /** Plain-language notes: rows skipped and why, a currency assumed, incoming money left out. */
  warnings: z.array(z.string()),
});
export type ImportPreviewResponse = z.infer<typeof ImportPreviewResponse>;

/** POST /import/commit: the (possibly trimmed) preview items. Budgets are ignored here (see ImportItems). */
export const ImportCommitRequest = z.object({ items: ImportItems });
export type ImportCommitRequest = z.infer<typeof ImportCommitRequest>;

export const ImportCommitResponse = z.object({
  transactions: z.object({ imported: z.number().int(), duplicates: z.number().int(), failed: z.number().int() }),
  bills: z.object({ added: z.number().int(), skipped: z.number().int() }),
  cards: z.object({ added: z.number().int(), skipped: z.number().int() }),
});
export type ImportCommitResponse = z.infer<typeof ImportCommitResponse>;
