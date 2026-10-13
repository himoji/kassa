import { isKnownCurrency } from "@kassa/shared";
import { z } from "zod";

import { currencyFromText, parseAmountString } from "../amount.ts";
import type { ParsedEvent } from "./types.ts";

/*
 * iOS Shortcut "Transaction" automation payload (spec §13, docs/SHORTCUT_SETUP.md): `{merchant, amount, card}` plus
 * optional `date` and `currency`. The automation pastes Shortcut Input fields into a JSON body, so every field is
 * whatever iOS renders for the phone's locale:
 *  - `amount`: "3 870 Ft", "Ft 1,290", "HUF 1,290.00", "HUF1,290.00", "€4.50", "4,50 €", "₸2 500", "¥38.00",
 *    "CN¥38.00", "-€4.50" (refund), or a bare JSON number when the field is typed Number.
 *  - `date`: ISO 8601 when the user formats Current Date as ISO; otherwise a localized string ("11 Oct 2026 at
 *    09:15") that is ignored (the automation runs immediately, so the server's now is the purchase time).
 * Tolerant on input, strict on meaning: an amount in a currency Kassa does not know ("£4.50", "A$4.50", "JPY 500")
 * is unparsed rather than logged in the home currency.
 */

export const ShortcutPayload = z.object({
  // An empty merchant (some passes have none) is logged as "Unknown merchant" rather than refused.
  merchant: z.string().max(200).default(""),
  amount: z.union([z.string().min(1).max(64), z.number()]),
  card: z.string().max(200).optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  date: z.string().max(100).optional(),
});
export type ShortcutPayload = z.infer<typeof ShortcutPayload>;

const NUMERIC = /\d[\d\s\u00a0\u2009\u202f.,'’]*/;
/** "-€4.50", "€-4.50", "4,50 €-", "−1 290 Ft": a minus anywhere in the amount field marks a refund. */
const MINUS = /[-−–]/;
/** Currency markers the parser understands (longest first, so "US$" and "CN¥" go before "$" and "¥"). */
const KNOWN_MARKERS = /US\$|CN¥|CN￥|RMB|KZT|EUR|HUF|USD|CNY|Ft|forint|тг|тенге|теңге|₸|€|\$|[¥￥]|元|人民币/gi;

/**
 * Currency of the text around the number. Null when it has none; "UNKNOWN" when it carries a currency marker
 * Kassa does not support (other symbol, letters left after the known markers are removed).
 */
export function currencyAround(amountText: string): string | null | "UNKNOWN" {
  const rest = amountText.replace(NUMERIC, " ").replace(/[-−–+]/g, " ");
  if (!rest.trim()) return null;
  // Glued markers ("HUF1,290", "Ft1 290") lose their word boundary next to the digits: the rest is checked alone.
  const leftover = rest.replace(KNOWN_MARKERS, " ").replace(/[\s\u00a0\u2009\u202f.,:()]/g, "");
  if (leftover.length > 0) return "UNKNOWN";
  return currencyFromText(rest);
}

/** ISO 8601 date-time with an offset or Z; anything else (a localized date, a date without a zone) → null. */
export function shortcutDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseShortcut(p: ShortcutPayload, fallbackCurrency?: string): ParsedEvent | null {
  let amountText: string;
  let currency: string | null;
  if (typeof p.amount === "number") {
    if (!Number.isFinite(p.amount)) return null;
    // A Number-typed field: round to the 2-decimal exponent all supported currencies share (avoids 4.4999999).
    amountText = p.amount.toFixed(2);
    currency = p.currency?.toUpperCase() ?? fallbackCurrency ?? null;
  } else {
    amountText = p.amount;
    const around = currencyAround(amountText);
    if (around === "UNKNOWN") return null;
    currency = p.currency?.toUpperCase() ?? around ?? fallbackCurrency ?? null;
  }
  if (!currency || !isKnownCurrency(currency)) return null;
  const negative = MINUS.test(amountText) || /^\(.*\)$/.test(amountText.trim());
  const numeric = NUMERIC.exec(amountText)?.[0]
    ?.trim()
    .replace(/[\s\u00a0\u2009\u202f.,'’]+$/, "");
  if (!numeric) return null;
  let amountMinor: number;
  try {
    amountMinor = Math.abs(parseAmountString(numeric, currency, "auto"));
  } catch {
    return null;
  }
  if (amountMinor <= 0) return null;
  const merchant = p.merchant.trim();
  return {
    format: "IOS_SHORTCUT",
    // A negative Wallet amount is money coming back (refund): never counted as spending.
    kind: negative ? "REFUND" : "PURCHASE",
    merchantRaw: merchant || null,
    amountMinor,
    currency,
    cardHint: p.card?.trim() || null,
    occurredAt: shortcutDate(p.date),
  };
}
