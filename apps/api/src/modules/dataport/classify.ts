import { cleanDescription } from "./mapper.ts";
import { namesHolder, type RowKind, type StatementRow } from "./statement.ts";

/*
 * What each statement row is, decided in code (never by a model): spending (a purchase, a fee, an FX difference, cash,
 * a transfer to someone), money in (income, a refund) or a transfer between the user's own accounts, which is neither
 * and must not be counted twice when two banks' statements are imported together. Own transfers are found three ways:
 * the bank says so ("Өз шотыңызға", "between your accounts"), the counterparty is the holder ("МАДИЯР Б., Alatau City
 * Bank"), or the same amount leaves one uploaded account and arrives in another within 3 days.
 */

/** Bank operation words at the start of a description, stripped from the merchant name (Unicode word ends: `\b` is ASCII-only). */
const OPERATIONS = [
  "зат сатып алу",
  "сатып алу",
  "аударым",
  "толықтыру",
  "ақша алу",
  "(?:ә|ə)ртүрлі",
  "өз шотыңыз(?:дан|ға)",
  "покупка",
  "оплата(?: товаров и услуг)?",
  "перевод по номеру телефона",
  "перевод(?: средств)?",
  "пополнение по номеру телефона от",
  "зачисления из других источников:\\s*зачисление",
  "зачисление от",
  "пополнение",
  "снятие(?: наличных)?",
  "комиссия",
  "возврат",
  "(?:checkcard|mobile purchase|purchase|pos purchase|debit card purchase|recurring payment)(?:\\s+\\d{4})?",
  "atm (?:withdrawal|cash)",
].map((o) => new RegExp(`^${o}(?![\\p{L}\\p{N}])`, "iu"));

const OWN = /өз шот|own account|between (?:my|your) accounts|to savings|from savings|internal transfer|собственн\S* (?:сч|средств)|между своими|своего сч|на свой сч|\d{4} kaspi шот(?:ынан|ына)|басқа банктің картасынан|saját száml/i;
const FX_DIFF = /бағамдық айырма|курсов\S* разниц|exchange(?: rate)? difference|fx adjustment|conversion difference/i;
const FEE = /комисси|\bfee\b|fees\b|service charge|maintenance charge|overdraft|қызмет ақы|regular charge|díj\b/i;
const CASH = /\batm\b|cash withdrawal|снятие наличн|ақша алу|банкомат|készpénz/i;
const REFUND = /refund|возврат|қайтару|reversal|chargeback|return of/i;
const TRANSFER = /перевод|аударым|зачислени|transfer|zelle|venmo|cash app|p2p|card to card|с карты на карту|átutalás|толықтыру|пополнение|top-?up|deposit from|payment from/i;

const DAY = 86_400_000;

export interface ClassifyContext {
  /** Holder names per file (statement facts) plus the user's profile name. */
  holders: string[][];
}

/** Split the bank's operation word off the description: "Зат сатып алу CORVINMOZI.HU" → ["Зат сатып алу", "CORVINMOZI.HU"]. */
export function splitOperation(description: string): { operation: string | null; rest: string } {
  for (const re of OPERATIONS) {
    const m = re.exec(description);
    if (m) return { operation: m[0], rest: description.slice(m[0].length).trim() || description };
  }
  return { operation: null, rest: description };
}

/** Classify every row in place and clean its description (see the header comment). */
export function classifyRows(rows: StatementRow[], ctx: ClassifyContext): StatementRow[] {
  for (const r of rows) {
    const split = splitOperation(r.description);
    if (!r.operation && split.operation) r.operation = split.operation;
    const all = `${r.operation ?? ""} ${r.description}`;
    r.description = cleanDescription(split.rest);
    const holders = ctx.holders[r.file] ?? ctx.holders[0] ?? [];
    const out = r.amountMinor < 0;
    let kind: RowKind;
    if (OWN.test(all) || (TRANSFER.test(all) && namesHolder(r.description, holders))) kind = "OWN_TRANSFER";
    else if (FX_DIFF.test(all)) kind = out ? "FX_DIFF" : "REFUND";
    else if (out && FEE.test(all) && !/zelle|перевод|аударым/i.test(all)) kind = "FEE";
    else if (out && CASH.test(all)) kind = "CASH";
    else if (!out && REFUND.test(all)) kind = "REFUND";
    else if (!out) kind = /покупка|сатып алу|purchase|checkcard/i.test(all) ? "REFUND" : "INCOME";
    else if (TRANSFER.test(all)) kind = "TRANSFER_OUT";
    else kind = "PURCHASE";
    r.kind = kind;
  }
  pairOwnTransfers(rows);
  pairReversals(rows);
  return rows;
}

/**
 * A cancelled card hold comes back as money in from the same merchant for the same amount ("Пополнение YANDEX.GO"
 * after "Покупка YANDEX.GO"). Both rows are left out (a reversal is not income, and the purchase did not happen).
 */
function pairReversals(rows: StatementRow[]): void {
  const purchases = rows.filter((r) => r.kind === "PURCHASE");
  const used = new Set<StatementRow>();
  for (const r of rows) {
    if (r.kind !== "INCOME") continue;
    const t = Date.parse(r.occurredAt);
    const name = r.description.toLowerCase();
    const p = purchases.find((x) => !used.has(x) && x.file === r.file && x.currency === r.currency && x.amountMinor === -r.amountMinor && x.description.toLowerCase() === name && Math.abs(Date.parse(x.occurredAt) - t) <= 10 * DAY);
    if (!p) continue;
    used.add(p);
    p.kind = "REFUND";
    r.kind = "REFUND";
  }
}

/**
 * The same amount leaving one uploaded file and arriving in another within 3 days, both transfers: an own transfer
 * (Kaspi → Alatau). Matched on the account-side amount (settled when present), one partner per row.
 */
function pairOwnTransfers(rows: StatementRow[]): void {
  const side = (r: StatementRow) => r.settled ?? { amountMinor: r.amountMinor, currency: r.currency };
  const outs = rows.filter((r) => r.kind === "TRANSFER_OUT");
  const ins = rows.filter((r) => r.kind === "INCOME");
  const used = new Set<StatementRow>();
  for (const o of outs) {
    const so = side(o);
    const t = Date.parse(o.occurredAt);
    const partner = ins.find((i) => {
      if (used.has(i) || i.file === o.file) return false;
      const si = side(i);
      return si.currency === so.currency && si.amountMinor === -so.amountMinor && Math.abs(Date.parse(i.occurredAt) - t) <= 3 * DAY;
    });
    if (partner) {
      used.add(partner);
      o.kind = "OWN_TRANSFER";
      partner.kind = "OWN_TRANSFER";
    }
  }
}

/** The spending category a row's kind implies (null: the categoriser decides from the merchant). */
export function kindCategory(kind: RowKind | undefined): string | null {
  if (kind === "FEE" || kind === "FX_DIFF") return "fees";
  if (kind === "CASH") return "cash";
  if (kind === "TRANSFER_OUT") return "transfers";
  return null;
}

export const SPENDING_KINDS: ReadonlySet<RowKind> = new Set(["PURCHASE", "FEE", "FX_DIFF", "CASH", "TRANSFER_OUT"]);
