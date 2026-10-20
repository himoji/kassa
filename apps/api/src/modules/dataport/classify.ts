import { cleanDescription } from "./mapper.ts";
import { namesHolder, type RowKind, type StatementRow } from "./statement.ts";

/*
 * What each statement row is, decided in code (never by a model): spending (a purchase, a fee, an FX difference, cash,
 * a transfer to someone), money in (income, a refund) or a transfer between the user's own accounts, which is neither
 * and must not be counted twice when two banks' statements are imported together. Own transfers are found three ways:
 * the bank says so ("Өз шотыңызға", "between your accounts"), the counterparty is the holder ("ДАНА С., Alatau City
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
  // English statements from Kazakh banks (Kaspi "Transaction" column, Alatau "Operation" column and details).
  "replenishment by phone number from",
  "transfer by phone number to",
  "credits from other sources:\\s*(?:зачисление)?",
  "payment of commission:",
  "commission:",
  "transfers? to your(?: accounts?)?",
  "receipts? from your(?: accounts?)?",
  "purchases",
  "transfers",
  "replenishment",
  "withdrawals?",
  "others",
  // Arabic, Hebrew, Turkish, German, French, Spanish: the common operation words.
  "(?:شراء|مشتريات|تحويل|حوالة|إيداع|سحب(?: نقدي)?|رسوم|عمولة|استرداد)",
  "(?:רכישה|העברה|הפקדה|משיכה|עמלה|החזר)",
  "(?:alışveriş|harcama|havale|eft|para yatırma|para çekme|ücret|komisyon|iade)",
  "(?:kartenzahlung|lastschrift|überweisung|gutschrift|bargeldauszahlung|gebühr|erstattung)",
  "(?:paiement par carte|achat|virement|prélèvement|retrait|frais|remboursement)",
  "(?:compra|transferencia|retiro|comisión|reembolso|abono|cargo)",
].map((o) => new RegExp(`^${o}(?![\\p{L}\\p{N}])`, "iu"));

const OWN = /өз шот|own account|between (?:my|your) accounts|transfers? to your|receipts? from your|kaspi deposit|from kaspi account|from card of other banks|cash deposit|пополнение через банкомат|to savings|from savings|internal transfer|собственн\S* (?:сч|средств)|между своими|своего сч|на свой сч|\d{4} kaspi шот(?:ынан|ына)|басқа банктің картасынан|saját száml/i;
const FX_DIFF = /бағамдық айырма|курсов\S* разниц|exchange(?: rate)? difference|fx adjustment|conversion difference/i;
const FEE = /комисси|commission|\bfee\b|fees\b|رسوم|عمولة|עמלה|ücret|komisyon|gebühr|frais|comisión|service charge|maintenance charge|overdraft|қызмет ақы|regular charge|díj\b/i;
const CASH = /\batm\b(?!.*deposit)|cash withdrawal|سحب نقدي|משיכ|para çekme|bargeld|retrait|снятие наличн|ақша алу|банкомат|készpénz/i;
const REFUND = /refund|استرداد|החזר|iade|erstattung|remboursement|reembolso|возврат|қайтару|reversal|chargeback|return of/i;
const TRANSFER = /перевод|аударым|зачислени|transfer|zelle|venmo|cash app|p2p|card to card|с карты на карту|átutalás|replenishment|تحويل|حوالة|إيداع|העברה|הפקדה|havale|\beft\b|überweisung|gutschrift|virement|transferencia|толықтыру|пополнение|top-?up|deposit from|payment from/i;

/** Card-to-card details after the operation word: "с карты:441328******3273;получатель: Жанель Ш." (masked card cut). */
const CARD_TO_CARD = /^(?:перевод\s+)?с карты:\s*[\d*]+\s*;\s*получатель:\s*;?\s*/iu;
/** A card payment made with bank bonuses: a purchase, though its details say "зачисление бонусов". */
const BONUS_PAYMENT = /payment by bonuses|оплат\S* бонус/i;

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
    // Kaspi wraps "Transfer to your / account" onto two lines; the second half lands at the end of the details.
    const rest = split.rest.replace(CARD_TO_CARD, "") || split.rest;
    r.description = cleanDescription(/your$/i.test(split.operation ?? "") ? rest.replace(/\s+accounts?$/i, "") : rest);
    const holders = ctx.holders[r.file] ?? ctx.holders[0] ?? [];
    const out = r.amountMinor < 0;
    let kind: RowKind;
    if (OWN.test(all) || (TRANSFER.test(all) && namesHolder(r.description, holders))) kind = "OWN_TRANSFER";
    else if (FX_DIFF.test(all)) kind = out ? "FX_DIFF" : "REFUND";
    else if (out && FEE.test(all) && (!/zelle|перевод|аударым/i.test(all) || /^\s*(?:payment of )?(?:commission|комиссия)/i.test(all))) kind = "FEE";
    else if (out && CASH.test(all)) kind = "CASH";
    else if (!out && REFUND.test(all)) kind = "REFUND";
    else if (!out) kind = /покупка|сатып алу|purchase|checkcard/i.test(all) ? "REFUND" : "INCOME";
    else if (TRANSFER.test(all) && !BONUS_PAYMENT.test(all)) kind = "TRANSFER_OUT";
    else kind = "PURCHASE";
    r.kind = kind;
  }
  pairOwnTransfers(rows);
  pairReversals(rows);
  return rows;
}

const accountSide = (r: StatementRow) => r.settled?.currency ?? r.currency;

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
    // Same account side too: a multi-currency card books a foreign purchase in the main account and, as a top-up plus
    // payment that cancel out, in the sub-account of the shop's currency (Alatau). Only that pair is left out.
    const p = purchases.find((x) => !used.has(x) && x.file === r.file && x.currency === r.currency && x.amountMinor === -r.amountMinor && accountSide(x) === accountSide(r) && x.description.toLowerCase() === name && Math.abs(Date.parse(x.occurredAt) - t) <= 10 * DAY);
    if (!p) continue;
    used.add(p);
    p.kind = "REFUND";
    r.kind = "REFUND";
  }
  // A sub-account top-up left over (the bank funded one payment with two top-ups, 27.70 + 1,820.12 USD): money moved
  // from the main account for a purchase in the shop's currency, never income. Same file, merchant and shop amount.
  const paid = rows.filter((r) => r.kind === "PURCHASE" || (r.kind === "REFUND" && r.amountMinor < 0));
  for (const r of rows) {
    if (r.kind !== "INCOME" || !r.settled) continue;
    const t = Date.parse(r.occurredAt);
    const name = r.description.toLowerCase();
    if (paid.some((x) => x.file === r.file && x.currency === r.currency && x.amountMinor === -r.amountMinor && x.description.toLowerCase() === name && Math.abs(Date.parse(x.occurredAt) - t) <= DAY)) r.kind = "OWN_TRANSFER";
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
