import { isKnownCurrency } from "@kassa/shared";
import { transliterate } from "transliteration";

import { SYMBOLS } from "../capture/amount.ts";

/*
 * Statement rows: what every reader (JSON records, CSV / Excel grids, PDF tables, PDF text lines, the AI fallback)
 * turns a bank statement into, before classification (classify.ts) and history (history.ts).
 * Statement facts (account currency, card last 4, the holder's name) are read from the text around the rows. They
 * are used here, in code, and never stored: the holder's name only redacts (redact.ts) and spots own transfers.
 */

export type RowKind = "PURCHASE" | "FEE" | "FX_DIFF" | "TRANSFER_OUT" | "CASH" | "INCOME" | "OWN_TRANSFER" | "REFUND";

/** Which reader produced a row (shown in the preview, so a wrong mapping can be traced). */
export type RowVia = "records" | "table" | "lines" | "ai";

export interface StatementRow {
  occurredAt: string;
  description: string;
  /** The bank's own operation word ("Покупка", "Толықтыру", "CHECKCARD"), when it has one. */
  operation: string | null;
  /** Signed minor units in `currency`: negative is money out. For a purchase abroad, the amount in the shop's currency. */
  amountMinor: number;
  currency: string;
  /** What the account was actually debited or credited (signed like amountMinor), when that is another currency. */
  settled: { amountMinor: number; currency: string } | null;
  category: string | null;
  cardLast4: string | null;
  mcc: string | null;
  kind?: RowKind;
  via: RowVia;
  /** Index of the file in the upload (own transfers are paired across files). */
  file: number;
}

export interface StatementFacts {
  /** ISO 4217 code of the account, when the statement says it. */
  accountCurrency: string | null;
  /** Last 4 digits of the statement's card, never more. */
  cardLast4: string | null;
  /** The holder's name as printed (for redaction and own-transfer checks only). */
  holderNames: string[];
  /** The bank, as printed (for the preview label). */
  bank: string | null;
}

const CURRENCY_WORDS: Array<[RegExp, string]> = [[/теңге|тенге|tenge/i, "KZT"], [/доллар|dollar/i, "USD"], [/евро|euro/i, "EUR"], [/форинт|forint/i, "HUF"], [/юан|yuan|renminbi/i, "CNY"]];

/** A currency named in a short label value: an ISO code, a symbol or a word. */
export function currencyOfLabel(s: string): string | null {
  const code = /\b([A-Z]{3})\b/.exec(s)?.[1];
  if (code && isKnownCurrency(code)) return code;
  for (const [re, c] of [...SYMBOLS, ...CURRENCY_WORDS]) if (re.test(s)) return c;
  return null;
}

const ACCOUNT_CURRENCY_LABEL = /(?:валюта\s*сч[её]та|шот\s*валютасы|account\s*currency|currency\s*of\s*(?:the\s*)?account|kontowährung|számla\s*devizaneme)\s*[:-]?\s*([^\n]{1,30})/giu;
const BANKS: Array<[RegExp, string]> = [
  [/\bkaspi\b/i, "Kaspi"],
  [/\bhalyk\b/i, "Halyk"],
  [/alatau\s*city|jusan|TSESKZKA/i, "Alatau City Bank"],
  [/forte\s*bank|IRTYKZKA/i, "ForteBank"],
  [/freedom\s*bank|KSNVKZKA/i, "Freedom Bank"],
  [/bereke|BRKEKZKA/i, "Bereke Bank"],
  [/bank\s*of\s*america/i, "Bank of America"],
  [/\bchase\b/i, "Chase"],
  [/wells\s*fargo/i, "Wells Fargo"],
  [/\brevolut\b/i, "Revolut"],
  [/\bwise\b|transferwise/i, "Wise"],
  [/\botp\b/i, "OTP"],
  [/\braiffeisen\b/i, "Raiffeisen"],
  [/\bn26\b/i, "N26"],
];

/** Statement facts from the text around the rows (see StatementFacts). */
export function statementFacts(text: string): StatementFacts {
  const head = text.slice(0, 20_000);
  const labelled = [...head.matchAll(ACCOUNT_CURRENCY_LABEL)].map((m) => currencyOfLabel(m[1]!)).filter((c): c is string => !!c);
  // "Транзакции по счету: KZ.. KZT", "Account ... (EUR)": a code right after an account caption.
  const caption = /(?:транзакции\s*по\s*сч[её]ту|операции\s*по\s*сч[её]ту|transactions\s*(?:on|for)\s*account)[^\n]*?\b([A-Z]{3})\b/iu.exec(head)?.[1];
  // Else the currency the statement's amounts carry most ("$251.23", "113 851,84 ₸"), when it is clear.
  const symbolVotes = new Map<string, number>();
  for (const [re, c] of SYMBOLS) symbolVotes.set(c, (head.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length);
  const [topSymbol, topVotes] = [...symbolVotes].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const accountCurrency = labelled[0] ?? (caption && isKnownCurrency(caption) ? caption : null) ?? (topVotes >= 3 ? topSymbol : null);

  // Masked card numbers: 400000******7710, **** 4821, *4821, "ending in 1234". The last 4 digits only.
  const masked =
    /\b\d{4,6}[*xX•]{4,}(\d{4})\b/.exec(head)?.[1] ??
    /(?:карт[аы]|карточки|card|карта\s*нөмірі)[^\n\d*]{0,30}[*xX•]{1,}\s?(\d{4})\b/iu.exec(head)?.[1] ??
    /\bending\s*in\s*(\d{4})\b/i.exec(head)?.[1] ??
    null;

  const holderNames = new Set<string>();
  for (const m of head.matchAll(/(?:ФИО|Ф\.И\.О\.|Аты-жөні|Клиент|Name|Customer|Account\s*holder)\s*:\s*([^\n:]{3,60})/giu)) holderNames.add(m[1]!.trim());
  // "Сейтқали Дана Нұрланқызы, ЖСН 9901…" / "Ivanov Ivan, ИИН …": the name before a national id label.
  for (const m of head.matchAll(/([\p{Lu}][\p{L}'-]+(?:\s+[\p{Lu}][\p{L}'-]+){1,2}),?\s+(?:ЖСН|ИИН|IIN|ИНН)(?![\p{L}])/gu)) holderNames.add(m[1]!.trim());
  // US layout: "NAME SURNAME | Account # 1234 ..." on every page.
  for (const m of head.matchAll(/^\s*([A-Z][A-Z'-]+(?:\s+[A-Z][A-Z'-]+){1,3})\s*[|!]\s*Account\s*(?:#|number)/gmu)) holderNames.add(m[1]!.trim());
  // The bank named first (its letterhead), not one mentioned later in a transfer's details.
  const bank = BANKS.map(([re, name]) => ({ name, at: re.exec(head)?.index ?? Infinity })).sort((a, b) => a.at - b.at).find((b) => b.at < Infinity)?.name ?? null;
  return { accountCurrency, cardLast4: masked, holderNames: [...holderNames].filter((n) => n.split(/\s+/).length >= 2 || n.length >= 4), bank };
}

/** Lower-case Latin letters of a name token ("Нұрланқызы" → "nurlanqyzy"), for matching across scripts. */
export function latinToken(s: string): string {
  return transliterate(s.normalize("NFKC")).toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Does a counterparty text name the holder? "ДАНА С., Alatau City Bank" matches "Dana Seitkali": the first name
 * in full plus the surname's initial (Kaspi's own-account style), or two full name tokens. Matching is in Latin letters,
 * so Cyrillic and Latin spellings meet (transliteration varies: "y"/"i", "zh"/"j").
 */
export function namesHolder(text: string, holders: string[]): boolean {
  const soften = (s: string) => s.replace(/y/g, "i").replace(/j/g, "zh").replace(/kh/g, "h").replace(/q/g, "k");
  const words = text.split(/[\s,.;:()]+/).filter(Boolean).map((w) => soften(latinToken(w)));
  for (const holder of holders) {
    const tokens = holder.split(/\s+/).map((w) => soften(latinToken(w))).filter((w) => w.length >= 3);
    if (tokens.length < 2) continue;
    const full = tokens.filter((tok) => words.includes(tok));
    if (full.length >= 2) return true;
    if (full.length === 1) {
      // First name in full plus another name's initial right after it ("ДАНА С.").
      const i = words.indexOf(full[0]!);
      const next = words[i + 1];
      if (next && next.length <= 2 && tokens.some((tok) => tok !== full[0] && tok.startsWith(next))) return true;
    }
  }
  return false;
}
