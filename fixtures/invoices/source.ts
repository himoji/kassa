/*
 * Source data for the 30 labelled invoices (spec §18, §19 `eval:invoices`). The PDFs and
 * labels.json are generated from this file by apps/mock-world (`bun run fixtures:invoices`);
 * apps/mock-world/test/invoices.test.ts checks the committed PDFs are byte-identical to a fresh
 * render and that every label is present in the extracted PDF text.
 *
 * All issuers, people and accounts are fictitious. Layouts, languages, number and date formats
 * vary on purpose (that is what the Reader accuracy eval measures). Some invoices carry
 * distractors: VAT lines, partial payments, an issuer that differs from the account holder,
 * and two invoices with no payment reference (label `reference: null`).
 */
import { buildRfReference } from "@kassa/shared";

import { ACCOUNTS, TUITION_REFERENCE } from "../seed-data.ts";
import { atIban, deIban, esIban, frIban, huIban, kzIban, nlIban } from "./bban.ts";

export type InvoiceLayout = "classic" | "modern" | "letter" | "slip" | "statement" | "receipt" | "de" | "hu" | "fr";
export type InvoiceLanguage = "en" | "de" | "hu" | "fr";
/** How the amount due is printed (see apps/mock-world/src/pdf/format.ts). */
export type AmountStyle =
  | "en-code"
  | "en-symbol"
  | "de-code"
  | "de-symbol"
  | "at-symbol"
  | "hu-ft"
  | "hu-code"
  | "fr-symbol"
  | "kz-code";
export type DateStyle = "iso" | "long-en" | "us-long" | "dmy-dot" | "dmy-slash" | "hu" | "hu-long" | "de-long" | "fr-long";
export type IbanStyle = "paper" | "electronic";
export type FontFamily = "helvetica" | "times" | "courier";

export interface InvoiceParty {
  name: string;
  addressLines: string[];
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface InvoiceSpec {
  id: string;
  layout: InvoiceLayout;
  language: InvoiceLanguage;
  font: FontFamily;
  issuer: InvoiceParty & { vatId?: string; email?: string; phone?: string };
  billTo: InvoiceParty;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  lines: InvoiceLine[];
  /** VAT in basis points applied to the net total (e.g. 2700 = 27 %). Omitted = VAT exempt. */
  vatBps?: number;
  /** Already paid (distractor): amount due = gross − alreadyPaidMinor. */
  alreadyPaidMinor?: number;
  payment: {
    /** Account holder / beneficiary. This is the label `payeeName`. */
    payeeName: string;
    iban: string;
    bic?: string;
    reference: string | null;
    ibanStyle: IbanStyle;
  };
  amountStyle: AmountStyle;
  dateStyle: DateStyle;
}

const DANA: InvoiceParty = { name: "Dana Seitkali", addressLines: ["Kerepesi ut 12, 4B", "1087 Budapest", "Hungary"] };
const DANA_KZ: InvoiceParty = { name: "Dana Seitkali", addressLines: ["Abay ave 50, apt 21", "050000 Almaty", "Kazakhstan"] };

const RIVERSIDE = {
  name: "University in Budapest",
  addressLines: ["Bursar's Office", "Folyopart utca 1", "1111 Budapest", "Hungary"],
  vatId: "HU99000001",
  email: "bursar@university-in-budapest.example",
};
const HILLSIDE = { name: "Landlord in Budapest", addressLines: ["Hegyoldal utca 7", "1122 Budapest", "Hungary"], vatId: "HU99000002" };
const MERIDIAN = {
  name: "Student Insurer in EU",
  addressLines: ["Insurer Tower, Vaci ut 99", "1138 Budapest", "Hungary"],
  vatId: "HU99000003",
  phone: "+36 1 555 0103",
};
const DANUBE_UTIL = { name: "Utility Company in Budapest", addressLines: ["Ipar utca 20", "1095 Budapest", "Hungary"], vatId: "HU99000004" };
const ALMATY_HOUSING = { name: "Almaty Student Housing LLP", addressLines: ["Satpaev st 90", "050040 Almaty", "Kazakhstan"] };

const IBAN = {
  lakeside: huIban("117", "0050", "330918820000000"),
  northgate: huIban("109", "1205", "440017730000000"),
  mobilenet: huIban("104", "0112", "550921160000000"),
  danubeUtil: huIban("120", "0300", "660314480000000"),
  campusPrint: huIban("116", "0071", "771026390000000"),
  cityGym: huIban("108", "0044", "880412950000000"),
  studentUnion: huIban("118", "0101", "990527640000000"),
  greenLine: huIban("107", "0090", "102938470000000"),
  berlinBootcamp: deIban("10010010", "4820193746"),
  sprachkurs: deIban("37010050", "2091837465"),
  hamburgExam: deIban("20010020", "6619283740"),
  munichVisa: deIban("70010080", "3355172904"),
  dataSkills: deIban("50010060", "9182736450"),
  ecsNl: nlIban("ABNA", "0417164300"),
  amsterdamPress: nlIban("INGB", "0006723941"),
  viennaAcademy: atIban("19043", "00234573201"),
  frenchSchool: frIban("30004", "00820", "00010477581"),
  lyonResidences: frIban("30002", "00550", "00001579123"),
  madridCourses: esIban("2100", "0418", "4502000513"),
  almatyHousing: kzIban("722", "S000098765432"),
  astanaAlumni: kzIban("601", "A000044332211"),
};

export const INVOICE_SPECS: InvoiceSpec[] = [
  {
    id: "inv-01", layout: "classic", language: "en", font: "helvetica",
    issuer: RIVERSIDE, billTo: DANA, invoiceNumber: "RUB-2026-F-04217", issueDate: "2026-10-01", dueDate: "2026-10-31", currency: "EUR",
    lines: [{ description: "Tuition fee, MSc Finance, autumn semester 2026", quantity: 1, unitPriceMinor: 240000 }],
    payment: { payeeName: "University in Budapest", iban: ACCOUNTS.university, bic: "RVUBHUHBXXX", reference: TUITION_REFERENCE, ibanStyle: "paper" },
    amountStyle: "en-code", dateStyle: "long-en",
  },
  {
    id: "inv-02", layout: "hu", language: "hu", font: "helvetica",
    issuer: HILLSIDE, billTo: DANA, invoiceNumber: "HF-2026/0311", issueDate: "2026-10-20", dueDate: "2026-11-01", currency: "HUF",
    lines: [{ description: "Lakbér, 4B lakás, 2026. november", quantity: 1, unitPriceMinor: 18000000 }],
    payment: { payeeName: "Landlord in Budapest", iban: ACCOUNTS.landlord, reference: "HF-APT4B-RENT", ibanStyle: "paper" },
    amountStyle: "hu-ft", dateStyle: "hu",
  },
  {
    id: "inv-03", layout: "modern", language: "en", font: "helvetica",
    issuer: MERIDIAN, billTo: DANA, invoiceNumber: "MSI-Q4-778201", issueDate: "2026-10-15", dueDate: "2026-11-15", currency: "EUR",
    lines: [{ description: "Student health insurance, Q4 2026 premium", quantity: 1, unitPriceMinor: 9600 }],
    payment: { payeeName: "Student Insurer in EU", iban: ACCOUNTS.insurer, bic: "MSINHUHBXXX", reference: "POL-778201-Q4", ibanStyle: "paper" },
    amountStyle: "en-symbol", dateStyle: "dmy-slash",
  },
  {
    id: "inv-04", layout: "de", language: "de", font: "helvetica",
    issuer: { name: "Data Bootcamp in Berlin", addressLines: ["Torstrasse 140", "10119 Berlin", "Deutschland"], vatId: "DE999000004" },
    billTo: DANA, invoiceNumber: "BDS-2026-0193", issueDate: "2026-10-30", dueDate: "2026-11-30", currency: "EUR",
    lines: [{ description: "Online-Bootcamp Data Science, Modul 1-4", quantity: 1, unitPriceMinor: 125000 }],
    vatBps: 1900,
    payment: { payeeName: "Data Bootcamp in Berlin", iban: IBAN.berlinBootcamp, bic: "BDSBDEBBXXX", reference: "BDS-2026-0193", ibanStyle: "paper" },
    amountStyle: "de-code", dateStyle: "dmy-dot",
  },
  {
    id: "inv-05", layout: "letter", language: "en", font: "times",
    issuer: { name: "Language School in Budapest", addressLines: ["Tavpart utca 3", "1117 Budapest", "Hungary"], email: "office@language-school-in-budapest.example" },
    billTo: DANA, invoiceNumber: "LLS/2026/311", issueDate: "2026-10-22", dueDate: "2026-11-20", currency: "HUF",
    lines: [{ description: "Hungarian for beginners, evening course (10 weeks)", quantity: 1, unitPriceMinor: 14500000 }],
    payment: { payeeName: "Language School in Budapest", iban: IBAN.lakeside, reference: "LLS/2026/311", ibanStyle: "electronic" },
    amountStyle: "en-code", dateStyle: "iso",
  },
  {
    id: "inv-06", layout: "statement", language: "en", font: "helvetica",
    issuer: { name: "Dormitory Office in Budapest", addressLines: ["Eszaki kapu 5", "1134 Budapest", "Hungary"], vatId: "HU99000006" },
    billTo: DANA, invoiceNumber: "NDS-ST-2026-11", issueDate: "2026-10-25", dueDate: "2026-11-05", currency: "HUF",
    lines: [
      { description: "Room deposit (refundable)", quantity: 1, unitPriceMinor: 12000000 },
      { description: "Short-stay room, 2 weeks", quantity: 2, unitPriceMinor: 6000000 },
    ],
    alreadyPaidMinor: 12000000,
    payment: { payeeName: "Dormitory Office in Budapest", iban: IBAN.northgate, reference: "NDS-STU-5521", ibanStyle: "paper" },
    amountStyle: "en-code", dateStyle: "long-en",
  },
  {
    id: "inv-07", layout: "fr", language: "fr", font: "times",
    issuer: { name: "Atelier Langues Paris SARL", addressLines: ["12 rue des Ecoles", "75005 Paris", "France"], vatId: "FR99000000007" },
    billTo: DANA, invoiceNumber: "ALP-26-0457", issueDate: "2026-11-15", dueDate: "2026-12-15", currency: "EUR",
    lines: [{ description: "Stage intensif de français (en ligne)", quantity: 1, unitPriceMinor: 38000 }],
    payment: { payeeName: "Atelier Langues Paris SARL", iban: IBAN.frenchSchool, bic: "ALPAFRPPXXX", reference: "ALP-26-0457", ibanStyle: "paper" },
    amountStyle: "fr-symbol", dateStyle: "fr-long",
  },
  {
    id: "inv-08", layout: "receipt", language: "en", font: "courier",
    issuer: { name: "Mobile Operator in Hungary", addressLines: ["Telekom ter 1", "1097 Budapest"], vatId: "HU99000008" },
    billTo: DANA, invoiceNumber: "MN-302918844", issueDate: "2026-10-27", dueDate: "2026-11-10", currency: "HUF",
    lines: [{ description: "Student plan, November 2026", quantity: 1, unitPriceMinor: 392913 }],
    vatBps: 2700,
    payment: { payeeName: "Mobile Operator in Hungary", iban: IBAN.mobilenet, reference: "MN-302918844", ibanStyle: "electronic" },
    amountStyle: "hu-code", dateStyle: "iso",
  },
  {
    id: "inv-09", layout: "classic", language: "en", font: "helvetica",
    issuer: { name: "Euro Conference Services BV", addressLines: ["Keizersgracht 300", "1016 EZ Amsterdam", "Netherlands"], vatId: "NL999000009B01" },
    billTo: DANA, invoiceNumber: "ECS-2026-88412", issueDate: "2026-10-28", dueDate: "2026-11-30", currency: "USD",
    lines: [{ description: "Student registration, FinTech Futures Conference 2026", quantity: 1, unitPriceMinor: 15000 }],
    payment: { payeeName: "Euro Conference Services BV", iban: IBAN.ecsNl, bic: "ECSBNL2AXXX", reference: "ECS-REG-88412", ibanStyle: "paper" },
    amountStyle: "en-code", dateStyle: "us-long",
  },
  {
    id: "inv-10", layout: "classic", language: "en", font: "times",
    issuer: ALMATY_HOUSING, billTo: DANA_KZ, invoiceNumber: "ASH-2026-1107", issueDate: "2026-10-20", dueDate: "2026-11-07", currency: "KZT",
    lines: [{ description: "Storage of belongings, November 2026", quantity: 1, unitPriceMinor: 8500000 }],
    payment: { payeeName: "Almaty Student Housing LLP", iban: IBAN.almatyHousing, reference: "ASH-2026-1107", ibanStyle: "paper" },
    amountStyle: "kz-code", dateStyle: "dmy-dot",
  },
  {
    id: "inv-11", layout: "modern", language: "en", font: "helvetica",
    issuer: { name: "Summer Academy in Austria", addressLines: ["Ringstrasse 10", "1010 Wien", "Austria"], vatId: "ATU99000011" },
    billTo: DANA, invoiceNumber: "VSA-2027-S-0042", issueDate: "2026-11-02", dueDate: "2027-01-15", currency: "EUR",
    lines: [
      { description: "Summer school 2027, early-bird tuition", quantity: 1, unitPriceMinor: 59000 },
      { description: "Registration fee", quantity: 1, unitPriceMinor: 5000 },
    ],
    payment: { payeeName: "Summer Academy in Austria", iban: IBAN.viennaAcademy, bic: "VSAGATWWXXX", reference: "VSA-2027-S-0042", ibanStyle: "paper" },
    amountStyle: "at-symbol", dateStyle: "iso",
  },
  {
    id: "inv-12", layout: "hu", language: "hu", font: "helvetica",
    issuer: DANUBE_UTIL, billTo: DANA, invoiceNumber: "DU-2026-10-88127", issueDate: "2026-10-28", dueDate: "2026-11-12", currency: "HUF",
    lines: [
      { description: "Villamos energia, 2026. október", quantity: 1, unitPriceMinor: 1101575 },
      { description: "Víz és csatorna, 2026. október", quantity: 1, unitPriceMinor: 351181 },
    ],
    vatBps: 2700,
    payment: { payeeName: "Utility Company in Budapest", iban: IBAN.danubeUtil, reference: "DU-0098812734", ibanStyle: "paper" },
    amountStyle: "hu-ft", dateStyle: "hu-long",
  },
  {
    id: "inv-13", layout: "de", language: "de", font: "times",
    issuer: { name: "Online Language Course from Germany", addressLines: ["Marktplatz 4", "04109 Leipzig", "Deutschland"], vatId: "DE999000013" },
    billTo: DANA, invoiceNumber: "SKO-261101", issueDate: "2026-11-01", dueDate: "2026-12-01", currency: "EUR",
    lines: [{ description: "Deutschkurs A2, Online-Zugang 3 Monate", quantity: 1, unitPriceMinor: 8900 }],
    vatBps: 1900,
    payment: { payeeName: "Online Language Course from Germany", iban: IBAN.sprachkurs, bic: "SKOLDE8LXXX", reference: null, ibanStyle: "paper" },
    amountStyle: "de-symbol", dateStyle: "de-long",
  },
  {
    id: "inv-14", layout: "statement", language: "en", font: "courier",
    issuer: { name: "Print Shop in Budapest", addressLines: ["Egyetem ter 2", "1053 Budapest", "Hungary"], vatId: "HU99000014" },
    billTo: DANA, invoiceNumber: "CPS-11-0234", issueDate: "2026-11-01", dueDate: "2026-11-08", currency: "HUF",
    lines: [
      { description: "Thesis binding, hardcover", quantity: 2, unitPriceMinor: 180000 },
      { description: "Colour print A4", quantity: 120, unitPriceMinor: 5000 },
      { description: "Poster print A1", quantity: 1, unitPriceMinor: 230000 },
    ],
    payment: { payeeName: "Print Shop in Budapest", iban: IBAN.campusPrint, reference: "CPS-11-0234", ibanStyle: "electronic" },
    amountStyle: "en-code", dateStyle: "iso",
  },
  {
    id: "inv-15", layout: "letter", language: "en", font: "times",
    issuer: RIVERSIDE, billTo: DANA, invoiceNumber: "LIB-2026-77120", issueDate: "2026-10-30", dueDate: "2026-11-20", currency: "EUR",
    lines: [{ description: "Library: overdue and damaged item replacement", quantity: 1, unitPriceMinor: 2500 }],
    payment: { payeeName: "University in Budapest", iban: ACCOUNTS.university, bic: "RVUBHUHBXXX", reference: "LIB-FINE-77120", ibanStyle: "paper" },
    amountStyle: "en-symbol", dateStyle: "us-long",
  },
  {
    id: "inv-16", layout: "classic", language: "en", font: "helvetica",
    issuer: { name: "Gym in Budapest", addressLines: ["Sport utca 8", "1146 Budapest", "Hungary"], vatId: "HU99000016" },
    billTo: DANA, invoiceNumber: "CG-2026-11-0457", issueDate: "2026-10-27", dueDate: "2026-11-03", currency: "HUF",
    lines: [{ description: "Student membership, November 2026", quantity: 1, unitPriceMinor: 1015748 }],
    vatBps: 2700,
    payment: { payeeName: "Gym in Budapest", iban: IBAN.cityGym, reference: "GYM-DANA-2026-11", ibanStyle: "paper" },
    amountStyle: "hu-ft", dateStyle: "iso",
  },
  {
    id: "inv-17", layout: "slip", language: "en", font: "helvetica",
    issuer: { name: "Madrid Spanish Courses SL", addressLines: ["Calle Mayor 21", "28013 Madrid", "Spain"], vatId: "ESB99000017" },
    billTo: DANA, invoiceNumber: "MSC/2026/1188", issueDate: "2026-11-10", dueDate: "2026-12-10", currency: "EUR",
    lines: [{ description: "Spanish B1 online course, December", quantity: 1, unitPriceMinor: 21000 }],
    payment: { payeeName: "Madrid Spanish Courses SL", iban: IBAN.madridCourses, bic: "MSCSESMMXXX", reference: "MSC/2026/1188", ibanStyle: "paper" },
    amountStyle: "de-symbol", dateStyle: "dmy-slash",
  },
  {
    id: "inv-18", layout: "receipt", language: "en", font: "courier",
    issuer: { name: "Student Union Budapest", addressLines: ["Egyetem ter 1", "1053 Budapest"] },
    billTo: DANA, invoiceNumber: "SUB-M-2026-1730", issueDate: "2026-10-27", dueDate: "2026-11-30", currency: "HUF",
    lines: [{ description: "Annual membership 2026/27", quantity: 1, unitPriceMinor: 500000 }],
    payment: { payeeName: "Student Union Budapest", iban: IBAN.studentUnion, reference: null, ibanStyle: "paper" },
    amountStyle: "hu-ft", dateStyle: "hu",
  },
  {
    id: "inv-19", layout: "modern", language: "en", font: "helvetica",
    issuer: MERIDIAN, billTo: DANA, invoiceNumber: "MSI-2027-778201", issueDate: "2026-11-15", dueDate: "2027-01-15", currency: "EUR",
    lines: [{ description: "Student health insurance, annual premium 2027", quantity: 1, unitPriceMinor: 38400 }],
    payment: { payeeName: "Student Insurer in EU", iban: ACCOUNTS.insurer, bic: "MSINHUHBXXX", reference: "POL-778201-2027", ibanStyle: "paper" },
    amountStyle: "en-code", dateStyle: "long-en",
  },
  {
    id: "inv-20", layout: "hu", language: "hu", font: "times",
    issuer: HILLSIDE, billTo: DANA, invoiceNumber: "HF-2026/0347", issueDate: "2026-11-20", dueDate: "2026-12-01", currency: "HUF",
    lines: [{ description: "Lakbér, 4B lakás, 2026. december", quantity: 1, unitPriceMinor: 18000000 }],
    payment: { payeeName: "Landlord in Budapest", iban: ACCOUNTS.landlord, reference: "HF-APT4B-RENT", ibanStyle: "electronic" },
    amountStyle: "hu-code", dateStyle: "hu-long",
  },
  {
    id: "inv-21", layout: "de", language: "de", font: "helvetica",
    issuer: { name: "Exam Center in Germany", addressLines: ["Jungfernstieg 30", "20354 Hamburg", "Deutschland"], vatId: "DE999000021" },
    billTo: DANA, invoiceNumber: "HEC-26-551", issueDate: "2026-10-26", dueDate: "2026-11-15", currency: "EUR",
    lines: [{ description: "Prüfungsgebühr Sprachzertifikat C1 (steuerfrei)", quantity: 1, unitPriceMinor: 17500 }],
    payment: { payeeName: "Exam Center in Germany", iban: IBAN.hamburgExam, bic: "HECGDEHHXXX", reference: "HEC-PRF-26-551", ibanStyle: "paper" },
    amountStyle: "de-code", dateStyle: "dmy-dot",
  },
  {
    id: "inv-22", layout: "statement", language: "en", font: "times",
    issuer: ALMATY_HOUSING, billTo: DANA_KZ, invoiceNumber: "ASH-2026-1207", issueDate: "2026-11-20", dueDate: "2026-12-07", currency: "KZT",
    lines: [{ description: "Storage of belongings, November-December 2026", quantity: 2, unitPriceMinor: 8500000 }],
    alreadyPaidMinor: 8500000,
    payment: { payeeName: "Almaty Student Housing LLP", iban: IBAN.almatyHousing, reference: "ASH-2026-1207", ibanStyle: "paper" },
    amountStyle: "kz-code", dateStyle: "dmy-dot",
  },
  {
    id: "inv-23", layout: "classic", language: "en", font: "times",
    issuer: { name: "Amsterdam Academic Press BV", addressLines: ["Herengracht 101", "1015 BE Amsterdam", "Netherlands"], vatId: "NL999000023B01" },
    billTo: DANA, invoiceNumber: "AAP-INV-20261102", issueDate: "2026-11-02", dueDate: "2026-12-02", currency: "EUR",
    lines: [{ description: "Course reader: Quantitative Finance (print + e-book)", quantity: 1, unitPriceMinor: 5990 }],
    payment: { payeeName: "Amsterdam Academic Press BV", iban: IBAN.amsterdamPress, bic: "AAPRNL2AXXX", reference: "AAP-INV-20261102", ibanStyle: "electronic" },
    amountStyle: "en-symbol", dateStyle: "iso",
  },
  {
    id: "inv-24", layout: "letter", language: "en", font: "helvetica",
    issuer: { name: "Astana Alumni Association", addressLines: ["Mangilik El ave 55", "010000 Astana", "Kazakhstan"] },
    billTo: DANA_KZ, invoiceNumber: "AAA-2027-0016", issueDate: "2026-11-05", dueDate: "2027-01-31", currency: "KZT",
    lines: [{ description: "Alumni membership fee 2027", quantity: 1, unitPriceMinor: 1500000 }],
    payment: { payeeName: "Astana Alumni Association", iban: IBAN.astanaAlumni, reference: "AAA-FEE-2027", ibanStyle: "paper" },
    amountStyle: "kz-code", dateStyle: "long-en",
  },
  {
    id: "inv-25", layout: "slip", language: "hu", font: "helvetica",
    issuer: DANUBE_UTIL, billTo: DANA, invoiceNumber: "DU-2026-11-91544", issueDate: "2026-11-28", dueDate: "2026-12-12", currency: "HUF",
    lines: [{ description: "Villamos energia és víz, 2026. november", quantity: 1, unitPriceMinor: 1700000 }],
    vatBps: 2700,
    payment: { payeeName: "Utility Company in Budapest", iban: IBAN.danubeUtil, reference: "DU-0098815520", ibanStyle: "paper" },
    amountStyle: "hu-ft", dateStyle: "hu",
  },
  {
    id: "inv-26", layout: "receipt", language: "en", font: "courier",
    issuer: { name: "Coach Company from EU", addressLines: ["Nepliget busz terminal", "1101 Budapest"], vatId: "HU99000026" },
    billTo: DANA, invoiceNumber: "GLC-7781", issueDate: "2026-10-27", dueDate: "2026-11-02", currency: "HUF",
    lines: [{ description: "Coach tickets Budapest-Vienna return, group booking", quantity: 2, unitPriceMinor: 490000 }],
    payment: { payeeName: "Coach Company from EU", iban: IBAN.greenLine, reference: "GLC-7781-HU", ibanStyle: "electronic" },
    amountStyle: "en-code", dateStyle: "dmy-dot",
  },
  {
    id: "inv-27", layout: "modern", language: "en", font: "helvetica",
    issuer: { name: "Data Skills Academy from EU", addressLines: ["Kaiserstrasse 12", "60311 Frankfurt am Main", "Germany"], vatId: "DE999000027" },
    billTo: DANA, invoiceNumber: "DSA-US-55102", issueDate: "2026-10-25", dueDate: "2026-11-25", currency: "USD",
    lines: [{ description: "Certificate exam voucher: Python for Finance", quantity: 1, unitPriceMinor: 4900 }],
    payment: { payeeName: "Data Skills Academy from EU", iban: IBAN.dataSkills, bic: "DSAGDEFFXXX", reference: "DSA-US-55102", ibanStyle: "paper" },
    amountStyle: "en-symbol", dateStyle: "long-en",
  },
  {
    id: "inv-28", layout: "fr", language: "fr", font: "helvetica",
    issuer: { name: "Lyon Student Residences SAS", addressLines: ["8 quai Victor Augagneur", "69003 Lyon", "France"], vatId: "FR99000000028" },
    billTo: DANA, invoiceNumber: "LSR-2026-12-B14", issueDate: "2026-11-15", dueDate: "2026-12-01", currency: "EUR",
    lines: [{ description: "Réservation chambre B14, semestre d'échange (acompte)", quantity: 1, unitPriceMinor: 52000 }],
    payment: { payeeName: "Lyon Student Residences SAS", iban: IBAN.lyonResidences, bic: "LSRSFRPPXXX", reference: "LSR-2026-12-B14", ibanStyle: "paper" },
    amountStyle: "fr-symbol", dateStyle: "fr-long",
  },
  {
    id: "inv-29", layout: "de", language: "de", font: "times",
    issuer: { name: "Visa Service in Germany", addressLines: ["Leopoldstrasse 77", "80802 München", "Deutschland"], vatId: "DE999000029" },
    billTo: DANA, invoiceNumber: "MVS-26-3317", issueDate: "2026-10-17", dueDate: "2026-10-31", currency: "EUR",
    lines: [{ description: "Bearbeitungsgebühr Schengen-Termin", quantity: 1, unitPriceMinor: 6000 }],
    vatBps: 1900,
    // Distractor: the account holder is a payment processor, not the issuer.
    payment: { payeeName: "Payment Agent in EU", iban: IBAN.munichVisa, bic: "MVSPDEMMXXX", reference: "MVS-26-3317", ibanStyle: "paper" },
    amountStyle: "de-code", dateStyle: "dmy-dot",
  },
  {
    id: "inv-30", layout: "classic", language: "en", font: "helvetica",
    issuer: RIVERSIDE, billTo: DANA, invoiceNumber: "RUB-2027-S-04217", issueDate: "2026-12-01", dueDate: "2027-02-15", currency: "EUR",
    lines: [{ description: "Tuition fee, MSc Finance, spring semester 2027", quantity: 1, unitPriceMinor: 240000 }],
    payment: { payeeName: "University in Budapest", iban: ACCOUNTS.university, bic: "RVUBHUHBXXX", reference: buildRfReference("RUB2027S04217"), ibanStyle: "paper" },
    amountStyle: "en-code", dateStyle: "long-en",
  },
];

/** Net, VAT and gross totals plus the amount due, all integer minor units. VAT rounds half up. */
export function invoiceTotals(spec: InvoiceSpec): { netMinor: number; vatMinor: number; grossMinor: number; dueMinor: number } {
  const netMinor = spec.lines.reduce((s, l) => s + l.quantity * l.unitPriceMinor, 0);
  const vatMinor = spec.vatBps ? Math.floor((netMinor * spec.vatBps + 5000) / 10000) : 0;
  const grossMinor = netMinor + vatMinor;
  return { netMinor, vatMinor, grossMinor, dueMinor: grossMinor - (spec.alreadyPaidMinor ?? 0) };
}
