import { toMinor } from "@kassa/shared";

/*
 * Locale-aware amount parsing for notification text. Output is integer minor units via
 * @kassa/shared `toMinor` (ISO 4217 exponents); no floats.
 *  - "comma": decimal comma, space / NBSP / thin space (U+2009, U+202F) / dot thousands (ru, kk, hu).
 *  - "dot": decimal dot, comma thousands (en, zh).
 *  - "auto": a separator followed by exactly 1–2 trailing digits is the decimal mark; one followed by
 *    exactly 3 digits is a thousands separator (all supported currencies have exponent 2, so a
 *    3-digit fraction cannot be an amount).
 */

export type AmountStyle = "comma" | "dot" | "auto";

const SPACES = /[\s\u00a0\u2009\u202f]/g;

export function parseAmountString(raw: string, currency: string, style: AmountStyle = "auto"): number {
  let s = raw.trim().replace(SPACES, "").replace(/['’]/g, "");
  if (!/^\d[\d.,]*$/.test(s)) throw new RangeError(`not an amount: ${raw}`);
  if (style === "comma") s = s.replace(/\./g, "").replace(",", ".");
  else if (style === "dot") s = s.replace(/,/g, "");
  else {
    const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
    if (last === -1) {
      // integer
    } else {
      const frac = s.length - last - 1;
      const decimalMark = frac === 1 || frac === 2;
      const intPart = s.slice(0, last).replace(/[.,]/g, "");
      s = decimalMark ? `${intPart}.${s.slice(last + 1)}` : `${intPart}${s.slice(last + 1)}`;
    }
  }
  return toMinor(s, currency);
}

/** Currency symbols / local abbreviations → ISO 4217. */
export const SYMBOLS: Array<[RegExp, string]> = [
  [/₸|тг\b|тенге|теңге/i, "KZT"],
  [/€/, "EUR"],
  [/\bFt\b|forint/i, "HUF"],
  [/US\$|\$/, "USD"],
  [/[¥￥]|元|人民币|\bRMB\b/, "CNY"],
];

export function currencyFromText(s: string): string | null {
  const code = /\b(KZT|EUR|HUF|USD|CNY)\b/.exec(s)?.[1];
  if (code) return code;
  for (const [re, c] of SYMBOLS) if (re.test(s)) return c;
  return null;
}
