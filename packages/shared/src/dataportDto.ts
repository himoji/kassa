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
  /** What the account was really charged, when the purchase was in another currency (fee x-ray). */
  settledAmountMinor: PositiveAmountMinor.nullish(),
  settledCurrency: CurrencyCode.nullish(),
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
  /** Regular money in found in the history (added to the profile; the forecast reads them). */
  incomes: z.array(OnboardingIncomeDraft).max(20).default([]),
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

/** POST /import/preview: pasted text (JSON, CSV or a statement's text). Files go to POST /import/file (multipart). */
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

/** One uploaded file as Kassa read it (shown in the preview, so a wrong reading can be traced). */
export const ImportFile = z.object({
  name: z.string().max(200),
  format: z.enum(["pdf", "xlsx", "csv", "json", "ofx", "text"]),
  /** How the rows were found: Kassa's own export, records / table columns, statement lines, or the AI reader. */
  via: z.enum(["kassa", "records", "table", "lines", "ai", "none"]),
  bank: z.string().max(60).nullable(),
  accountCurrency: CurrencyCode.nullable(),
  cardLast4: z.string().regex(/^\d{4}$/).nullable(),
  rows: z.number().int().nonnegative(),
  from: IsoDate.nullable(),
  to: IsoDate.nullable(),
  /** AI rows dropped because their evidence was not in the statement. */
  rejected: z.number().int().nonnegative().default(0),
});
export type ImportFile = z.infer<typeof ImportFile>;

const Money = z.object({ amountMinor: z.number().int(), currency: CurrencyCode });

/**
 * What Kassa learned from the history, computed in code from the rows (never by a model). Amounts are in the home
 * currency unless they carry their own currency. The onboarding model sees only these aggregates.
 */
export const ImportHistory = z.object({
  homeCurrency: CurrencyCode,
  from: IsoDate.nullable(),
  to: IsoDate.nullable(),
  /** Months covered (partial months count by their share of days). */
  months: z.number().nonnegative(),
  counts: z.object({
    rows: z.number().int(),
    spending: z.number().int(),
    incoming: z.number().int(),
    ownTransfers: z.number().int(),
    refunds: z.number().int(),
  }),
  spendingByCategory: z.array(z.object({ category: z.string(), monthlyHomeMinor: z.number().int(), totalHomeMinor: z.number().int(), count: z.number().int() })),
  monthlySpendingHomeMinor: z.number().int(),
  monthlyIncomeHomeMinor: z.number().int(),
  /**
   * Money in per source (as printed). `amount` is what the draft plans with: the median month for a regular source, the
   * average over all covered months (months without money count as zero) for an irregular one. The rest says how far
   * that number can be trusted: in how many of the covered months money came, the smallest and largest month, whether
   * recent months are lower or higher, whether it seems to have stopped, and one large transfer kept out of the average.
   */
  incomes: z.array(
    z.object({
      source: z.string(),
      amount: Money,
      cadence: z.enum(["WEEKLY", "MONTHLY", "TERM", "ONCE"]),
      count: z.number().int(),
      lastDate: IsoDate,
      regularity: z.enum(["regular", "irregular", "occasional", "one_off"]).default("regular"),
      monthsReceived: z.number().int().default(0),
      monthsCovered: z.number().int().default(0),
      minMonthlyMinor: z.number().int().default(0),
      maxMonthlyMinor: z.number().int().default(0),
      medianMonthlyMinor: z.number().int().default(0),
      trend: z.enum(["up", "down", "flat"]).nullable().default(null),
      stopped: z.boolean().default(false),
      /** One large transfer kept out of the plan, and the payment it was sent for when one followed within 3 days. */
      largest: z.object({ date: IsoDate, amountMinor: z.number().int(), paidFor: z.string().nullable().default(null) }).nullable().default(null),
    }),
  ),
  /** Regular payments that look like bills (similar amount, about monthly). */
  recurring: z.array(z.object({ name: z.string(), amount: Money, count: z.number().int(), lastDate: IsoDate, nextDate: IsoDate, category: z.string() })),
  /** Card and conversion costs: fees and FX differences paid, and the markup over the mid rate on foreign purchases. */
  fees: z.object({
    totalHomeMinor: z.number().int(),
    count: z.number().int(),
    fxMarkupBps: z.number().int().nullable(),
    fxSamples: z.number().int(),
    fxCostHomeMinor: z.number().int(),
  }),
  topMerchants: z.array(z.object({ name: z.string(), totalHomeMinor: z.number().int(), count: z.number().int() })),
  /** Each statement's own period (its header's, else its first and last row) and how many months it covers. */
  statements: z.array(z.object({ name: z.string(), bank: z.string().nullable(), from: IsoDate, to: IsoDate, months: z.number() })).default([]),
  /** Month by month (home currency): spending without transfers, transfers to people, money in, and how many statements cover it. */
  monthly: z
    .array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), spendingHomeMinor: z.number().int(), transfersHomeMinor: z.number().int(), incomeHomeMinor: z.number().int(), statements: z.number().int() }))
    .default([]),
  /** Spending in the last 3 covered months against the months before (null with under 6 months). */
  spendingTrend: z.object({ recentMonthlyHomeMinor: z.number().int(), earlierMonthlyHomeMinor: z.number().int() }).nullable().default(null),
  /** The month with the most spending and the category that made it so. */
  peakMonth: z
    .object({ month: z.string(), spendingHomeMinor: z.number().int(), category: z.string(), categoryHomeMinor: z.number().int(), oneOff: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  /** Single payments far above the usual (tuition, a flight, a deposit): not part of a monthly budget. */
  oneOffs: z.array(z.object({ date: IsoDate, name: z.string(), homeMinor: z.number().int(), amount: Money })).default([]),
  /** When most spending moved to another currency (moving abroad), from the month it became the main one. */
  currencyShift: z.object({ from: z.string(), to: z.string(), since: z.string() }).nullable().default(null),
  /** Covered months where spending and transfers out were more than the money in. */
  monthsOverspent: z.number().int().default(0),
  /** The history in plain lines, written by code from the numbers above (the preview's "What Kassa learned"). */
  notes: z.array(z.string().max(600)).max(30).default([]),
  /** Currencies seen and money moved in each (spending, in). */
  currencies: z.array(z.object({ currency: CurrencyCode, outMinor: z.number().int(), inMinor: z.number().int() })),
});
export type ImportHistory = z.infer<typeof ImportHistory>;

/** GET /history: the last imported history (statements or onboarding), or null before any import. */
export const MoneyHistoryResponse = z.object({ history: ImportHistory.nullable() });
export type MoneyHistoryResponse = z.infer<typeof MoneyHistoryResponse>;

export const ImportPreviewResponse = z.object({
  source: z.enum(["kassa", "mapped"]),
  items: ImportItems,
  mappings: z.array(ImportMapping),
  /** Plain-language notes: rows skipped and why, a currency assumed, own transfers left out. */
  warnings: z.array(z.string()),
  files: z.array(ImportFile).default([]),
  history: ImportHistory.nullable().default(null),
});
export type ImportPreviewResponse = z.infer<typeof ImportPreviewResponse>;

/**
 * POST /import/commit: the (possibly trimmed) preview items. Budgets are ignored here (see ImportItems). `history` (the
 * preview's) is kept with the profile so the agent can read what the statements showed (get_money_history).
 */
export const ImportCommitRequest = z.object({ items: ImportItems, history: ImportHistory.nullish() });
export type ImportCommitRequest = z.infer<typeof ImportCommitRequest>;

export const ImportCommitResponse = z.object({
  transactions: z.object({ imported: z.number().int(), duplicates: z.number().int(), failed: z.number().int() }),
  bills: z.object({ added: z.number().int(), skipped: z.number().int() }),
  cards: z.object({ added: z.number().int(), skipped: z.number().int() }),
  incomes: z.object({ added: z.number().int(), skipped: z.number().int() }).default({ added: 0, skipped: 0 }),
});
export type ImportCommitResponse = z.infer<typeof ImportCommitResponse>;

/**
 * POST /onboarding/history: what an import preview learned, handed to the onboarding chat. The server merges the
 * suggestions into the draft in code (nothing is applied until the passkey-signed confirmation) and the model only ever
 * sees the aggregates.
 */
export const OnboardingHistoryRequest = z.object({
  conversationId: z.string().uuid(),
  history: ImportHistory,
  files: z.array(ImportFile).max(6),
  items: ImportItems.pick({ incomes: true, bills: true, budgets: true, cards: true }),
});
export type OnboardingHistoryRequest = z.infer<typeof OnboardingHistoryRequest>;
