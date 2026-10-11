import { fromMinor, normalizeIban } from "@kassa/shared";

import type { InvoiceLanguage, InvoiceSpec } from "../../../../fixtures/invoices/source.ts";
import { invoiceTotals } from "../../../../fixtures/invoices/source.ts";
import type { Pen } from "./doc.ts";
import { COLORS, renderPdf } from "./doc.ts";
import { formatAmount, formatDate, formatIban } from "./format.ts";

/*
 * Invoice renderer: one InvoiceSpec -> one deterministic PDF, in one of nine layouts. Returns the
 * exact strings printed for each labelled field so tests can check them against extracted text.
 * Each labelled value is drawn as a single text run and never wrapped.
 */

export interface InvoiceLabel {
  id: string;
  file: string;
  layout: string;
  language: InvoiceLanguage;
  payeeName: string;
  /** Electronic IBAN format (ISO 13616, no spaces). */
  accountNumber: string;
  reference: string | null;
  /** Amount due as a plain decimal string in major units ("2400.00"). */
  amount: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
}

export interface PrintedFields {
  payeeName: string;
  accountNumber: string;
  reference: string | null;
  amount: string;
  dueDate: string;
}

export interface RenderedInvoice {
  pdf: Uint8Array;
  label: InvoiceLabel;
  printed: PrintedFields;
}

interface Words {
  invoice: string;
  number: string;
  issued: string;
  due: string;
  billTo: string;
  from: string;
  description: string;
  qty: string;
  unit: string;
  lineAmount: string;
  net: string;
  vat: (pct: string) => string;
  total: string;
  paid: string;
  amountDue: string;
  payTo: string;
  beneficiary: string;
  iban: string;
  bic: string;
  reference: string;
  noReference: string;
  vatId: string;
}

const WORDS: Record<InvoiceLanguage, Words> = {
  en: {
    invoice: "INVOICE", number: "Invoice no.", issued: "Issue date", due: "Due date", billTo: "Bill to", from: "From",
    description: "Description", qty: "Qty", unit: "Unit price", lineAmount: "Amount", net: "Subtotal",
    vat: (p) => `VAT ${p}%`, total: "Total", paid: "Already paid", amountDue: "Amount due", payTo: "Payment details",
    beneficiary: "Beneficiary", iban: "IBAN", bic: "BIC", reference: "Payment reference",
    noReference: "No payment reference required", vatId: "VAT ID",
  },
  de: {
    invoice: "RECHNUNG", number: "Rechnungsnummer", issued: "Rechnungsdatum", due: "Fällig am", billTo: "Rechnungsempfänger",
    from: "Absender", description: "Beschreibung", qty: "Menge", unit: "Einzelpreis", lineAmount: "Betrag",
    net: "Nettobetrag", vat: (p) => `USt. ${p} %`, total: "Gesamtbetrag", paid: "Bereits bezahlt", amountDue: "Zahlbetrag",
    payTo: "Bankverbindung", beneficiary: "Kontoinhaber", iban: "IBAN", bic: "BIC", reference: "Verwendungszweck",
    noReference: "Kein Verwendungszweck erforderlich", vatId: "USt-IdNr.",
  },
  hu: {
    invoice: "SZÁMLA", number: "Számlaszám", issued: "Kiállítás dátuma", due: "Esedékesség", billTo: "Vásárló",
    from: "Eladó", description: "Megnevezés", qty: "Menny.", unit: "Egységár", lineAmount: "Összeg", net: "Nettó összesen",
    vat: (p) => `ÁFA ${p}%`, total: "Bruttó összesen", paid: "Már befizetve", amountDue: "Végösszeg",
    payTo: "Fizetési adatok", beneficiary: "Kedvezményezett", iban: "IBAN", bic: "BIC", reference: "Közlemény",
    noReference: "Közlemény nem szükséges", vatId: "Adószám",
  },
  fr: {
    invoice: "FACTURE", number: "N° de facture", issued: "Date d'émission", due: "Échéance", billTo: "Facturé à",
    from: "Émetteur", description: "Désignation", qty: "Qté", unit: "Prix unitaire", lineAmount: "Montant",
    net: "Total HT", vat: (p) => `TVA ${p} %`, total: "Total TTC", paid: "Déjà réglé", amountDue: "Net à payer",
    payTo: "Coordonnées bancaires", beneficiary: "Titulaire du compte", iban: "IBAN", bic: "BIC",
    reference: "Référence à rappeler", noReference: "Aucune référence requise", vatId: "N° TVA",
  },
};

// Vowel "ő" (U+0151) is not in WinAnsi; the Hungarian word list above avoids it (e.g. "Végösszeg").

interface Ctx {
  spec: InvoiceSpec;
  w: Words;
  printed: PrintedFields;
  money: (minor: number) => string;
  date: (iso: string) => string;
  totals: ReturnType<typeof invoiceTotals>;
}

function vatPct(bps: number): string {
  return bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2);
}

function linesTable(pen: Pen, c: Ctx, x0: number, x1: number, yTop: number, size = 9): number {
  const { w } = c;
  const colQty = x1 - 190;
  const colUnit = x1 - 95;
  pen.text(w.description, x0, yTop, { size, font: "bold" });
  pen.text(w.qty, colQty, yTop, { size, font: "bold", align: "right" });
  pen.text(w.unit, colUnit, yTop, { size, font: "bold", align: "right" });
  pen.text(w.lineAmount, x1, yTop, { size, font: "bold", align: "right" });
  pen.rule(x0, yTop - 5, x1);
  let y = yTop - 18;
  for (const l of c.spec.lines) {
    pen.text(l.description, x0, y, { size });
    pen.text(String(l.quantity), colQty, y, { size, align: "right" });
    pen.text(c.money(l.unitPriceMinor), colUnit, y, { size, align: "right" });
    pen.text(c.money(l.quantity * l.unitPriceMinor), x1, y, { size, align: "right" });
    y -= size * 1.8;
  }
  pen.rule(x0, y + 6, x1);
  return y - 6;
}

/** Totals block; the amount due line uses the printed label string. Returns the next y. */
function totalsBlock(pen: Pen, c: Ctx, xLabel: number, xRight: number, yTop: number, size = 10): number {
  const { w, spec, totals } = c;
  let y = yTop;
  const row = (label: string, value: string, bold = false) => {
    pen.text(label, xLabel, y, { size, font: bold ? "bold" : "regular" });
    pen.text(value, xRight, y, { size, font: bold ? "bold" : "regular", align: "right" });
    y -= size * 1.6;
  };
  if (spec.vatBps) {
    row(w.net, c.money(totals.netMinor));
    row(w.vat(vatPct(spec.vatBps)), c.money(totals.vatMinor));
  }
  if (spec.vatBps || spec.alreadyPaidMinor) row(w.total, c.money(totals.grossMinor));
  if (spec.alreadyPaidMinor) row(w.paid, `- ${c.money(spec.alreadyPaidMinor)}`);
  row(w.amountDue, c.printed.amount, true);
  return y;
}

function paymentRows(c: Ctx): [string, string][] {
  const { w, spec, printed } = c;
  const rows: [string, string][] = [
    [w.beneficiary, printed.payeeName],
    [w.iban, printed.accountNumber],
  ];
  if (spec.payment.bic) rows.push([w.bic, spec.payment.bic]);
  rows.push([w.reference, printed.reference ?? w.noReference]);
  rows.push([w.due, printed.dueDate]);
  return rows;
}

function keyValues(pen: Pen, rows: [string, string][], x: number, xv: number, y: number, size = 9.5): number {
  for (const [k, v] of rows) {
    pen.text(k, x, y, { size, color: COLORS.muted });
    pen.text(v, xv, y, { size, font: "bold" });
    y -= size * 1.7;
  }
  return y;
}

function partyLines(p: { name: string; addressLines: string[]; vatId?: string; email?: string; phone?: string }, w: Words): string[] {
  const out = [p.name, ...p.addressLines];
  if (p.vatId) out.push(`${w.vatId}: ${p.vatId}`);
  if (p.email) out.push(p.email);
  if (p.phone) out.push(p.phone);
  return out;
}

function headerFacts(c: Ctx): [string, string][] {
  return [
    [c.w.number, c.spec.invoiceNumber],
    [c.w.issued, c.date(c.spec.issueDate)],
  ];
}

// ---------- Layouts ----------

function classic(pen: Pen, c: Ctx): void {
  const { spec, w } = c;
  const L = 50;
  const R = pen.width - 50;
  pen.lines(partyLines(spec.issuer, w), L, 790, { size: 9 });
  pen.text(w.invoice, R, 790, { size: 22, font: "bold", color: COLORS.accent, align: "right" });
  let y = 760;
  for (const [k, v] of headerFacts(c)) {
    pen.text(`${k}: ${v}`, R, y, { size: 9, align: "right" });
    y -= 13;
  }
  pen.text(w.billTo, L, 680, { size: 9, font: "bold", color: COLORS.muted });
  pen.lines(partyLines(spec.billTo, w), L, 666, { size: 10 });
  y = linesTable(pen, c, L, R, 590);
  y = totalsBlock(pen, c, R - 220, R, y - 10);
  pen.text(w.payTo, L, y - 20, { size: 11, font: "bold", color: COLORS.accent });
  pen.rule(L, y - 26, R);
  keyValues(pen, paymentRows(c), L, L + 130, y - 44);
}

function modern(pen: Pen, c: Ctx): void {
  const { spec, w } = c;
  const L = 40;
  const R = pen.width - 40;
  pen.box(0, pen.height - 110, pen.width, 110, { fill: COLORS.accent });
  pen.text(spec.issuer.name, L, pen.height - 50, { size: 18, font: "bold", color: COLORS.white });
  pen.text(spec.issuer.addressLines.join(" | "), L, pen.height - 70, { size: 8.5, color: COLORS.white });
  pen.text(`${w.invoice} ${spec.invoiceNumber}`, R, pen.height - 50, { size: 12, font: "bold", color: COLORS.white, align: "right" });
  pen.text(`${w.issued} ${c.date(spec.issueDate)}`, R, pen.height - 70, { size: 9, color: COLORS.white, align: "right" });
  // Right column: payment box first (where the eye goes).
  const bx = pen.width / 2 + 10;
  pen.box(bx, 560, R - bx, 150, { fill: COLORS.band });
  pen.text(w.amountDue, bx + 14, 690, { size: 9, color: COLORS.muted });
  pen.text(c.printed.amount, bx + 14, 668, { size: 20, font: "bold" });
  keyValues(
    pen,
    paymentRows(c).filter(([k]) => k !== w.beneficiary),
    bx + 14,
    bx + 108,
    640,
    8.5,
  );
  pen.text(w.billTo, L, 700, { size: 9, font: "bold", color: COLORS.muted });
  pen.lines(partyLines(spec.billTo, w), L, 686, { size: 10 });
  pen.text(`${w.beneficiary}: ${c.printed.payeeName}`, L, 600, { size: 9.5 });
  const y = linesTable(pen, c, L, R, 520);
  totalsBlock(pen, c, R - 220, R, y - 10, 9.5);
}

/** Wrap segments (plain text breaks at spaces; atomic segments never break). */
function wrap(pen: Pen, segs: { t: string; atomic?: boolean }[], maxWidth: number, size: number): string[] {
  const tokens: string[] = [];
  for (const s of segs) {
    if (s.atomic) tokens.push(s.t);
    else tokens.push(...s.t.split(" ").filter(Boolean));
  }
  const lines: string[] = [];
  let cur = "";
  for (const tok of tokens) {
    const glue = cur === "" || /^[.,;:]/.test(tok) ? "" : " ";
    const next = cur + glue + tok;
    if (cur !== "" && pen.textWidth(next, size) > maxWidth) {
      lines.push(cur);
      cur = tok;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function letter(pen: Pen, c: Ctx): void {
  const { spec, w, printed } = c;
  const L = 72;
  const R = pen.width - 72;
  pen.text(spec.issuer.name, L, 780, { size: 14, font: "bold" });
  pen.text(spec.issuer.addressLines.join(", "), L, 764, { size: 9, color: COLORS.muted });
  pen.lines(partyLines(spec.billTo, w), L, 710, { size: 10.5 });
  pen.text(c.date(spec.issueDate), R, 710, { size: 10.5, align: "right" });
  pen.text(`Re: ${spec.lines[0]!.description} (${w.number} ${spec.invoiceNumber})`, L, 620, { size: 10.5, font: "bold" });
  const size = 11;
  const paras: { t: string; atomic?: boolean }[][] = [
    [{ t: `Dear ${spec.billTo.name},` }],
    [
      { t: "Thank you for enrolling. This letter is your invoice. Please transfer" },
      { t: printed.amount, atomic: true },
      { t: "to the account of" },
      { t: printed.payeeName, atomic: true },
      { t: ", IBAN" },
      { t: printed.accountNumber, atomic: true },
      ...(spec.payment.bic ? [{ t: `(BIC ${spec.payment.bic})` }] : []),
      ...(printed.reference
        ? [{ t: ", quoting the payment reference" }, { t: printed.reference, atomic: true }]
        : [{ t: ". No payment reference is needed" }]),
      { t: ", no later than" },
      { t: printed.dueDate, atomic: true },
      { t: "." },
    ],
    [{ t: "If you have already paid, please disregard this letter. Questions? Reply to this letter or contact our office." }],
    [{ t: "Kind regards," }],
    [{ t: `Accounts team, ${spec.issuer.name}` }],
  ];
  let y = 590;
  for (const p of paras) {
    for (const line of wrap(pen, p, R - L, size)) {
      pen.text(line, L, y, { size });
      y -= size * 1.5;
    }
    y -= size * 0.8;
  }
}

function slip(pen: Pen, c: Ctx): void {
  const { spec, w, printed } = c;
  const L = 45;
  const R = pen.width - 45;
  pen.text(spec.issuer.name, L, 790, { size: 15, font: "bold" });
  pen.text(`${w.invoice} / ${spec.invoiceNumber}`, R, 790, { size: 11, font: "bold", align: "right" });
  pen.lines(partyLines(spec.issuer, w).slice(1), L, 772, { size: 8.5, color: COLORS.muted });
  pen.text(`${w.issued}: ${c.date(spec.issueDate)}`, R, 772, { size: 8.5, align: "right" });
  pen.text(w.billTo, L, 700, { size: 9, font: "bold", color: COLORS.muted });
  pen.lines(partyLines(spec.billTo, w), L, 686, { size: 10 });
  let y = linesTable(pen, c, L, R, 610);
  totalsBlock(pen, c, R - 220, R, y - 10);
  // Tear-off remittance slip at the bottom of the page.
  y = 250;
  for (let x = L; x < R; x += 8) pen.rule(x, y, Math.min(x + 4, R), 0.8, COLORS.muted);
  pen.text("Remittance slip - detach and keep", L, y - 16, { size: 8, font: "italic", color: COLORS.muted });
  pen.box(L, 60, R - L, y - 90, { border: COLORS.ink, borderWidth: 1 });
  keyValues(
    pen,
    [
      [w.beneficiary, printed.payeeName],
      [w.iban, printed.accountNumber],
      ...(spec.payment.bic ? ([[w.bic, spec.payment.bic]] as [string, string][]) : []),
      [w.reference, printed.reference ?? w.noReference],
      [w.amountDue, printed.amount],
      [w.due, printed.dueDate],
    ],
    L + 16,
    L + 160,
    y - 50,
    10,
  );
}

function statement(pen: Pen, c: Ctx): void {
  const { spec, w } = c;
  const L = 50;
  const R = pen.width - 50;
  pen.text("ACCOUNT STATEMENT AND INVOICE", L, 795, { size: 14, font: "bold" });
  pen.text(spec.issuer.name, L, 777, { size: 10 });
  pen.text(spec.issuer.addressLines.join(", "), L, 764, { size: 8.5, color: COLORS.muted });
  keyValues(pen, [...headerFacts(c), ["Customer", spec.billTo.name]], R - 200, R - 110, 795, 8.5);
  pen.box(L, 690, R - L, 40, { fill: COLORS.band });
  pen.text("Balance brought forward", L + 10, 714, { size: 9, color: COLORS.muted });
  pen.text(c.money(0), L + 10, 700, { size: 10 });
  pen.text("Charges this period", L + 180, 714, { size: 9, color: COLORS.muted });
  pen.text(c.money(c.totals.grossMinor), L + 180, 700, { size: 10 });
  pen.text("Payments received", L + 350, 714, { size: 9, color: COLORS.muted });
  pen.text(c.money(spec.alreadyPaidMinor ?? 0), L + 350, 700, { size: 10 });
  let y = linesTable(pen, c, L, R, 650, 8.5);
  y = totalsBlock(pen, c, R - 240, R, y - 10, 9.5);
  pen.text(w.payTo, L, y - 20, { size: 10, font: "bold" });
  keyValues(pen, paymentRows(c), L, L + 140, y - 38, 9);
  pen.text("Please pay the amount due only. Do not pay the charges total if you have already made a payment.", L, 90, {
    size: 7.5,
    font: "italic",
    color: COLORS.muted,
  });
}

function receipt(pen: Pen, c: Ctx): void {
  const { spec, w, printed } = c;
  const L = 14;
  const R = pen.width - 14;
  let y = pen.height - 30;
  const center = (t: string, size = 8, font: "regular" | "bold" = "regular") => {
    pen.text(t, pen.width / 2, y, { size, font, align: "center" });
    y -= size * 1.5;
  };
  center(spec.issuer.name, 9, "bold");
  for (const a of spec.issuer.addressLines) center(a, 7);
  if (spec.issuer.vatId) center(`${w.vatId}: ${spec.issuer.vatId}`, 7);
  y -= 6;
  center("PAYMENT REQUEST", 9, "bold");
  pen.rule(L, y + 4, R);
  y -= 6;
  const kv = (k: string, v: string) => {
    pen.text(k, L, y, { size: 7 });
    y -= 9;
    pen.text(v, L + 6, y, { size: 7, font: "bold" });
    y -= 12;
  };
  kv(w.number, spec.invoiceNumber);
  kv(w.issued, c.date(spec.issueDate));
  for (const l of spec.lines) kv(`${l.quantity} x ${l.description}`.slice(0, 44), c.money(l.quantity * l.unitPriceMinor));
  if (spec.vatBps) kv(w.vat(vatPct(spec.vatBps)), c.money(c.totals.vatMinor));
  pen.rule(L, y + 6, R);
  kv(w.amountDue, printed.amount);
  kv(w.beneficiary, printed.payeeName);
  kv(w.iban, printed.accountNumber);
  kv(w.reference, printed.reference ?? w.noReference);
  kv(w.due, printed.dueDate);
}

function din(pen: Pen, c: Ctx): void {
  // German business letter (DIN 5008 form B): sender line above the address window, info block right.
  const { spec, w } = c;
  const L = 70;
  const R = pen.width - 57;
  pen.text(spec.issuer.name, R, 800, { size: 16, font: "bold", align: "right" });
  pen.text(`${spec.issuer.name} · ${spec.issuer.addressLines.join(" · ")}`, L, 715, { size: 6.5, color: COLORS.muted });
  pen.rule(L, 711, L + 240, 0.4);
  pen.lines(partyLines(spec.billTo, w), L, 695, { size: 10 });
  keyValues(pen, headerFacts(c), R - 190, R - 90, 700, 8.5);
  pen.text(`${w.invoice} ${spec.invoiceNumber}`, L, 590, { size: 13, font: "bold" });
  pen.text("Sehr geehrte Damen und Herren, wir berechnen Ihnen folgende Leistungen:", L, 570, { size: 9.5 });
  let y = linesTable(pen, c, L, R, 540);
  y = totalsBlock(pen, c, R - 220, R, y - 10);
  pen.text(`Bitte überweisen Sie den Zahlbetrag bis zum ${c.printed.dueDate} auf folgendes Konto:`, L, y - 16, { size: 9.5 });
  keyValues(pen, paymentRows(c).filter(([k]) => k !== w.due), L, L + 130, y - 38, 9.5);
  pen.rule(L, 70, R, 0.4);
  pen.text(
    `${spec.issuer.name} | ${spec.issuer.addressLines[0] ?? ""} | ${w.vatId} ${spec.issuer.vatId ?? "-"}`,
    pen.width / 2,
    58,
    { size: 7, color: COLORS.muted, align: "center" },
  );
}

function hungarian(pen: Pen, c: Ctx): void {
  // Hungarian számla: seller and buyer side by side in boxes, dates row, items, totals, payment.
  const { spec, w } = c;
  const L = 40;
  const R = pen.width - 40;
  const mid = pen.width / 2;
  pen.text(w.invoice, mid, 800, { size: 20, font: "bold", align: "center" });
  pen.text(`${w.number}: ${spec.invoiceNumber}`, mid, 782, { size: 9.5, align: "center" });
  pen.box(L, 660, mid - L - 6, 110, { border: COLORS.ink });
  pen.box(mid + 6, 660, R - mid - 6, 110, { border: COLORS.ink });
  pen.text(w.from, L + 8, 756, { size: 8, font: "bold", color: COLORS.muted });
  pen.lines(partyLines(spec.issuer, w), L + 8, 742, { size: 9 });
  pen.text(w.billTo, mid + 14, 756, { size: 8, font: "bold", color: COLORS.muted });
  pen.lines(partyLines(spec.billTo, w), mid + 14, 742, { size: 9 });
  const cols: [string, string][] = [
    [w.issued, c.date(spec.issueDate)],
    ["Teljesítés", c.date(spec.issueDate)],
    [w.due, c.printed.dueDate],
    ["Fizetési mód", "Átutalás"],
  ];
  const cw = (R - L) / cols.length;
  cols.forEach(([k, v], i) => {
    pen.box(L + i * cw, 615, cw, 36, { border: COLORS.rule });
    pen.text(k, L + i * cw + 6, 638, { size: 7.5, color: COLORS.muted });
    pen.text(v, L + i * cw + 6, 623, { size: 9.5, font: "bold" });
  });
  let y = linesTable(pen, c, L, R, 585);
  y = totalsBlock(pen, c, R - 230, R, y - 10);
  pen.text(w.payTo, L, y - 18, { size: 10, font: "bold" });
  keyValues(pen, paymentRows(c).filter(([k]) => k !== w.due), L, L + 120, y - 36, 9.5);
}

function french(pen: Pen, c: Ctx): void {
  const { spec, w } = c;
  const L = 45;
  const R = pen.width - 45;
  pen.lines(partyLines(spec.issuer, w), L, 795, { size: 9 });
  pen.box(R - 200, 735, 200, 70, { border: COLORS.accent, borderWidth: 1.2 });
  pen.text(w.invoice, R - 100, 785, { size: 16, font: "bold", color: COLORS.accent, align: "center" });
  pen.text(`${w.number} ${spec.invoiceNumber}`, R - 100, 765, { size: 8.5, align: "center" });
  pen.text(`${w.issued} : ${c.date(spec.issueDate)}`, R - 100, 750, { size: 8.5, align: "center" });
  pen.text(w.billTo, R - 200, 705, { size: 9, font: "bold", color: COLORS.muted });
  pen.lines(partyLines(spec.billTo, w), R - 200, 691, { size: 10 });
  let y = linesTable(pen, c, L, R, 600);
  y = totalsBlock(pen, c, R - 220, R, y - 10);
  pen.box(L, y - 120, R - L, 100, { fill: COLORS.band });
  pen.text(w.payTo, L + 10, y - 36, { size: 10, font: "bold" });
  keyValues(pen, paymentRows(c), L + 10, L + 150, y - 54, 9);
  pen.text("En cas de retard de paiement, une indemnité forfaitaire de 40 € pour frais de recouvrement est due.", L, 80, {
    size: 7,
    font: "italic",
    color: COLORS.muted,
  });
}

const LAYOUTS: Record<InvoiceSpec["layout"], (pen: Pen, c: Ctx) => void> = {
  classic,
  modern,
  letter,
  slip,
  statement,
  receipt,
  de: din,
  hu: hungarian,
  fr: french,
};

export async function renderInvoice(spec: InvoiceSpec): Promise<RenderedInvoice> {
  const totals = invoiceTotals(spec);
  if (totals.dueMinor <= 0) throw new RangeError(`${spec.id}: amount due must be positive`);
  const printed: PrintedFields = {
    payeeName: spec.payment.payeeName,
    accountNumber: formatIban(spec.payment.iban, spec.payment.ibanStyle),
    reference: spec.payment.reference,
    amount: formatAmount(totals.dueMinor, spec.currency, spec.amountStyle),
    dueDate: formatDate(spec.dueDate, spec.dateStyle),
  };
  const ctx: Ctx = {
    spec,
    w: WORDS[spec.language],
    printed,
    totals,
    money: (m) => formatAmount(m, spec.currency, spec.amountStyle),
    date: (d) => formatDate(d, spec.dateStyle),
  };
  const pdf = await renderPdf(
    {
      title: `${WORDS[spec.language].invoice} ${spec.invoiceNumber} - ${spec.issuer.name}`,
      subject: "Simulated invoice (Kassa demo)",
      font: spec.font,
      ...(spec.layout === "receipt" ? { size: [226.77, 600] as [number, number] } : {}),
    },
    (pen) => LAYOUTS[spec.layout](pen, ctx),
  );
  const label: InvoiceLabel = {
    id: spec.id,
    file: `${spec.id}.pdf`,
    layout: spec.layout,
    language: spec.language,
    payeeName: spec.payment.payeeName,
    accountNumber: normalizeIban(spec.payment.iban),
    reference: spec.payment.reference,
    amount: fromMinor(totals.dueMinor, spec.currency),
    amountMinor: totals.dueMinor,
    currency: spec.currency,
    dueDate: spec.dueDate,
  };
  return { pdf, label, printed };
}
