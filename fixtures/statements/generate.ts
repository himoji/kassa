/*
 * Sample bank statements for trying the statement import (POST /import/file, the onboarding agent's paperclip).
 * Dana (seed-data.ts) studies in Budapest; her parents in Kazakhstan send tenge when they can. A year of three of her
 * accounts, 15 Oct 2025 – 15 Oct 2026:
 *  - kaspi-gold-kzt.csv: a Kaspi Gold-style statement (Kazakh headers and wording, signed ₸ amounts, purchases abroad
 *    with the shop's HUF or EUR amount in brackets). Her father sends money in 8 of 12 months at different amounts,
 *    sometimes late, and once a large sum that pays a tuition deposit two days later; her mother sends a little now
 *    and then. Own transfers to her Hungarian account, a Kaspi deposit, summer at home in Almaty.
 *  - hu-bank-huf.csv: a Hungarian bank's account history (Hungarian headers, `2026.10.01.` dates, HUF), rent to the
 *    landlord, groceries, phone, transit pass, account fees, her own top-ups from the KZT and USD accounts, and one
 *    transfer from her father that arrives converted from KZT.
 *  - usd-account.ofx: an OFX 1.x statement of a USD account: a monthly scholarship, moves to the HUF account, fees.
 * Every name, account number and amount is made up (account numbers carry the invalid check digits 00). Output is
 * deterministic; run `bun fixtures/statements/generate.ts` after editing and commit the files.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = import.meta.dirname;

/** A small seeded generator, so every run writes the same files. */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}
const r = rng(2026);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const pad = (n: number) => String(n).padStart(2, "0");
/** Months of the statement period, as [year, month]. */
const MONTHS: [number, number][] = Array.from({ length: 13 }, (_, i) => [2025 + Math.floor((9 + i) / 12), ((9 + i) % 12) + 1]);
const FROM = "2025-10-15";
const TO = "2026-10-15";
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const inPeriod = (day: string) => day >= FROM && day <= TO;
/** Summer at home in Almaty (no Budapest spending). */
const atHome = (day: string) => day >= "2026-07-01" && day <= "2026-08-27";

/** "1234567.5" → "1 234 567,50" (Kazakh and Hungarian style: space thousands, comma decimals). */
function grouped(minor: number, decimals = 2): string {
  const major = Math.floor(Math.abs(minor) / 100);
  const frac = String(Math.abs(minor) % 100).padStart(2, "0");
  const int = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return decimals ? `${int},${frac}` : int;
}

// ---------- Kaspi Gold (KZT) ----------

/** Card rates (KZT per unit) the KZT card charged abroad: about 1.5 % over the example mid rates. */
const CARD_RATE = { HUF: 1.585, EUR: 621.6 } as const;

interface KaspiRow {
  day: string;
  /** Signed tenge in minor units (what the account moved). */
  kzt: number;
  op: string;
  details: string;
  /** The shop's amount (signed, minor units) and currency, for purchases abroad. */
  shop?: { minor: number; currency: "HUF" | "EUR" };
}

const kaspi: KaspiRow[] = [];
const buyAbroad = (day: string, details: string, huf: number) => {
  const minor = -huf * 100;
  kaspi.push({ day, kzt: Math.round(minor * CARD_RATE.HUF), op: "Зат сатып алу", details, shop: { minor, currency: "HUF" } });
};

// Money from home. Father: 8 of 12 months, different amounts, sometimes late; 24 Aug pays the tuition deposit.
const FATHER = "Нұрлан С.";
const MOTHER = "Гүлнар С.";
const fromHome: [string, string, number][] = [
  ["2025-10-28", FATHER, 180_000],
  ["2025-12-03", FATHER, 250_000],
  ["2025-12-27", FATHER, 120_000],
  ["2025-12-30", MOTHER, 30_000],
  ["2026-02-09", FATHER, 200_000],
  ["2026-03-21", FATHER, 150_000],
  ["2026-03-21", MOTHER, 25_000],
  ["2026-05-05", FATHER, 300_000],
  ["2026-06-18", FATHER, 90_000],
  ["2026-08-24", FATHER, 620_000],
  ["2026-09-01", MOTHER, 20_000],
  ["2026-09-30", FATHER, 200_000],
  ["2026-10-14", FATHER, 150_000],
];
for (const [day, who, kzt] of fromHome) kaspi.push({ day, kzt: kzt * 100, op: "Толықтыру", details: who });
// The tuition deposit (EUR 1,000) two days after the large transfer.
kaspi.push({ day: "2026-08-26", kzt: -Math.round(100_000 * CARD_RATE.EUR), op: "Зат сатып алу", details: "UNIVERSITY IN BUDAPEST", shop: { minor: -100_000, currency: "EUR" } });

// Own transfers to the Hungarian account (not in July and August), and the Kaspi deposit now and then.
const ownToHu = new Map<string, number>();
for (const [y, m] of MONTHS) {
  const day = iso(y, m, between(5, 9));
  if (!inPeriod(day) || atHome(day)) continue;
  const kzt = between(17, 23) * 10_000;
  ownToHu.set(day, kzt);
  kaspi.push({ day, kzt: -kzt * 100, op: "Аударым", details: "ДАНА С., Example Bank Hungary" });
}
for (const day of ["2025-11-20", "2026-02-15", "2026-05-12"]) kaspi.push({ day, kzt: -20_000 * 100, op: "Өз шотыңызға", details: "Kaspi Депозит" });
kaspi.push({ day: "2026-09-02", kzt: 45_000 * 100, op: "Өз шотыңыздан", details: "Kaspi Депозит" });

// Everyday spending on the KZT card: her Kazakh phone number and a music subscription every month, some purchases in
// Budapest (the card charges tenge), summer in Almaty, a friend paid back twice, a flight home in June.
for (const [y, m] of MONTHS) {
  for (const [d, details, kzt] of [
    [12, "MOBILE OPERATOR KZ", 2_990],
    [18, "ONLINE MUSIC SUBSCRIPTION", 1_990],
  ] as const) {
    const day = iso(y, m, d);
    if (inPeriod(day)) kaspi.push({ day, kzt: -kzt * 100, op: "Зат сатып алу", details });
  }
  for (let k = 0; k < between(2, 4); k++) {
    const day = iso(y, m, between(1, 28));
    if (!inPeriod(day) || atHome(day)) continue;
    const [details, lo, hi] = pick([
      ["VALUE MART 0412 BUDAPEST", 2_500, 9_000],
      ["NOODLE BAR IN BUDAPEST", 2_400, 4_200],
      ["CINEMA IN BUDAPEST", 2_900, 4_000],
      ["PIZZA SHOP IN BUDAPEST HU", 3_500, 6_500],
      ["BOOKSHOP IN BUDAPEST", 3_000, 8_000],
    ] as const);
    buyAbroad(day, details, Math.round(between(lo, hi) / 10) * 10);
  }
}
// Exchange-rate differences the bank posts after a purchase abroad settles.
for (const [day, details, kzt] of [
  ["2025-11-04", "CINEMA IN BUDAPEST, Бағамдық айырма", 4_812],
  ["2026-03-10", "VALUE MART 0412 BUDAPEST, Бағамдық айырма", 7_655],
  ["2026-10-02", "NOODLE BAR IN BUDAPEST, Бағамдық айырма", 5_651],
] as const)
  kaspi.push({ day, kzt: -kzt, op: "Зат сатып алу", details });
for (let d = 2; d <= 27; d += between(2, 4)) {
  for (const [y, m] of [
    [2026, 7],
    [2026, 8],
  ] as const) {
    const day = iso(y, m, d);
    if (!atHome(day)) continue;
    const [details, lo, hi] = pick([
      ["GROCERY STORE ALMATY", 4_000, 18_000],
      ["CITY TAXI ALMATY", 1_200, 3_500],
      ["COFFEE SHOP ALMATY", 1_500, 3_200],
      ["BOOKSHOP ALMATY", 3_000, 9_000],
    ] as const);
    kaspi.push({ day, kzt: -Math.round(between(lo, hi) / 10) * 1000, op: "Зат сатып алу", details });
  }
}
kaspi.push({ day: "2026-06-20", kzt: -186_450 * 100, op: "Зат сатып алу", details: "AIR TICKETS ONLINE" });
kaspi.push({ day: "2025-11-14", kzt: -8_500 * 100, op: "Аударым", details: "Айгерім Т." });
kaspi.push({ day: "2026-04-02", kzt: -12_000 * 100, op: "Аударым", details: "Айгерім Т." });

function kaspiCsv(): string {
  const money = (minor: number, symbol: string) => `${minor < 0 ? "-" : "+"} ${grouped(minor)} ${symbol}`;
  const date = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(2, 4)}`;
  const rows = [...kaspi].sort((a, b) => b.day.localeCompare(a.day));
  const lines = [
    "«Kaspi Bank» АҚ;Kaspi Gold бойынша үзінді көшірме",
    "Сейтқали Дана Нұрланқызы, ЖСН 000000000000, KZ00722C000000000000 шоты бар клиент екенін растайды",
    `${date(FROM)}ж. бастап ${date(TO)}ж. дейінгі кезеңге`,
    "Карта нөмірі:;*4821",
    "Шот нөмірі:;KZ00722C000000000000",
    "Шот валютасы:;теңге",
    "",
    "Күні;Сомасы;Операция;Толығырақ",
    ...rows.map((x) => {
      const amount = x.shop ? `${money(x.kzt, "₸")} (${money(x.shop.minor, x.shop.currency)})` : money(x.kzt, "₸");
      return [date(x.day), amount, x.op, x.details].join(";");
    }),
  ];
  // UTF-8 with a BOM, so Excel shows the Kazakh letters.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---------- Hungarian bank (HUF) ----------

interface HuRow {
  day: string;
  type: string;
  partner: string;
  note: string;
  huf: number;
}
const hu: HuRow[] = [];
const huBuy = (day: string, partner: string, huf: number) => hu.push({ day, type: "Kártyás vásárlás", partner, note: "", huf: -huf });

// The KZT and USD accounts top this one up (the receiving bank's rates).
for (const [day, kzt] of ownToHu) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  hu.push({ day: d.toISOString().slice(0, 10), type: "Bejövő átutalás", partner: "SEITKALI DANA", note: `Saját átutalás, eredeti összeg ${grouped(kzt * 100)} KZT`, huf: Math.round(kzt / 1.6) });
}
const fromUsd = new Map<string, number>();
for (const [y, m] of MONTHS) {
  const day = iso(y, m, 4);
  if (!inPeriod(day)) continue;
  fromUsd.set(iso(y, m, 3), 380);
  hu.push({ day, type: "Bejövő átutalás", partner: "SEITKALI DANA", note: "Saját átutalás, eredeti összeg 380.00 USD", huf: Math.round(380 * 334.2) });
}
// Her father once sends to this account directly: KZT converted on the way.
hu.push({ day: "2026-01-20", type: "Bejövő átutalás", partner: "NURLAN SEITKALI", note: "Nemzetközi átutalás, eredeti összeg 150 000,00 KZT, árfolyam 0,6250", huf: 93_750 });

for (const [y, m] of MONTHS) {
  const at = (d: number) => iso(y, m, d);
  if (inPeriod(at(1))) hu.push({ day: at(1), type: "Átutalás", partner: "Landlord in Budapest", note: `Lakbér ${y}.${pad(m)}.`, huf: -180_000 });
  if (inPeriod(at(10))) hu.push({ day: at(10), type: "Csoportos beszedés", partner: "MOBILE OPERATOR IN HUNGARY", note: "Havi díj", huf: -4_990 });
  if (inPeriod(at(28))) hu.push({ day: at(28), type: "Számlavezetési díj", partner: "", note: `${y}.${pad(m)}.`, huf: -990 });
  if (inPeriod(at(2)) && !atHome(at(2))) huBuy(at(2), "CITY TRANSIT BUDAPEST", 3_450);
  for (let d = 1; d <= 28; d += between(1, 3)) {
    const day = at(d);
    if (!inPeriod(day) || atHome(day)) continue;
    const [partner, lo, hi] = pick([
      ["VALUE MART 0412 BUDAPEST", 2_000, 11_000],
      ["GROCERY STORE IN BUDAPEST HU", 1_500, 8_000],
      ["MARKET HALL IN BUDAPEST", 2_500, 7_000],
      ["MORNING BAKERY", 600, 1_800],
      ["CANTEEN IN BUDAPEST", 1_500, 2_400],
      ["COFFEE SHOP IN BUDAPEST", 900, 2_200],
    ] as const);
    huBuy(day, partner, Math.round(between(lo, hi) / 10) * 10);
  }
  const pharmacy = at(between(5, 25));
  if (inPeriod(pharmacy) && !atHome(pharmacy) && r() < 0.4) huBuy(pharmacy, "GREEN CROSS PHARMACY BP", Math.round(between(1_200, 6_000) / 10) * 10);
}

function huCsv(): string {
  const date = (day: string) => `${day.replaceAll("-", ".")}.`;
  const rows = [...hu].sort((a, b) => a.day.localeCompare(b.day) || b.huf - a.huf);
  const lines = [
    "Example Bank Hungary Zrt.;Számlatörténet / Account history",
    "Számlatulajdonos / Account holder:;SEITKALI DANA",
    "Számlaszám / Account number:;HU00 0000 0000 0000 0000 0000 0000",
    "Számla devizaneme / Account currency:;HUF",
    `Időszak / Period:;${date(FROM)} – ${date(TO)}`,
    "",
    "Könyvelés dátuma;Tranzakció típusa;Partner neve;Közlemény;Összeg;Pénznem",
    ...rows.map((x) => [date(x.day), x.type, x.partner, x.note, String(x.huf), "HUF"].join(";")),
  ];
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---------- USD account (OFX) ----------

interface UsdRow {
  day: string;
  cents: number;
  name: string;
  type: "CREDIT" | "DEBIT" | "XFER" | "SRVCHG";
}
const usd: UsdRow[] = [];
for (const [y, m] of MONTHS) {
  const at = (d: number) => iso(y, m, d);
  if (inPeriod(at(1))) usd.push({ day: at(1), cents: 40_000, name: "EXAMPLE SCHOLARSHIP FUND STIPEND", type: "CREDIT" });
  if (fromUsd.has(at(3))) {
    usd.push({ day: at(3), cents: -38_000, name: "TRANSFER TO OWN ACCOUNT HU", type: "XFER" });
    usd.push({ day: at(3), cents: -500, name: "INTERNATIONAL WIRE FEE", type: "SRVCHG" });
  }
  if (inPeriod(at(22))) usd.push({ day: at(22), cents: -499, name: "CLOUD NOTES APP", type: "DEBIT" });
}
usd.push({ day: "2026-02-11", cents: -2_900, name: "ONLINE COURSE PLATFORM", type: "DEBIT" });
usd.push({ day: "2026-09-08", cents: -1_850, name: "ONLINE BOOKSTORE", type: "DEBIT" });

function ofx(): string {
  const stamp = (day: string) => `${day.replaceAll("-", "")}120000.000[0:GMT]`;
  const rows = [...usd].sort((a, b) => a.day.localeCompare(b.day));
  const balance = rows.reduce((a, x) => a + x.cents, 25_000);
  const tx = rows.map(
    (x, i) => `<STMTTRN>
<TRNTYPE>${x.type}
<DTPOSTED>${stamp(x.day)}
<TRNAMT>${(x.cents / 100).toFixed(2)}
<FITID>${x.day.replaceAll("-", "")}${pad(i % 100)}
<NAME>${x.name}
</STMTTRN>`,
  );
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>${stamp(TO)}
<LANGUAGE>ENG
<FI>
<ORG>EXAMPLE BANK
<FID>00000
</FI>
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>000000000
<ACCTID>0000000000
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>${stamp(FROM)}
<DTEND>${stamp(TO)}
${tx.join("\n")}
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>${(balance / 100).toFixed(2)}
<DTASOF>${stamp(TO)}
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`.replace(/\n/g, "\r\n");
}

/** The three files as written (the import tests check the committed files still match). */
export function sampleStatements(): { name: string; text: string }[] {
  return [
    { name: "kaspi-gold-kzt.csv", text: kaspiCsv() },
    { name: "hu-bank-huf.csv", text: huCsv() },
    { name: "usd-account.ofx", text: ofx() },
  ];
}

if (import.meta.main) {
  for (const f of sampleStatements()) writeFileSync(join(OUT, f.name), f.text);
  console.log(`wrote kaspi-gold-kzt.csv (${kaspi.length} rows), hu-bank-huf.csv (${hu.length} rows), usd-account.ofx (${usd.length} rows) to ${OUT}`);
}
