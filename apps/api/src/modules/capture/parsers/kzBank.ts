import { parseAmountString } from "../amount.ts";
import { zonedToUtc } from "../tz.ts";
import type { EventKind, ParsedEvent, TextParser } from "./types.ts";

/*
 * Kazakh bank app push (generic format, Russian and Kazakh):
 *   Покупка: 4 760,00 HUF            | Сатып алу: 3 490,00 HUF       | Пополнение: 600 000,00 KZT
 *   FRESH MARKET HALL BP, BUDAPEST, HU
 *   Карта: *4821
 *   Доступно: 812 345,67 KZT         | Қолжетімді: ...
 *   26.10.2026 23:50                 (Asia/Almaty local time)
 */

const KINDS: Array<[RegExp, EventKind]> = [
  [/^(Покупка|Оплата|Сатып алу|Төлем)$/i, "PURCHASE"],
  [/^(Пополнение|Зачисление|Толықтыру|Түсім)$/i, "INCOMING"],
  [/^(Возврат|Қайтару)$/i, "REFUND"],
];

const HEAD = /^\s*(Покупка|Оплата|Сатып алу|Төлем|Пополнение|Зачисление|Толықтыру|Түсім|Возврат|Қайтару)\s*:?\s*([\d\s\u00a0\u2009\u202f]+(?:,\d{1,2})?)\s*(KZT|HUF|EUR|USD|CNY|₸|тг)/im;

export const kzBankParser: TextParser = {
  format: "KZ_BANK",
  matches: (t) => HEAD.test(t),
  parse(text) {
    const m = HEAD.exec(text);
    if (!m) return null;
    const verb = m[1]!;
    const kind = KINDS.find(([re]) => re.test(verb))?.[1] ?? "PURCHASE";
    const currency = /^[A-Z]{3}$/.test(m[3]!) ? m[3]! : "KZT";
    const amountMinor = parseAmountString(m[2]!, currency, "comma");

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const headIdx = lines.findIndex((l) => HEAD.test(l));
    let merchantRaw: string | null = null;
    let location: ParsedEvent["location"];
    const next = lines[headIdx + 1];
    if (kind !== "INCOMING" && next && !/^(Карта|Доступно|Қолжетімді|Перевод от|\d{2}\.\d{2}\.\d{4})/i.test(next)) {
      const parts = next.split(",").map((p) => p.trim());
      merchantRaw = parts[0] ?? null;
      const country = parts.length > 1 && /^[A-Z]{2}$/.test(parts[parts.length - 1]!) ? parts[parts.length - 1] : undefined;
      const city = parts.length > 2 ? parts[1] : parts.length === 2 && !country ? parts[1] : undefined;
      location = { ...(city ? { city } : {}), ...(country ? { country } : {}) };
    }
    const card = /Карта\s*:?\s*\*?(\d{4})/i.exec(text)?.[1] ?? null;
    const t = /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
    const occurredAt = t ? zonedToUtc(+t[3]!, +t[2]!, +t[1]!, +t[4]!, +t[5]!, +(t[6] ?? 0), "Asia/Almaty") : null;
    return { format: "KZ_BANK", kind, merchantRaw, amountMinor, currency, cardHint: card, occurredAt, ...(location && Object.keys(location).length ? { location } : {}) };
  },
};
