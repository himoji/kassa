import { z } from "zod";

import { currencyFromText, parseAmountString } from "../amount.ts";
import type { ParsedEvent } from "./types.ts";

/*
 * iOS Shortcut "Transaction" automation payload (spec §13): `{merchant, amount, card}` plus optional
 * `date` (Current Date action, ISO 8601 with offset) and `currency`. `amount` is Wallet's
 * locale-formatted string, e.g. "3 870 Ft", "€12.40", "HUF 4,500".
 */

export const ShortcutPayload = z.object({
  merchant: z.string().min(1).max(200),
  amount: z.union([z.string().min(1).max(64), z.number()]),
  card: z.string().max(120).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  date: z.string().datetime({ offset: true }).optional(),
});
export type ShortcutPayload = z.infer<typeof ShortcutPayload>;

export function parseShortcut(p: ShortcutPayload, fallbackCurrency?: string): ParsedEvent | null {
  const amountText = String(p.amount);
  const currency = p.currency ?? currencyFromText(amountText) ?? fallbackCurrency ?? null;
  if (!currency) return null;
  const numeric = /\d[\d\s\u00a0\u2009\u202f.,']*/.exec(amountText)?.[0]?.trim();
  if (!numeric) return null;
  let amountMinor: number;
  try {
    amountMinor = parseAmountString(numeric, currency, "auto");
  } catch {
    return null;
  }
  if (amountMinor <= 0) return null;
  return {
    format: "IOS_SHORTCUT",
    kind: "PURCHASE",
    merchantRaw: p.merchant.trim(),
    amountMinor,
    currency,
    cardHint: p.card?.trim() || null,
    occurredAt: p.date ? new Date(p.date) : null,
  };
}
