/**
 * Locale-aware display formatting. Money goes through `formatMoney` from @kassa/shared (spec §16:
 * no money maths in the client beyond formatting); dates take ISO 8601 / RFC 3339 strings in and
 * come out localised through Intl with the active BCP 47 locale tag.
 */
import { formatMoney, isSupportedCurrency } from "@kassa/shared";
import { useMemo } from "react";

import { useLocaleTag } from "@/lib/i18n";

/** Money in its own ISO 4217 currency. Unknown currencies show the code instead of throwing. */
export function formatAmount(amountMinor: number, currency: string, locale: string): string {
  if (isSupportedCurrency(currency)) return formatMoney(amountMinor, currency, locale);
  // Outside Kassa's currency table: still never guess an exponent - show the raw minor units.
  return `${new Intl.NumberFormat(locale).format(amountMinor)} ${currency} (minor units)`;
}

/** `YYYY-MM-DD` calendar date (ISO 8601) - formatted in UTC so it never shifts a day. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatDate(
  iso: string,
  locale: string,
  style: "medium" | "long" | "short" = "medium"
) {
  const date = new Date(DATE_ONLY.test(iso) ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: style,
    ...(DATE_ONLY.test(iso) ? { timeZone: "UTC" } : {}),
  }).format(date);
}

export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Basis points (1/100 of a percent) as a localised percentage, e.g. 400 -> "4%". */
export function formatBps(bps: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(
    bps / 10_000
  );
}

export function formatPercent(ratio: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
    ratio
  );
}

/** Localised ISO 4217 currency name ("Kazakhstani Tenge"); falls back to the code. */
export function currencyName(code: string, locale: string): string {
  try {
    const names = new Intl.DisplayNames([locale], { type: "currency" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Bound formatters for the active locale. */
export function useFormat() {
  const locale = useLocaleTag();
  return useMemo(
    () => ({
      locale,
      money: (amountMinor: number, currency: string) => formatAmount(amountMinor, currency, locale),
      date: (iso: string, style?: "medium" | "long" | "short") => formatDate(iso, locale, style),
      dateTime: (iso: string) => formatDateTime(iso, locale),
      bps: (bps: number) => formatBps(bps, locale),
      percent: (ratio: number) => formatPercent(ratio, locale),
      currencyName: (code: string) => currencyName(code, locale),
    }),
    [locale]
  );
}
