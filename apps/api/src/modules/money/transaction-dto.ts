import type { TransactionDto } from "@kassa/shared";

import type { transactions } from "../../db/schema.ts";

type TransactionRow = typeof transactions.$inferSelect;

export function toTransactionDto(row: TransactionRow): TransactionDto {
  return {
    id: row.id,
    source: row.source,
    occurredAt: row.occurredAt.toISOString(),
    merchantRaw: row.merchantRaw,
    merchantNorm: row.merchantNorm,
    mcc: row.mcc,
    amountMinor: row.amountMinor,
    currency: row.currency,
    cardId: row.cardId,
    homeAmountMinor: row.homeAmountMinor,
    rateUsed: row.rateUsed,
    rateDate: row.rateDate,
    settledAmountMinor: row.settledAmountMinor,
    settledCurrency: row.settledCurrency,
    feeHomeMinor: row.feeHomeMinor,
    category: row.category,
    mergedIntoId: row.mergedIntoId,
    status: row.status,
  };
}
