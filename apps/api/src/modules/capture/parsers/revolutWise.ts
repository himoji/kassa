import { currencyFromText, parseAmountString } from "../amount.ts";
import { DEFAULT_DEVICE_TZ, MONTHS_EN, zonedToUtc } from "../tz.ts";
import type { ParsedEvent, TextParser } from "./types.ts";

/*
 * English fintech app pushes (device time zone):
 *   Revolut-style: "Paid €12.40 at Noodle Bar" / "Card ••0596 · 27 Oct 2026, 12:40"
 *   Wise-style:    "You spent 1,290 HUF at Bean There Cafe." / "27 October 2026 at 09:15"
 */

const MONEY = String.raw`(?:([€$¥£]|[A-Z]{3})\s?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s?([A-Z]{3}))`;
const REVOLUT = new RegExp(String.raw`^\s*(?:You\s+)?[Pp]aid\s+${MONEY}\s+at\s+(.+?)\s*\.?\s*$`, "m");
const WISE = new RegExp(String.raw`^\s*You\s+spent\s+${MONEY}\s+at\s+(.+?)\.?\s*$`, "m");
const REFUND = new RegExp(String.raw`^\s*Refund\s+(?:of\s+)?${MONEY}\s+from\s+(.+?)\.?\s*$`, "m");

function enTime(text: string, tz: string): Date | null {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})(?:,|\s+at)?\s+(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return null;
  const mo = MONTHS_EN[m[2]!.toLowerCase()];
  return mo ? zonedToUtc(+m[3]!, mo, +m[1]!, +m[4]!, +m[5]!, 0, tz) : null;
}

function money(m: RegExpExecArray): { amountMinor: number; currency: string } | null {
  const symOrCode = m[1] ?? m[4];
  const amount = m[2] ?? m[3];
  if (!symOrCode || !amount) return null;
  const currency = /^[A-Z]{3}$/.test(symOrCode) ? symOrCode : currencyFromText(symOrCode);
  if (!currency) return null;
  return { amountMinor: parseAmountString(amount, currency, "dot"), currency };
}

function build(format: "REVOLUT" | "WISE", kind: ParsedEvent["kind"], m: RegExpExecArray, text: string, tz: string): ParsedEvent | null {
  const mm = money(m);
  if (!mm) return null;
  const card = /(?:Card|card ending)\s*[•*·.]*\s*(\d{4})/.exec(text)?.[1] ?? null;
  return { format, kind, merchantRaw: m[5]!.trim(), ...mm, cardHint: card, occurredAt: enTime(text, tz) };
}

export const revolutParser: TextParser = {
  format: "REVOLUT",
  matches: (t) => REVOLUT.test(t) || REFUND.test(t),
  parse(text, opts) {
    const tz = opts?.deviceTimeZone ?? DEFAULT_DEVICE_TZ;
    const r = REVOLUT.exec(text);
    if (r) return build("REVOLUT", "PURCHASE", r, text, tz);
    const f = REFUND.exec(text);
    return f ? build("REVOLUT", "REFUND", f, text, tz) : null;
  },
};

export const wiseParser: TextParser = {
  format: "WISE",
  matches: (t) => WISE.test(t),
  parse(text, opts) {
    const w = WISE.exec(text);
    return w ? build("WISE", "PURCHASE", w, text, opts?.deviceTimeZone ?? DEFAULT_DEVICE_TZ) : null;
  },
};
