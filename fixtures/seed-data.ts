/*
 * Seed data for the demo user Dana (spec §18) and the second persona Li Wei (D-CN3, `liWei`, listed in
 * `seed.personas`). Pure data: no I/O, deterministic. Track A's apps/api/scripts/seed.ts inserts it;
 * apps/mock-world reads balances and payee accounts from it.
 *
 * Conventions (docs/DECISIONS.md standards-first rule):
 * - Money: integer minor units + ISO 4217 code; exponents from @kassa/shared CURRENCY_EXPONENTS
 *   (HUF = 2 per ISO 4217, so HUF 180,000 = 18_000_000 minor units).
 * - Ids: RFC 9562 UUIDv5, see fixtures/uuid.ts (`seedId(name)`); literal values are asserted
 *   against `seedId` in apps/mock-world/test/fixtures.test.ts.
 * - Timestamps: RFC 3339 UTC. Dates: ISO 8601 `YYYY-MM-DD`.
 * - Accounts: fictitious IBANs (ISO 13616) with valid ISO 7064 MOD 97-10 check digits; HU BBANs
 *   also carry valid Hungarian national check digits. They belong to no real person or company.
 * - Card markups and FX rates are EXAMPLE values (labelled `exampleValues: true`).
 *
 * Story time: every date is relative to SEED_NOW (2026-10-27, a Tuesday). Tuition is due in
 * 4 days and rent in 5, so the demo's "+3 days" clock jump brings rent inside the scheduler's
 * 3-day window (spec §15) and the rent mandate pays it. The API should set the demo clock offset
 * so that Clock.now() == SEED_NOW right after seeding/reset (see PHASE1_COORDINATION.md).
 *
 * Types: shared enums come from @kassa/shared. Row shapes are local (`Seed*`) because the row
 * types live in Track A's Drizzle schema, which fixtures must not import.
 */
import type {
  CardKind,
  IncomeCadence,
  MandateCore,
  MoneyMode,
  NotificationMode,
  PayeeKind,
  PayeeStatus,
  Preset,
  RecipientDetails,
  Recurrence,
  Region,
  TransactionSource,
  TransactionStatus,
} from "@kassa/shared";
import { convertMinor, crossRate, toMinor } from "@kassa/shared";

import fxRates from "./fx-rates.json" with { type: "json" };
import { seedId } from "./uuid.ts";

// ---------- Local row types (mirror spec §6 columns) ----------

export interface SeedUser {
  id: string;
  displayName: string;
  homeCurrency: string;
  region: Region;
  preset: Preset;
  moneyMode: MoneyMode;
  frozenAt: null;
  createdAt: string;
}

export interface SeedIncome {
  source: string;
  currency: string;
  amountMinor: number;
  cadence: IncomeCadence;
  /** Day of month the income arrives (1..28). Not in spec §6; kept for the forecast. */
  dayOfMonth: number;
  nextDate: string;
}

export interface SeedProfile {
  userId: string;
  incomes: SeedIncome[];
  notificationMode: NotificationMode;
  /** Protected reserve (spec §10 rule 5). Shape proposed by Track D; spec §6 only says "JSON". */
  reserveRules: {
    protectObligationCategories: string[];
    minBalances: { currency: string; amountMinor: number }[];
  };
}

export interface SeedBalance {
  currency: string;
  amountMinor: number;
}

export interface SeedCard {
  id: string;
  userId: string;
  label: string;
  last4: string;
  billingCurrency: string;
  kind: CardKind;
}

export interface SeedCardFeeProfile {
  cardId: string;
  fromCurrency: string;
  toCurrency: string;
  medianMarkupBps: number;
  fixedFeeMinor: number;
  samples: number;
  exampleValues: true;
}

export interface SeedPayee {
  id: string;
  userId: string;
  name: string;
  kind: PayeeKind;
  /** Plaintext account; the API encrypts it into accountEnc (AES-GCM) and hashes it. */
  account: string;
  accountScheme: "IBAN" | "MERCHANT_ID";
  /** ISO 9362 BIC (fictitious) where relevant. */
  bic: string | null;
  country: string;
  currency: string;
  status: PayeeStatus;
  verifiedAt: string | null;
  coolingUntil: string | null;
  replacesPayeeId: string | null;
  /** (added 2026-10-15) Recipient details (shared/recipient.ts); the API encrypts them into detailsEnc. */
  details?: RecipientDetails;
}

export interface SeedObligation {
  id: string;
  userId: string;
  payeeId: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  recurrence: Recurrence;
  reference: string | null;
  category: string;
}

export interface SeedBudget {
  id: string;
  userId: string;
  category: string;
  periodStart: string;
  periodEnd: string;
  limitHomeMinor: number;
}

/** Per-payment / day / month caps, small-auto limit and reserve, in home-currency minor units (spec §10). */
export interface SeedCaps {
  perPaymentMinor: number;
  perDayMinor: number;
  perMonthMinor: number;
  smallAutoMinor: number;
  reserveMinor: number;
}

export interface SeedMandate {
  /** The passkey-signed part. The seed has no passkey yet: Dana signs it during onboarding. */
  core: MandateCore;
  label: string;
}

export interface SeedTransaction {
  id: string;
  userId: string;
  source: TransactionSource;
  occurredAt: string;
  merchantRaw: string;
  merchantNorm: string;
  mcc: string | null;
  amountMinor: number;
  currency: string;
  cardId: string | null;
  homeAmountMinor: number;
  /** Decimal string, units of home currency per one unit of `currency` (never a float). */
  rateUsed: string;
  rateDate: string;
  settledAmountMinor: number | null;
  settledCurrency: string | null;
  feeHomeMinor: number | null;
  category: string;
  /** `userId|amountMinor|currency|merchantNorm|floor(occurredAtMs/600000)` (spec §13). */
  dedupeKey: string;
  mergedIntoId: string | null;
  status: TransactionStatus;
}

// ---------- Story constants ----------

export const SEED_NOW = "2026-10-27T09:00:00.000Z";
export const HOME_CURRENCY = "KZT";
/** Mock bank (Wise-shaped) profile id for Dana's capped wallet. Wise profile ids are integers. */
export const MOCK_BANK_PROFILE_ID = 16_000_001;
/** Example FX table used for every seeded conversion (labelled example values). */
export const SEED_FX = { base: fxRates.base, date: fxRates.date, rates: fxRates.rates as Record<string, string> };

export const IDS = {
  user: "c83d27e3-4e03-570f-8fea-87db32399c12", // seedId("user/dana")
  payees: {
    landlord: "8244c30e-61a5-5c07-b556-a9b7706bd087", // seedId("payee/landlord")
    university: "05fc80e2-33ef-5d76-b50b-03068dcf3981", // seedId("payee/university")
    insurer: "aba740a6-4471-5669-9ba6-1d52652e6de9", // seedId("payee/insurer")
    pizzaShop: "68729ddb-6212-5270-8c2d-206e0dedec08", // seedId("payee/pizza-shop")
    dormOffice: "92136838-87b2-5baf-9987-4f0f38b88a94", // seedId("payee/dorm-office-shanghai")
    cnShop: "25b4c0ab-9ce4-5b5d-9209-b8af9fd8444c", // seedId("payee/buy-everything-shop-china")
  },
  cards: {
    kzt: "4a4f244a-a290-5458-bd38-fe445c8a6394", // seedId("card/kzt")
    usd: "d872539c-518d-5528-918d-f4f5d3b15479", // seedId("card/usd")
    local: "1d2bff7d-9ddd-56b4-b24b-ebfbcec0664f", // seedId("card/local")
  },
  obligations: {
    rent: "c60680c9-e9b3-517f-8113-848cb50f5d10", // seedId("obligation/rent")
    tuition: "b6cca9dd-6a1d-5cfb-ae39-4c5270fd7b27", // seedId("obligation/tuition")
    insurance: "c4a83b54-6ce6-566a-9889-5bee5feb18b8", // seedId("obligation/insurance")
    dormFee: "fcbf708c-9301-54d2-8aea-354a15317a6f", // seedId("obligation/dorm-fee")
  },
  mandates: {
    rent: "bdb39274-0fd8-5991-8ca8-a3ff208fc194", // seedId("mandate/rent")
  },
  budgets: {
    groceries: "b00780ee-beaa-585f-9955-f4fde3772a03", // seedId("budget/groceries")
    eatingOut: "6ff5efa4-7220-5b86-a346-376640f12a53", // seedId("budget/eating_out")
    transport: "b41ec436-829e-55af-b87a-764781659f23", // seedId("budget/transport")
  },
} as const;

/** Fictitious accounts. Valid ISO 13616 check digits; used by mock-world invoices, inbox and QR. */
export const ACCOUNTS = {
  landlord: "HU75109183242065038100000003",
  university: "HU83118009905400221700000005",
  insurer: "HU92104051760049812600000008",
  /** A2: the "landlord new IBAN" email asks for this account. */
  landlordAttacker: "HU03162002169011744200000000",
  /** Tuition invoice variant with a swapped beneficiary account. */
  universitySwapped: "DE44500105175407324931",
  supplierA: "HU37120105250113789000000001",
  supplierB: "HU73116008863044126600000000",
  /** A1: account in supplier B's hidden price-list instruction. */
  supplierBHidden: "DE94760300800981124407",
  /** Dana's own home account in Kazakhstan (remittance source). */
  danaHomeKz: "KZ84722C000012345678",
  /** Li Wei's flat: same landlord, billed to the landlord's account for that building (huIban 109/1832). */
  landlordLiWei: "HU47109183242065038100000216",
} as const;

/** ISO 11649 structured creditor reference printed on the tuition invoice. */
export const TUITION_REFERENCE = "RF39RUB2026F04217";

// ---------- Rows ----------

export const user: SeedUser = {
  id: IDS.user,
  displayName: "Dana",
  homeCurrency: HOME_CURRENCY,
  region: "EU",
  preset: "SMART",
  moneyMode: "CAPPED_WALLET",
  frozenAt: null,
  createdAt: "2026-09-20T08:00:00.000Z",
};

export const profile: SeedProfile = {
  userId: IDS.user,
  incomes: [
    { source: "Parents", currency: "KZT", amountMinor: toMinor("600000", "KZT"), cadence: "MONTHLY", dayOfMonth: 25, nextDate: "2026-11-25" },
    { source: "Scholarship", currency: "USD", amountMinor: toMinor("400", "USD"), cadence: "MONTHLY", dayOfMonth: 1, nextDate: "2026-11-01" },
  ],
  notificationMode: "EACH",
  reserveRules: {
    protectObligationCategories: ["rent", "tuition"],
    minBalances: [{ currency: "KZT", amountMinor: toMinor("50000", "KZT") }],
  },
};

/** Capped wallet balances in the mock bank (spec §18). */
export const balances: SeedBalance[] = [
  { currency: "KZT", amountMinor: toMinor("900000", "KZT") },
  { currency: "USD", amountMinor: toMinor("450", "USD") },
  { currency: "HUF", amountMinor: toMinor("120000", "HUF") },
  { currency: "EUR", amountMinor: toMinor("300", "EUR") },
];

export const cards: SeedCard[] = [
  { id: IDS.cards.kzt, userId: IDS.user, label: "Home bank KZT card (example)", last4: "4821", billingCurrency: "KZT", kind: "HOME_KZT" },
  { id: IDS.cards.usd, userId: IDS.user, label: "USD card (example)", last4: "7310", billingCurrency: "USD", kind: "USD" },
  { id: IDS.cards.local, userId: IDS.user, label: "Local HUF/EUR card (example)", last4: "0596", billingCurrency: "HUF", kind: "LOCAL_HUF" },
];

/** EXAMPLE markups (spec §18): KZT card ~400 bps, USD card ~250 bps, local card 0–50 bps. */
const CARD_MARKUP_BPS: Record<string, Record<string, number>> = {
  [IDS.cards.kzt]: { HUF: 400, EUR: 400, USD: 400 },
  [IDS.cards.usd]: { HUF: 250, EUR: 250 },
  [IDS.cards.local]: { HUF: 0, EUR: 50 },
};

export const payees: SeedPayee[] = [
  {
    id: IDS.payees.landlord,
    userId: IDS.user,
    name: "Landlord in Budapest",
    kind: "LANDLORD",
    account: ACCOUNTS.landlord,
    accountScheme: "IBAN",
    bic: "HFLTHUHBXXX",
    country: "HU",
    currency: "HUF",
    status: "VERIFIED",
    verifiedAt: "2026-09-02T10:00:00.000Z",
    coolingUntil: null,
    replacesPayeeId: null,
    details: { category: "RENT", reference: "HF-APT4B-RENT", dueDay: 1 },
  },
  {
    id: IDS.payees.university,
    userId: IDS.user,
    name: "University in Budapest",
    kind: "UNIVERSITY",
    account: ACCOUNTS.university,
    accountScheme: "IBAN",
    bic: "RVUBHUHBXXX",
    country: "HU",
    currency: "EUR",
    status: "VERIFIED",
    verifiedAt: "2026-09-05T09:30:00.000Z",
    coolingUntil: null,
    replacesPayeeId: null,
    details: { category: "TUITION", studentId: "KZ26-0417", term: "Fall 2026" },
  },
  {
    id: IDS.payees.insurer,
    userId: IDS.user,
    name: "Student Insurer in EU",
    kind: "INSURER",
    account: ACCOUNTS.insurer,
    accountScheme: "IBAN",
    bic: "MSINHUHBXXX",
    country: "HU",
    currency: "EUR",
    status: "VERIFIED",
    verifiedAt: "2026-09-05T09:45:00.000Z",
    coolingUntil: null,
    replacesPayeeId: null,
    details: { category: "BILLS", billType: "INSURANCE", customerNumber: "POL-778201" },
  },
  {
    id: IDS.payees.pizzaShop,
    userId: IDS.user,
    name: "Pizza Shop in Budapest",
    kind: "MERCHANT",
    // Card merchants have no IBAN: the "account" is the normalised merchant name that the issuing
    // authorization webhook compares against merchant_data.name (spec §11).
    account: "pizza shop in",
    accountScheme: "MERCHANT_ID",
    bic: null,
    country: "HU",
    currency: "HUF",
    status: "VERIFIED",
    verifiedAt: "2026-09-20T08:00:00.000Z",
    coolingUntil: null,
    replacesPayeeId: null,
  },
  // D-CN1 (Shanghai exchange semester): QR-wallet merchants in mock-world QR_MERCHANTS. Chinese merchants
  // have no IBAN; the handoff check compares the QR payee NAME with this verified name (spec §11).
  {
    id: IDS.payees.dormOffice,
    userId: IDS.user,
    name: "Dorm Office in Shanghai",
    kind: "MERCHANT",
    account: "dorm office in shanghai",
    accountScheme: "MERCHANT_ID",
    bic: null,
    country: "CN",
    currency: "CNY",
    status: "VERIFIED",
    verifiedAt: "2026-10-12T08:00:00.000Z",
    coolingUntil: null,
    replacesPayeeId: null,
  },
  {
    id: IDS.payees.cnShop,
    userId: IDS.user,
    name: "Buy Everything Shop from China",
    kind: "MERCHANT",
    account: "buy everything shop from china",
    accountScheme: "MERCHANT_ID",
    bic: null,
    country: "CN",
    currency: "CNY",
    status: "VERIFIED",
    verifiedAt: "2026-10-12T08:05:00.000Z",
    coolingUntil: null,
    replacesPayeeId: null,
  },
];

export const obligations: SeedObligation[] = [
  {
    id: IDS.obligations.rent,
    userId: IDS.user,
    payeeId: IDS.payees.landlord,
    amountMinor: toMinor("180000", "HUF"),
    currency: "HUF",
    dueDate: "2026-11-01",
    recurrence: "MONTHLY",
    reference: "HF-APT4B-RENT",
    category: "rent",
  },
  {
    id: IDS.obligations.tuition,
    userId: IDS.user,
    payeeId: IDS.payees.university,
    amountMinor: toMinor("2400", "EUR"),
    currency: "EUR",
    dueDate: "2026-10-31",
    recurrence: "TERM",
    reference: TUITION_REFERENCE,
    category: "tuition",
  },
  {
    id: IDS.obligations.insurance,
    userId: IDS.user,
    payeeId: IDS.payees.insurer,
    amountMinor: toMinor("96", "EUR"),
    currency: "EUR",
    dueDate: "2026-11-15",
    recurrence: "TERM",
    reference: "POL-778201-Q4",
    category: "insurance",
  },
  {
    // D-CN1: the Shanghai dorm bills monthly in CNY. Dana holds no CNY, so the forecast shows a CNY need
    // funded from KZT/USD. Due after the demo's "+3 days" window, so the rent-autopay story is unchanged.
    id: IDS.obligations.dormFee,
    userId: IDS.user,
    payeeId: IDS.payees.dormOffice,
    amountMinor: toMinor("1800", "CNY"),
    currency: "CNY",
    dueDate: "2026-11-15",
    recurrence: "MONTHLY",
    reference: "SH-DORM-B12-NOV",
    category: "rent",
  },
];

export const mandates: SeedMandate[] = [
  {
    label: "Rent to Landlord in Budapest, up to HUF 200,000 per month",
    core: {
      v: 1,
      mandateId: IDS.mandates.rent,
      userId: IDS.user,
      payeeIds: [IDS.payees.landlord],
      categories: ["rent"],
      currency: "HUF",
      maxPerPaymentMinor: toMinor("200000", "HUF"),
      maxPerPeriodMinor: toMinor("200000", "HUF"),
      period: "MONTH",
      validFrom: SEED_NOW,
      validUntil: "2027-07-31T23:59:59.000Z",
    },
  },
];

export const budgets: SeedBudget[] = [
  { id: IDS.budgets.groceries, userId: IDS.user, category: "groceries", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: toMinor("90000", "KZT") },
  { id: IDS.budgets.eatingOut, userId: IDS.user, category: "eating_out", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: toMinor("60000", "KZT") },
  { id: IDS.budgets.transport, userId: IDS.user, category: "transport", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: toMinor("20000", "KZT") },
];

// ---------- Transactions (30 days before SEED_NOW) ----------

/** [n, occurredAt, source, merchantRaw, merchantNorm, mcc, amount (major, decimal string), currency, card key, category, flags] */
type Row<K extends string = keyof typeof IDS.cards> = [
  number,
  string,
  TransactionSource,
  string,
  string,
  string | null,
  string,
  string,
  K | null,
  string,
  { pending?: true; mergedInto?: number }?,
];

const ROWS: Row[] = [
  [1, "2026-09-27T10:15:00Z", "NOTIF_SIM", "VALUE MART 0412 BUDAPEST", "value mart", "5411", "6890", "HUF", "local", "groceries"],
  [2, "2026-09-28T19:40:00Z", "NOTIF_SIM", "NOODLE BAR IN BUDAPEST", "noodle bar in", "5812", "3290", "HUF", "kzt", "eating_out"],
  [3, "2026-09-30T13:10:00Z", "NOTIF_SIM", "CANTEEN IN BUDAPEST", "canteen in", "5812", "1890", "HUF", "local", "eating_out"],
  [4, "2026-10-01T07:55:00Z", "SHORTCUT", "City Transit", "city transit", "4111", "3450", "HUF", "local", "transport"],
  [5, "2026-10-01T09:00:00Z", "SETTLEMENT", "LANDLORD IN BUDAPEST RENT OCT", "landlord in budapest", "6513", "180000", "HUF", null, "rent"],
  [6, "2026-10-02T18:20:00Z", "NOTIF_SIM", "GROCERY STORE IN BUDAPEST HU", "grocery store in", "5411", "4120", "HUF", "local", "groceries"],
  [7, "2026-10-03T12:30:00Z", "TEXT", "lunch noodle bar in 2990", "noodle bar in", null, "2990", "HUF", "local", "eating_out"],
  [8, "2026-10-04T11:00:00Z", "NOTIF_SIM", "MARKET HALL IN BUDAPEST", "market hall in", "5499", "5340", "HUF", "kzt", "groceries"],
  [9, "2026-10-05T20:15:00Z", "NOTIF_SIM", "CINEMA IN BUDAPEST", "cinema in", "7832", "2900", "HUF", "local", "entertainment"],
  [10, "2026-10-06T08:40:00Z", "SHORTCUT", "Morning Bakery", "morning bakery", "5462", "1250", "HUF", "local", "groceries"],
  [11, "2026-10-07T13:05:00Z", "NOTIF_SIM", "CANTEEN IN BUDAPEST", "canteen in", "5812", "1990", "HUF", "local", "eating_out"],
  [12, "2026-10-08T19:10:00Z", "VOICE", "kebab corner dinner two thousand eight hundred forint", "kebab corner", null, "2800", "HUF", "local", "eating_out"],
  [13, "2026-10-09T17:45:00Z", "NOTIF_SIM", "VALUE MART 0412 BUDAPEST", "value mart", "5411", "7460", "HUF", "local", "groceries"],
  [14, "2026-10-10T10:20:00Z", "NOTIF_SIM", "ONLINE BOOKSTORE EU", "online bookstore", "5942", "24.90", "EUR", "usd", "books"],
  [15, "2026-10-11T14:00:00Z", "NOTIF_SIM", "COFFEE SHOP IN BUDAPEST", "coffee shop in", "5814", "1450", "HUF", "local", "eating_out"],
  [16, "2026-10-12T21:30:00Z", "NOTIF_SIM", "CITY TAXI BUDAPEST HU", "city taxi", "4121", "2680", "HUF", "kzt", "transport"],
  [17, "2026-10-13T18:00:00Z", "SHORTCUT", "Grocery Store in Budapest", "grocery store in", "5411", "3870", "HUF", "local", "groceries"],
  // Same purchase seen again by the notification simulator 4 minutes later: merged into #17 (spec §13 dedupe).
  [18, "2026-10-13T18:04:00Z", "NOTIF_SIM", "GROCERY STORE IN BUDAPEST HU", "grocery store in", "5411", "3870", "HUF", "local", "groceries", { mergedInto: 17 }],
  [19, "2026-10-14T12:50:00Z", "NOTIF_SIM", "NOODLE BAR IN BUDAPEST", "noodle bar in", "5812", "3190", "HUF", "local", "eating_out"],
  [20, "2026-10-15T09:30:00Z", "NOTIF_SIM", "GREEN CROSS PHARMACY BP", "green cross pharmacy", "5912", "2340", "HUF", "local", "health"],
  [21, "2026-10-16T19:20:00Z", "NOTIF_SIM", "PIZZA SHOP IN BUDAPEST HU", "pizza shop in", "5814", "5980", "HUF", "local", "eating_out"],
  [22, "2026-10-17T11:10:00Z", "SCREENSHOT", "Market Hall in Budapest", "market hall in", "5499", "6150", "HUF", "local", "groceries"],
  [23, "2026-10-18T13:15:00Z", "NOTIF_SIM", "CANTEEN IN BUDAPEST", "canteen in", "5812", "1890", "HUF", "local", "eating_out"],
  [24, "2026-10-19T16:40:00Z", "NOTIF_SIM", "CITY BIKES BP", "city bikes", "4789", "490", "HUF", "local", "transport"],
  [25, "2026-10-20T18:30:00Z", "NOTIF_SIM", "VALUE MART 0412 BUDAPEST", "value mart", "5411", "8230", "HUF", "kzt", "groceries"],
  [26, "2026-10-21T20:00:00Z", "NOTIF_SIM", "MOBILE OPERATOR IN HUNGARY", "mobile operator in hungary", "4814", "4990", "HUF", "local", "phone"],
  [27, "2026-10-22T12:45:00Z", "TEXT", "coffee and cake 1650", "coffee shop in", null, "1650", "HUF", "local", "eating_out"],
  [28, "2026-10-23T19:15:00Z", "NOTIF_SIM", "KEBAB CORNER BP", "kebab corner", "5814", "2600", "HUF", "local", "eating_out"],
  [29, "2026-10-24T10:05:00Z", "NOTIF_SIM", "STREAMBOX.EXAMPLE", "streambox", "7922", "9.99", "EUR", "usd", "entertainment"],
  [30, "2026-10-24T17:30:00Z", "NOTIF_SIM", "GROCERY STORE IN BUDAPEST HU", "grocery store in", "5411", "5480", "HUF", "local", "groceries"],
  [31, "2026-10-25T13:00:00Z", "NOTIF_SIM", "NOODLE BAR IN BUDAPEST", "noodle bar in", "5812", "3490", "HUF", "local", "eating_out"],
  [32, "2026-10-25T20:10:00Z", "SHORTCUT", "Morning Bakery", "morning bakery", "5462", "980", "HUF", "local", "groceries"],
  // The two foreign charges awaiting settlement (spec §18): HUF and EUR on the home KZT card.
  [33, "2026-10-26T18:50:00Z", "NOTIF_SIM", "MARKET HALL IN BUDAPEST", "market hall in", "5499", "4760", "HUF", "kzt", "groceries", { pending: true }],
  [34, "2026-10-26T21:05:00Z", "NOTIF_SIM", "ONLINE BOOKSTORE EU", "online bookstore", "5942", "18.50", "EUR", "kzt", "books", { pending: true }],
  [35, "2026-10-27T08:15:00Z", "NOTIF_SIM", "COFFEE SHOP IN BUDAPEST", "coffee shop in", "5814", "1290", "HUF", "local", "eating_out"],
];

/** Who the rows belong to: user, home currency, card ids/billing/markups and the seedId prefix of row ids. */
interface TxnOwner<K extends string> {
  userId: string;
  homeCurrency: string;
  cardIds: Record<K, string>;
  cards: SeedCard[];
  markupBps: Record<string, Record<string, number>>;
  /** seedId name prefix: Dana's rows are `txn/NN` (kept stable), other personas `<persona>/txn/NN`. */
  idPrefix: string;
}

function rateToHome(currency: string, home: string): string {
  return crossRate(SEED_FX.rates, currency, home, 6);
}

function buildTransactions<K extends string>(rows: Row<K>[], o: TxnOwner<K>): SeedTransaction[] {
  const billingOf: Record<string, string> = Object.fromEntries(o.cards.map((c) => [c.id, c.billingCurrency]));
  const txnId = (n: number) => seedId(`${o.idPrefix}txn/${String(n).padStart(2, "0")}`);
  return rows.map((row) => {
    const [n, at, source, merchantRaw, merchantNorm, mcc, amount, currency, cardKey, category, flags] = row;
    const occurredAt = new Date(at).toISOString();
    const amountMinor = toMinor(amount, currency);
    const cardId = cardKey === null ? null : o.cardIds[cardKey];
    const homeAmountMinor = convertMinor(amountMinor, currency, o.homeCurrency, rateToHome(currency, o.homeCurrency));

    let settledAmountMinor: number | null = null;
    let settledCurrency: string | null = null;
    let feeHomeMinor: number | null = null;
    if (!flags?.pending) {
      if (cardId === null) {
        // Bank transfer seen on a statement: settles 1:1 in its own currency.
        settledAmountMinor = amountMinor;
        settledCurrency = currency;
        feeHomeMinor = 0;
      } else {
        const billing = billingOf[cardId]!;
        const markup = billing === currency ? 0 : (o.markupBps[cardId]?.[currency] ?? 0);
        settledCurrency = billing;
        settledAmountMinor = convertMinor(amountMinor, currency, billing, crossRate(SEED_FX.rates, currency, billing, 10), {
          markupBps: markup,
        });
        const settledHome = convertMinor(settledAmountMinor, billing, o.homeCurrency, rateToHome(billing, o.homeCurrency));
        feeHomeMinor = settledHome - homeAmountMinor; // spec §12: feeHome = settledHome − amount × mid
      }
    }
    const tenMinuteBucket = Math.floor(Date.parse(occurredAt) / 600_000);
    return {
      id: txnId(n),
      userId: o.userId,
      source,
      occurredAt,
      merchantRaw,
      merchantNorm,
      mcc,
      amountMinor,
      currency,
      cardId,
      homeAmountMinor,
      rateUsed: rateToHome(currency, o.homeCurrency),
      // Example rates are applied as if published on the purchase date (labelled example values).
      rateDate: occurredAt.slice(0, 10),
      settledAmountMinor,
      settledCurrency,
      feeHomeMinor,
      category,
      dedupeKey: `${o.userId}|${amountMinor}|${currency}|${merchantNorm}|${tenMinuteBucket}`,
      mergedIntoId: flags?.mergedInto ? txnId(flags.mergedInto) : null,
      status: flags?.pending ? "PENDING" : "SETTLED",
    };
  });
}

/** Card fee profiles derived from settled seed transactions (EXAMPLE values). */
function feeProfiles(markupBps: Record<string, Record<string, number>>, cardList: SeedCard[], txns: SeedTransaction[]): SeedCardFeeProfile[] {
  const billingOf: Record<string, string> = Object.fromEntries(cardList.map((c) => [c.id, c.billingCurrency]));
  return Object.entries(markupBps).flatMap(([cardId, byCurrency]) =>
    Object.entries(byCurrency).map(([fromCurrency, bps]) => ({
      cardId,
      fromCurrency,
      toCurrency: billingOf[cardId]!,
      medianMarkupBps: billingOf[cardId] === fromCurrency ? 0 : bps,
      fixedFeeMinor: 0,
      samples: txns.filter((t) => t.cardId === cardId && t.currency === fromCurrency && t.status === "SETTLED" && t.mergedIntoId === null).length,
      exampleValues: true as const,
    })),
  );
}

export const transactions: SeedTransaction[] = buildTransactions(ROWS, {
  userId: IDS.user,
  homeCurrency: HOME_CURRENCY,
  cardIds: IDS.cards,
  cards,
  markupBps: CARD_MARKUP_BPS,
  idPrefix: "",
});

/** Card fee profiles derived from the settled seed transactions (EXAMPLE values). */
export const cardFeeProfiles: SeedCardFeeProfile[] = feeProfiles(CARD_MARKUP_BPS, cards, transactions);

// ---------- Second persona: Li Wei (D-CN3) ----------
/*
 * Li Wei, a Chinese master's student in Budapest: home CNY, region EU, SMART, capped wallet. His parents remit
 * CNY monthly; rent is HUF to the same landlord company as Dana (his own payee row, the account for his
 * building), tuition is EUR to the same university (same account, his own reference). The API seeds him only
 * with `seedDatabase(..., { personas: true })` (seed script, sim daemon, demo reset), so tests that seed
 * Dana alone are unchanged. Ids are `seedId("li-wei/...")` (`user/li-wei` for the user).
 */

export const LI_WEI_IDS = {
  user: "1c6e6d69-558a-5b2e-b4ac-3fbe56f6db3b", // seedId("user/li-wei")
  payees: {
    landlord: "21e68b31-a232-5f36-a726-8832061eb3cb", // seedId("li-wei/payee/landlord")
    university: "2efbc65e-4fa9-575f-a0a7-3ed8f3cc1db9", // seedId("li-wei/payee/university")
  },
  cards: {
    cny: "ff1805cb-47c7-522b-acc5-13b99f78a303", // seedId("li-wei/card/cny")
    local: "4172b1ff-f456-541d-806d-d6fb6730ded2", // seedId("li-wei/card/local")
  },
  obligations: {
    rent: "fed661ad-7229-5443-81ba-199a0a752242", // seedId("li-wei/obligation/rent")
    tuition: "c81e0569-d453-59a2-9bde-86ba2131491a", // seedId("li-wei/obligation/tuition")
  },
  budgets: {
    groceries: "0c275d61-eadb-5866-a3d3-b62a893c2e43", // seedId("li-wei/budget/groceries")
    eatingOut: "ef4fc91e-58d2-5956-8a07-745fddd735fe", // seedId("li-wei/budget/eating_out")
    transport: "199526f0-93c3-5fe8-9267-fdf4201d5552", // seedId("li-wei/budget/transport")
  },
} as const;

/** Persona key for the demo claim (`sim register <name> --claim-demo li-wei`). */
export const LI_WEI_PERSONA = "li-wei";
export const LI_WEI_HOME_CURRENCY = "CNY";
/** Mock bank profile for Li Wei's capped wallet (alias: his user id and "li-wei"). */
export const LI_WEI_MOCK_BANK_PROFILE_ID = 16_000_002;
/** ISO 11649 creditor reference on Li Wei's tuition invoice. */
export const LI_WEI_TUITION_REFERENCE = "RF32RUB2026L03318";

const liWeiUser: SeedUser = {
  id: LI_WEI_IDS.user,
  displayName: "Li Wei",
  homeCurrency: LI_WEI_HOME_CURRENCY,
  region: "EU",
  preset: "SMART",
  moneyMode: "CAPPED_WALLET",
  frozenAt: null,
  createdAt: "2026-09-18T08:00:00.000Z",
};

const liWeiProfile: SeedProfile & { caps: SeedCaps } = {
  userId: LI_WEI_IDS.user,
  incomes: [{ source: "Parents", currency: "CNY", amountMinor: toMinor("12000", "CNY"), cadence: "MONTHLY", dayOfMonth: 20, nextDate: "2026-11-20" }],
  notificationMode: "EACH",
  reserveRules: {
    protectObligationCategories: ["rent", "tuition"],
    minBalances: [{ currency: "CNY", amountMinor: toMinor("2000", "CNY") }],
  },
  // Caps are in the home currency: roughly Dana's KZT defaults in value (EXAMPLE values).
  caps: {
    perPaymentMinor: toMinor("30000", "CNY"),
    perDayMinor: toMinor("40000", "CNY"),
    perMonthMinor: toMinor("60000", "CNY"),
    smallAutoMinor: toMinor("100", "CNY"),
    reserveMinor: toMinor("2000", "CNY"),
  },
};

/** CNY covers EUR tuition only by conversion: the EUR and HUF balances are too small on their own. */
const liWeiBalances: SeedBalance[] = [
  { currency: "CNY", amountMinor: toMinor("60000", "CNY") },
  { currency: "EUR", amountMinor: toMinor("450", "EUR") },
  { currency: "HUF", amountMinor: toMinor("95000", "HUF") },
];

const liWeiCards: SeedCard[] = [
  // CardKind has no CNY member; MULTI = a home-bank debit card that also pays abroad (docs/DECISIONS.md).
  { id: LI_WEI_IDS.cards.cny, userId: LI_WEI_IDS.user, label: "Home bank CNY debit card (example)", last4: "3388", billingCurrency: "CNY", kind: "MULTI" },
  { id: LI_WEI_IDS.cards.local, userId: LI_WEI_IDS.user, label: "Local HUF/EUR card (example)", last4: "1542", billingCurrency: "HUF", kind: "LOCAL_HUF" },
];

/** EXAMPLE markups: CNY debit card abroad ~150 bps (same as rails.json cny-card), local card 0–50 bps. */
const LI_WEI_MARKUP_BPS: Record<string, Record<string, number>> = {
  [LI_WEI_IDS.cards.cny]: { HUF: 150, EUR: 150 },
  [LI_WEI_IDS.cards.local]: { HUF: 0, EUR: 50 },
};

const liWeiPayees: SeedPayee[] = [
  {
    id: LI_WEI_IDS.payees.landlord,
    userId: LI_WEI_IDS.user,
    name: "Landlord in Budapest",
    kind: "LANDLORD",
    account: ACCOUNTS.landlordLiWei,
    accountScheme: "IBAN",
    bic: "HFLTHUHBXXX",
    country: "HU",
    currency: "HUF",
    status: "VERIFIED",
    verifiedAt: "2026-09-03T11:00:00.000Z",
    coolingUntil: null,
    replacesPayeeId: null,
  },
  {
    id: LI_WEI_IDS.payees.university,
    userId: LI_WEI_IDS.user,
    name: "University in Budapest",
    kind: "UNIVERSITY",
    account: ACCOUNTS.university,
    accountScheme: "IBAN",
    bic: "RVUBHUHBXXX",
    country: "HU",
    currency: "EUR",
    status: "VERIFIED",
    verifiedAt: "2026-09-06T10:15:00.000Z",
    coolingUntil: null,
    replacesPayeeId: null,
  },
];

/** Both due after the demo's "+3 days" window (rent on the 5th, tuition 10 Nov), so Dana's scenarios are unchanged. */
const liWeiObligations: SeedObligation[] = [
  {
    id: LI_WEI_IDS.obligations.rent,
    userId: LI_WEI_IDS.user,
    payeeId: LI_WEI_IDS.payees.landlord,
    amountMinor: toMinor("165000", "HUF"),
    currency: "HUF",
    dueDate: "2026-11-05",
    recurrence: "MONTHLY",
    reference: "HF-APT2C-RENT",
    category: "rent",
  },
  {
    id: LI_WEI_IDS.obligations.tuition,
    userId: LI_WEI_IDS.user,
    payeeId: LI_WEI_IDS.payees.university,
    amountMinor: toMinor("3200", "EUR"),
    currency: "EUR",
    dueDate: "2026-11-10",
    recurrence: "TERM",
    reference: LI_WEI_TUITION_REFERENCE,
    category: "tuition",
  },
];

const liWeiBudgets: SeedBudget[] = [
  { id: LI_WEI_IDS.budgets.groceries, userId: LI_WEI_IDS.user, category: "groceries", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: toMinor("1500", "CNY") },
  { id: LI_WEI_IDS.budgets.eatingOut, userId: LI_WEI_IDS.user, category: "eating_out", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: toMinor("1000", "CNY") },
  { id: LI_WEI_IDS.budgets.transport, userId: LI_WEI_IDS.user, category: "transport", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: toMinor("300", "CNY") },
];

const LI_WEI_ROWS: Row<keyof typeof LI_WEI_IDS.cards>[] = [
  [1, "2026-09-29T11:20:00Z", "NOTIF_SIM", "VALUE MART 0412 BUDAPEST", "value mart", "5411", "5640", "HUF", "local", "groceries"],
  [2, "2026-10-01T09:00:00Z", "SETTLEMENT", "LANDLORD IN BUDAPEST RENT OCT", "landlord in budapest", "6513", "165000", "HUF", null, "rent"],
  [3, "2026-10-02T12:10:00Z", "NOTIF_SIM", "CANTEEN IN BUDAPEST", "canteen in", "5812", "1890", "HUF", "local", "eating_out"],
  [4, "2026-10-03T08:05:00Z", "SHORTCUT", "City Transit", "city transit", "4111", "3450", "HUF", "local", "transport"],
  [5, "2026-10-04T16:30:00Z", "NOTIF_SIM", "ASIAN GROCERY IN BUDAPEST", "asian grocery in", "5411", "7820", "HUF", "cny", "groceries"],
  [6, "2026-10-07T19:00:00Z", "NOTIF_SIM", "NOODLE BAR IN BUDAPEST", "noodle bar in", "5812", "3290", "HUF", "cny", "eating_out"],
  [7, "2026-10-09T10:00:00Z", "NOTIF_SIM", "ONLINE BOOKSTORE EU", "online bookstore", "5942", "32.00", "EUR", "cny", "books"],
  [8, "2026-10-11T13:40:00Z", "TEXT", "dumplings 2890", "dumpling house in", null, "2890", "HUF", "local", "eating_out"],
  [9, "2026-10-14T17:15:00Z", "NOTIF_SIM", "GROCERY STORE IN BUDAPEST HU", "grocery store in", "5411", "6230", "HUF", "local", "groceries"],
  [10, "2026-10-16T12:30:00Z", "NOTIF_SIM", "CANTEEN IN BUDAPEST", "canteen in", "5812", "1990", "HUF", "local", "eating_out"],
  [11, "2026-10-18T20:45:00Z", "NOTIF_SIM", "CITY TAXI BUDAPEST HU", "city taxi", "4121", "3120", "HUF", "cny", "transport"],
  [12, "2026-10-21T10:10:00Z", "NOTIF_SIM", "MOBILE OPERATOR IN HUNGARY", "mobile operator in hungary", "4814", "4990", "HUF", "local", "phone"],
  [13, "2026-10-23T18:20:00Z", "NOTIF_SIM", "ASIAN GROCERY IN BUDAPEST", "asian grocery in", "5411", "9150", "HUF", "cny", "groceries"],
  [14, "2026-10-25T13:00:00Z", "NOTIF_SIM", "NOODLE BAR IN BUDAPEST", "noodle bar in", "5812", "3490", "HUF", "local", "eating_out"],
  [15, "2026-10-26T19:30:00Z", "NOTIF_SIM", "STREAMBOX.EXAMPLE", "streambox", "7922", "9.99", "EUR", "cny", "entertainment"],
];

const liWeiTransactions: SeedTransaction[] = buildTransactions(LI_WEI_ROWS, {
  userId: LI_WEI_IDS.user,
  homeCurrency: LI_WEI_HOME_CURRENCY,
  cardIds: LI_WEI_IDS.cards,
  cards: liWeiCards,
  markupBps: LI_WEI_MARKUP_BPS,
  idPrefix: "li-wei/",
});

/** Everything the API seeds for Li Wei (same row shapes as Dana's tables). */
export const liWei = {
  persona: LI_WEI_PERSONA,
  mockBankProfileId: LI_WEI_MOCK_BANK_PROFILE_ID,
  user: liWeiUser,
  profile: liWeiProfile,
  balances: liWeiBalances,
  cards: liWeiCards,
  cardFeeProfiles: feeProfiles(LI_WEI_MARKUP_BPS, liWeiCards, liWeiTransactions),
  payees: liWeiPayees,
  obligations: liWeiObligations,
  budgets: liWeiBudgets,
  transactions: liWeiTransactions,
} as const;

// ---------- Kassa Business: two pizzerias (M0) + Li Wei in Shanghai ----------
/*
 * One merchant codebase, two tenants (docs/DECISIONS.md "Kassa Business"):
 * - `pizzeria-bud`: Pizza Shop in Budapest (HUF, region EU, Europe/Budapest), mock-world storeId "bud". Pays its
 *   suppliers by BANK_TRANSFER from a capped wallet. Comfortably stocked, but stock is trending down.
 * - `pizzeria-sha`: Pizza Shop in Shanghai (CNY, region CN, Asia/Shanghai), storeId "sha". Pays through QR HANDOFF.
 *   Tuned so the stock forecast shows about 400 pizza boxes short by the end of tomorrow.
 * - `li-wei-cn`: Li Wei as a customer in Shanghai (region CN, HANDOFF): a separate persona so `li-wei` (a student in
 *   Budapest, region EU) and every test that seeds him stay unchanged.
 *
 * Forecast contract the seed is tuned for (M4 business/forecast.ts implements it):
 *   demand(day) = Σ_menu round(avg qty sold on the same weekday over the last 4 weeks) × recipe qtyPerUnit
 *   need        = demand(today) + demand(tomorrow)          (today = SEED_NOW's calendar day in the merchant's timezone)
 *   safety      = ceil(need × safetyStockPct / 100)
 *   shortage    = max(0, need + safety − onHand)            (onHand = Σ stock_movements.qty; no open POs at seed time)
 * sales_daily holds the 28 completed days before today; the stock ledger is consistent with it (opening SEED stock,
 * weekly RECEIPTs, one SALE movement per day and inventory SKU = Σ recipe × qty sold), so onHand ends at the target.
 *
 * Suppliers: each pizzeria has a VERIFIED supplier (A in Budapest, C in Shanghai) and a newer, cheaper one still
 * COOLING (B / D) — the attacker in the swapped-account invoice scenario (M5). Catalogs: mock-world SUPPLIERS.
 */

export const BUSINESS_IDS = {
  bud: {
    user: "02ec41e3-7f0f-59cf-a7e8-d9e8cb990b4d", // seedId("user/pizzeria-bud")
    merchant: "e07aab11-023e-5ee4-8192-6784ef287dab", // seedId("pizzeria-bud/merchant")
    payees: {
      supplierA: "cf4b671d-7244-5793-ab39-9596165620b1", // seedId("pizzeria-bud/payee/supplier-a")
      supplierB: "5dfa72a0-0389-5306-a333-b9e4d67b9e66", // seedId("pizzeria-bud/payee/supplier-b")
    },
  },
  sha: {
    user: "08dc4466-1346-5be3-9fc7-708d7eb7e536", // seedId("user/pizzeria-sha")
    merchant: "42178da4-27f6-528d-b070-7384ac1520a5", // seedId("pizzeria-sha/merchant")
    payees: {
      supplierC: "a0326d52-4f69-5b38-bb3a-ee31cb4e4813", // seedId("pizzeria-sha/payee/supplier-c")
      supplierD: "7f692319-ca21-5682-8c2a-89ed73357e03", // seedId("pizzeria-sha/payee/supplier-d")
    },
  },
  liWeiCn: {
    user: "37de7459-ded7-5807-b8cd-515f1b6e18f0", // seedId("user/li-wei-cn")
    payees: { pizzaShopSh: "90a94518-5153-52c4-bf57-12e919d6be49" }, // seedId("li-wei-cn/payee/pizza-shop-sh")
    budgets: { eatingOut: "9906b026-0db7-5a08-ab35-be850e8e4f8a" }, // seedId("li-wei-cn/budget/eating_out")
  },
} as const;

export const PIZZERIA_BUD_PERSONA = "pizzeria-bud";
export const PIZZERIA_SHA_PERSONA = "pizzeria-sha";
export const LI_WEI_CN_PERSONA = "li-wei-cn";
/** mock-world storeIds (= merchants.slug). The old `/mock/shop/pizza/*` routes are an alias of "bud". */
export const STORE_IDS = { bud: "bud", sha: "sha" } as const;
export type StoreId = (typeof STORE_IDS)[keyof typeof STORE_IDS];

/** Supplier names and accounts (mock-world SUPPLIERS reads these; C and D are QR-wallet merchants, no IBAN). */
export const SUPPLIER_NAMES = {
  a: "Dough Supplier from EU",
  b: "Pizza Supplier from EU",
  c: "Restaurant Supplier from China",
  d: "Box Supplier from China",
} as const;

/** Menu SKUs (mock-world PIZZA_MENUS have the same SKUs in both stores; prices differ by currency). */
export const MENU_SKUS = ["PZ-MARG", "PZ-PEPP", "PZ-4CHE", "PZ-VEGE", "DR-COLA", "DS-TIRA"] as const;
export type MenuSku = (typeof MENU_SKUS)[number];

export interface SeedInventoryItem {
  sku: string;
  name: string;
  unit: "pcs" | "g";
  safetyStockPct: number;
  reorderCoverDays: number;
}
export interface SeedRecipe {
  menuSku: MenuSku;
  inventorySku: string;
  qtyPerUnit: number;
}
export interface SeedSupplierItem {
  id: string;
  supplierPayeeId: string;
  supplierSku: string;
  inventorySku: string;
  packSize: number;
  packPriceMinor: number;
  currency: string;
  minOrderPacks: number;
  leadTimeDays: number;
}
export interface SeedSalesDay {
  day: string;
  menuSku: MenuSku;
  qty: number;
  revenueMinor: number;
}
export interface SeedStockMovement {
  id: string;
  sku: string;
  kind: "SEED" | "SALE" | "RECEIPT" | "ADJUSTMENT" | "WASTE";
  qty: number;
  occurredAt: string;
  ref: string | null;
}
export interface SeedMerchant {
  id: string;
  slug: StoreId;
  name: string;
  currency: string;
  region: Region;
  timezone: string;
  poCapMinor: number;
}
export interface SeedBusiness {
  merchant: SeedMerchant;
  inventory: SeedInventoryItem[];
  recipes: SeedRecipe[];
  supplierItems: SeedSupplierItem[];
  salesDaily: SeedSalesDay[];
  stockMovements: SeedStockMovement[];
}

const INVENTORY: SeedInventoryItem[] = [
  { sku: "BOX-33CM", name: "Pizza box 33 cm", unit: "pcs", safetyStockPct: 10, reorderCoverDays: 3 },
  { sku: "DOUGH-BALL", name: "Dough ball 250 g", unit: "pcs", safetyStockPct: 10, reorderCoverDays: 2 },
  { sku: "MOZZ-G", name: "Mozzarella", unit: "g", safetyStockPct: 10, reorderCoverDays: 3 },
  { sku: "TOMATO-G", name: "Tomato passata", unit: "g", safetyStockPct: 10, reorderCoverDays: 5 },
  { sku: "SALAMI-G", name: "Spicy salami", unit: "g", safetyStockPct: 10, reorderCoverDays: 4 },
  { sku: "VEG-G", name: "Vegetable mix", unit: "g", safetyStockPct: 15, reorderCoverDays: 2 },
  { sku: "COLA-BTL", name: "Cola 0.5 l bottle", unit: "pcs", safetyStockPct: 10, reorderCoverDays: 7 },
  { sku: "TIRA-PC", name: "Tiramisu portion", unit: "pcs", safetyStockPct: 10, reorderCoverDays: 2 },
];

/** Same recipes in both shops: every pizza goes out in one 33 cm box on one dough ball. */
const RECIPES: SeedRecipe[] = [
  { menuSku: "PZ-MARG", inventorySku: "BOX-33CM", qtyPerUnit: 1 },
  { menuSku: "PZ-MARG", inventorySku: "DOUGH-BALL", qtyPerUnit: 1 },
  { menuSku: "PZ-MARG", inventorySku: "MOZZ-G", qtyPerUnit: 125 },
  { menuSku: "PZ-MARG", inventorySku: "TOMATO-G", qtyPerUnit: 80 },
  { menuSku: "PZ-PEPP", inventorySku: "BOX-33CM", qtyPerUnit: 1 },
  { menuSku: "PZ-PEPP", inventorySku: "DOUGH-BALL", qtyPerUnit: 1 },
  { menuSku: "PZ-PEPP", inventorySku: "MOZZ-G", qtyPerUnit: 110 },
  { menuSku: "PZ-PEPP", inventorySku: "TOMATO-G", qtyPerUnit: 80 },
  { menuSku: "PZ-PEPP", inventorySku: "SALAMI-G", qtyPerUnit: 60 },
  { menuSku: "PZ-4CHE", inventorySku: "BOX-33CM", qtyPerUnit: 1 },
  { menuSku: "PZ-4CHE", inventorySku: "DOUGH-BALL", qtyPerUnit: 1 },
  { menuSku: "PZ-4CHE", inventorySku: "MOZZ-G", qtyPerUnit: 160 },
  { menuSku: "PZ-VEGE", inventorySku: "BOX-33CM", qtyPerUnit: 1 },
  { menuSku: "PZ-VEGE", inventorySku: "DOUGH-BALL", qtyPerUnit: 1 },
  { menuSku: "PZ-VEGE", inventorySku: "MOZZ-G", qtyPerUnit: 100 },
  { menuSku: "PZ-VEGE", inventorySku: "TOMATO-G", qtyPerUnit: 80 },
  { menuSku: "PZ-VEGE", inventorySku: "VEG-G", qtyPerUnit: 120 },
  { menuSku: "DR-COLA", inventorySku: "COLA-BTL", qtyPerUnit: 1 },
  { menuSku: "DS-TIRA", inventorySku: "TIRA-PC", qtyPerUnit: 1 },
];

/** Menu prices (minor units) per store; mock-world PIZZA_MENUS uses exactly these. */
export const MENU_PRICES: Record<StoreId, Record<MenuSku, number>> = {
  bud: { "PZ-MARG": 299000, "PZ-PEPP": 349000, "PZ-4CHE": 369000, "PZ-VEGE": 329000, "DR-COLA": 69000, "DS-TIRA": 129000 },
  sha: { "PZ-MARG": 6800, "PZ-PEPP": 7800, "PZ-4CHE": 8800, "PZ-VEGE": 7200, "DR-COLA": 800, "DS-TIRA": 3200 },
};

/** Units sold per pizza across the menu (pizzas split by these shares; drinks and desserts per pizza). */
const MENU_MIX: Record<MenuSku, number> = { "PZ-MARG": 0.35, "PZ-PEPP": 0.3, "PZ-4CHE": 0.15, "PZ-VEGE": 0.2, "DR-COLA": 0.4, "DS-TIRA": 0.15 };

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Weekday (0 = Sunday) of a calendar date. */
const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

/** Deterministic ±`spread` jitter per name (FNV-1a), so the history looks real but is identical on every run. */
function jitter(name: string, spread: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return 1 + ((h % 2001) / 1000 - 1) * spread;
}

/** The merchant's calendar date at an instant (IANA zone), e.g. "2026-10-27". */
export function localDay(at: string | number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

interface BusinessSpec {
  persona: string;
  merchant: SeedMerchant;
  /** Pizzas sold per weekday (Sunday first) at the start of the 28 days. */
  pizzasByWeekday: readonly number[];
  /** Total relative change of daily sales over the 28 days (−0.1 = sales drift 10 % down). */
  trend: number;
  /** BOX-33CM / DOUGH-BALL / ... on hand at seed time, as days of cover of (today + tomorrow) demand incl. safety. */
  endStock: (sku: string, needWithSafety: number) => number;
  supplierItems: Omit<SeedSupplierItem, "id">[];
}

/** demand(day) as in the forecast contract above. */
function forecastNeed(sales: SeedSalesDay[], today: string): Record<string, number> {
  const tomorrow = isoDay(Date.parse(`${today}T12:00:00Z`) + DAY_MS);
  const need: Record<string, number> = {};
  for (const day of [today, tomorrow]) {
    const wd = weekdayOf(day);
    const same = sales.filter((s) => weekdayOf(s.day) === wd);
    const days = [...new Set(same.map((s) => s.day))].sort().slice(-4);
    for (const sku of MENU_SKUS) {
      const qtys = same.filter((s) => s.menuSku === sku && days.includes(s.day)).map((s) => s.qty);
      const avg = qtys.length ? Math.round(qtys.reduce((a, b) => a + b, 0) / qtys.length) : 0;
      for (const r of RECIPES.filter((x) => x.menuSku === sku)) need[r.inventorySku] = (need[r.inventorySku] ?? 0) + avg * r.qtyPerUnit;
    }
  }
  return need;
}

/** Shortage by the end of tomorrow per inventory SKU (the forecast contract), from seed rows alone. */
export function seedForecastShortage(b: SeedBusiness, nowIso: string = SEED_NOW): Record<string, { need: number; safety: number; onHand: number; shortage: number }> {
  const need = forecastNeed(b.salesDaily, localDay(nowIso, b.merchant.timezone));
  const out: Record<string, { need: number; safety: number; onHand: number; shortage: number }> = {};
  for (const item of b.inventory) {
    const n = need[item.sku] ?? 0;
    const safety = Math.ceil((n * item.safetyStockPct) / 100);
    const onHand = b.stockMovements.filter((m) => m.sku === item.sku && Date.parse(m.occurredAt) <= Date.parse(nowIso)).reduce((s, m) => s + m.qty, 0);
    out[item.sku] = { need: n, safety, onHand, shortage: Math.max(0, n + safety - onHand) };
  }
  return out;
}

function buildBusiness(spec: BusinessSpec): SeedBusiness {
  const m = spec.merchant;
  const today = localDay(SEED_NOW, m.timezone);
  const todayMs = Date.parse(`${today}T12:00:00Z`);
  const days = Array.from({ length: 28 }, (_, i) => isoDay(todayMs - (28 - i) * DAY_MS));
  const salesDaily: SeedSalesDay[] = [];
  days.forEach((day, i) => {
    const pizzas = spec.pizzasByWeekday[weekdayOf(day)]! * (1 + (spec.trend * i) / 27) * jitter(`${spec.persona}/${day}`, 0.06);
    for (const sku of MENU_SKUS) {
      const qty = Math.max(0, Math.round(pizzas * MENU_MIX[sku] * jitter(`${spec.persona}/${day}/${sku}`, 0.08)));
      salesDaily.push({ day, menuSku: sku, qty, revenueMinor: qty * MENU_PRICES[m.slug][sku] });
    }
  });

  // Stock ledger: opening SEED stock (day 1), a RECEIPT every Monday, one SALE per day and SKU; ends at endStock.
  const needWithSafety = forecastNeed(salesDaily, today);
  const mv = (n: string) => seedId(`${spec.persona}/stock/${n}`);
  const stockMovements: SeedStockMovement[] = [];
  for (const item of INVENTORY) {
    const used = (day: string) =>
      salesDaily
        .filter((s) => s.day === day)
        .reduce((sum, s) => sum + s.qty * (RECIPES.find((r) => r.menuSku === s.menuSku && r.inventorySku === item.sku)?.qtyPerUnit ?? 0), 0);
    const consumption = days.map(used);
    const dailyAvg = consumption.reduce((a, b) => a + b, 0) / 28;
    const n = needWithSafety[item.sku] ?? 0;
    const end = spec.endStock(item.sku, n + Math.ceil((n * item.safetyStockPct) / 100));
    if (end < 0) throw new Error(`seed ${spec.persona}: negative end stock for ${item.sku}`);
    // Walk back from the end stock: each Monday delivery (06:00, before the day's sales) tops the shelf up from
    // about one day of use, so the level is never negative and ends exactly at `end`.
    const receipts = days.map(() => 0);
    let level = end;
    for (let i = days.length - 1; i >= 0; i--) {
      level += consumption[i]!;
      if (i > 0 && weekdayOf(days[i]!) === 1) {
        receipts[i] = Math.max(0, level - Math.round(dailyAvg * jitter(`${spec.persona}/${item.sku}/${days[i]}`, 0.3)));
        level -= receipts[i]!;
      }
    }
    const opening = level;
    stockMovements.push({ id: mv(`${item.sku}/seed`), sku: item.sku, kind: "SEED", qty: opening, occurredAt: `${days[0]}T06:00:00.000Z`, ref: "seed" });
    days.forEach((day, i) => {
      if (receipts[i]! > 0) {
        stockMovements.push({ id: mv(`${item.sku}/receipt/${day}`), sku: item.sku, kind: "RECEIPT", qty: receipts[i]!, occurredAt: `${day}T06:00:00.000Z`, ref: `delivery ${day}` });
        level += receipts[i]!;
      }
      if (consumption[i]! > 0) {
        stockMovements.push({ id: mv(`${item.sku}/sale/${day}`), sku: item.sku, kind: "SALE", qty: -consumption[i]!, occurredAt: `${day}T12:00:00.000Z`, ref: `sales ${day}` });
        level -= consumption[i]!;
      }
      if (level < 0) throw new Error(`seed ${spec.persona}: stock of ${item.sku} below zero on ${day}`);
    });
    if (level !== end) throw new Error(`seed ${spec.persona}: ${item.sku} ends at ${level}, expected ${end}`);
  }

  const supplierItems = spec.supplierItems.map((si) => ({ ...si, id: seedId(`${spec.persona}/supplier-item/${si.supplierPayeeId}/${si.supplierSku}`) }));
  return { merchant: m, inventory: INVENTORY, recipes: RECIPES, supplierItems, salesDaily, stockMovements };
}

/** Supplier catalogs as merchant supplier_items (pack prices = mock-world SUPPLIERS catalog prices). */
export const SUPPLIER_PACKS = {
  a: [
    { supplierSku: "BOX-33CM-100", inventorySku: "BOX-33CM", packSize: 100, packPriceMinor: 1890000, minOrderPacks: 1 },
    { supplierSku: "DOUGH-250G-40", inventorySku: "DOUGH-BALL", packSize: 40, packPriceMinor: 1450000, minOrderPacks: 1 },
    { supplierSku: "MOZZ-2.5KG", inventorySku: "MOZZ-G", packSize: 2500, packPriceMinor: 690000, minOrderPacks: 2 },
    { supplierSku: "TOMATO-5KG", inventorySku: "TOMATO-G", packSize: 5000, packPriceMinor: 320000, minOrderPacks: 2 },
  ],
  b: [
    { supplierSku: "BOX-33CM-100", inventorySku: "BOX-33CM", packSize: 100, packPriceMinor: 1690000, minOrderPacks: 1 },
    { supplierSku: "DOUGH-250G-40", inventorySku: "DOUGH-BALL", packSize: 40, packPriceMinor: 1390000, minOrderPacks: 1 },
    { supplierSku: "MOZZ-2.5KG", inventorySku: "MOZZ-G", packSize: 2500, packPriceMinor: 720000, minOrderPacks: 1 },
    { supplierSku: "TOMATO-5KG", inventorySku: "TOMATO-G", packSize: 5000, packPriceMinor: 299000, minOrderPacks: 2 },
  ],
  c: [
    { supplierSku: "BOX-33CM-100", inventorySku: "BOX-33CM", packSize: 100, packPriceMinor: 18000, minOrderPacks: 1 },
    { supplierSku: "DOUGH-250G-40", inventorySku: "DOUGH-BALL", packSize: 40, packPriceMinor: 22000, minOrderPacks: 1 },
    { supplierSku: "MOZZ-2.5KG", inventorySku: "MOZZ-G", packSize: 2500, packPriceMinor: 16500, minOrderPacks: 1 },
    { supplierSku: "TOMATO-5KG", inventorySku: "TOMATO-G", packSize: 5000, packPriceMinor: 5800, minOrderPacks: 1 },
  ],
  d: [{ supplierSku: "BOX-33CM-100", inventorySku: "BOX-33CM", packSize: 100, packPriceMinor: 15000, minOrderPacks: 1 }],
} as const;

const packs = (key: keyof typeof SUPPLIER_PACKS, supplierPayeeId: string, currency: string, leadTimeDays: number) =>
  SUPPLIER_PACKS[key].map((p) => ({ ...p, supplierPayeeId, currency, leadTimeDays }));

/** Target box shortage of the Shanghai shop by the end of tomorrow. */
export const SHA_BOX_SHORTAGE = 400;

const pizzeriaBudBusiness = buildBusiness({
  persona: PIZZERIA_BUD_PERSONA,
  merchant: {
    id: BUSINESS_IDS.bud.merchant,
    slug: "bud",
    name: "Pizza Shop in Budapest",
    currency: "HUF",
    region: "EU",
    timezone: "Europe/Budapest",
    // HUF 400,000: well under the payments daily cap (PAYMENTS_DAILY_CAP_HOME_MINOR in HUF) and the owner's caps.
    poCapMinor: toMinor("400000", "HUF"),
  },
  pizzasByWeekday: [100, 60, 65, 70, 75, 120, 140],
  trend: -0.12,
  // Comfortable: about 3 days of (today + tomorrow) need on top, so no shortage, but sales and stock trend down.
  endStock: (_sku, n) => Math.round(n * 1.6),
  supplierItems: [...packs("a", BUSINESS_IDS.bud.payees.supplierA, "HUF", 1), ...packs("b", BUSINESS_IDS.bud.payees.supplierB, "HUF", 1)],
});

const pizzeriaShaBusiness = buildBusiness({
  persona: PIZZERIA_SHA_PERSONA,
  merchant: {
    id: BUSINESS_IDS.sha.merchant,
    slug: "sha",
    name: "Pizza Shop in Shanghai",
    currency: "CNY",
    region: "CN",
    timezone: "Asia/Shanghai",
    // CNY 5,000: a restock of boxes (CNY 180 per 100) and dough fits easily; under the daily cap in CNY.
    poCapMinor: toMinor("5000", "CNY"),
  },
  pizzasByWeekday: [480, 300, 320, 340, 360, 520, 600],
  trend: 0.08,
  // Boxes: exactly SHA_BOX_SHORTAGE short by the end of tomorrow. Everything else: covered.
  endStock: (sku, n) => (sku === "BOX-33CM" ? n - SHA_BOX_SHORTAGE : Math.round(n * 1.3)),
  supplierItems: [...packs("c", BUSINESS_IDS.sha.payees.supplierC, "CNY", 1), ...packs("d", BUSINESS_IDS.sha.payees.supplierD, "CNY", 1)],
});

/** Business owners: no incomes, no cards; caps sized for supplier orders in the home currency (EXAMPLE values). */
function businessProfile(userId: string, currency: string, caps: Record<keyof SeedCaps, string>, minBalance: string): SeedProfile & { caps: SeedCaps } {
  return {
    userId,
    incomes: [],
    notificationMode: "EACH",
    reserveRules: { protectObligationCategories: [], minBalances: [{ currency, amountMinor: toMinor(minBalance, currency) }] },
    caps: {
      perPaymentMinor: toMinor(caps.perPaymentMinor, currency),
      perDayMinor: toMinor(caps.perDayMinor, currency),
      perMonthMinor: toMinor(caps.perMonthMinor, currency),
      smallAutoMinor: toMinor(caps.smallAutoMinor, currency),
      reserveMinor: toMinor(caps.reserveMinor, currency),
    },
  };
}

function supplierPayee(id: string, userId: string, name: string, account: string, scheme: "IBAN" | "MERCHANT_ID", country: string, currency: string, verifiedAt: string | null, coolingUntil: string | null): SeedPayee {
  return {
    id,
    userId,
    name,
    kind: "SUPPLIER",
    account,
    accountScheme: scheme,
    bic: null,
    country,
    currency,
    status: verifiedAt ? "VERIFIED" : "COOLING",
    verifiedAt,
    coolingUntil,
    replacesPayeeId: null,
  };
}

/** Added an hour before SEED_NOW: still cooling (I7) through the demo's "+1 day". */
const ATTACKER_ADDED_COOLING_UNTIL = "2026-10-29T08:00:00.000Z";

const noRows = { cards: [] as SeedCard[], cardFeeProfiles: [] as SeedCardFeeProfile[], obligations: [] as SeedObligation[], budgets: [] as SeedBudget[], transactions: [] as SeedTransaction[] };

/** A BUSINESS persona: owner user + merchant data (inserted by apps/api demo/seed.ts). */
export const pizzeriaBud = {
  persona: PIZZERIA_BUD_PERSONA,
  accountType: "BUSINESS" as const,
  mockBankProfileId: 16_000_004,
  user: { id: BUSINESS_IDS.bud.user, displayName: "Pizza Shop in Budapest", homeCurrency: "HUF", region: "EU", preset: "SMART", moneyMode: "CAPPED_WALLET", frozenAt: null, createdAt: "2026-09-01T08:00:00.000Z" } satisfies SeedUser,
  profile: businessProfile(BUSINESS_IDS.bud.user, "HUF", { perPaymentMinor: "400000", perDayMinor: "600000", perMonthMinor: "3000000", smallAutoMinor: "5000", reserveMinor: "100000" }, "100000"),
  balances: [{ currency: "HUF", amountMinor: toMinor("2500000", "HUF") }] as SeedBalance[],
  ...noRows,
  payees: [
    supplierPayee(BUSINESS_IDS.bud.payees.supplierA, BUSINESS_IDS.bud.user, SUPPLIER_NAMES.a, ACCOUNTS.supplierA, "IBAN", "HU", "HUF", "2026-09-02T09:00:00.000Z", null),
    supplierPayee(BUSINESS_IDS.bud.payees.supplierB, BUSINESS_IDS.bud.user, SUPPLIER_NAMES.b, ACCOUNTS.supplierB, "IBAN", "HU", "HUF", null, ATTACKER_ADDED_COOLING_UNTIL),
  ],
  business: pizzeriaBudBusiness,
} as const;

export const pizzeriaSha = {
  persona: PIZZERIA_SHA_PERSONA,
  accountType: "BUSINESS" as const,
  mockBankProfileId: 16_000_005,
  // Region CN: Kassa never moves the money itself; supplier invoices are paid by QR HANDOFF (spec §11).
  user: { id: BUSINESS_IDS.sha.user, displayName: "Pizza Shop in Shanghai", homeCurrency: "CNY", region: "CN", preset: "SMART", moneyMode: "HANDOFF", frozenAt: null, createdAt: "2026-09-01T08:00:00.000Z" } satisfies SeedUser,
  profile: businessProfile(BUSINESS_IDS.sha.user, "CNY", { perPaymentMinor: "5000", perDayMinor: "8000", perMonthMinor: "60000", smallAutoMinor: "100", reserveMinor: "2000" }, "2000"),
  balances: [{ currency: "CNY", amountMinor: toMinor("40000", "CNY") }] as SeedBalance[],
  ...noRows,
  payees: [
    // QR-wallet merchants: the "account" is the normalised name the handoff check compares (like Dana's dorm office).
    supplierPayee(BUSINESS_IDS.sha.payees.supplierC, BUSINESS_IDS.sha.user, SUPPLIER_NAMES.c, SUPPLIER_NAMES.c.toLowerCase(), "MERCHANT_ID", "CN", "CNY", "2026-09-03T02:00:00.000Z", null),
    supplierPayee(BUSINESS_IDS.sha.payees.supplierD, BUSINESS_IDS.sha.user, SUPPLIER_NAMES.d, SUPPLIER_NAMES.d.toLowerCase(), "MERCHANT_ID", "CN", "CNY", null, ATTACKER_ADDED_COOLING_UNTIL),
  ],
  business: pizzeriaShaBusiness,
} as const;

/** Li Wei, region CN (Shanghai): the Shanghai pizzeria's customer, paying by QR handoff. */
export const liWeiCn = {
  persona: LI_WEI_CN_PERSONA,
  mockBankProfileId: 16_000_003,
  user: { id: BUSINESS_IDS.liWeiCn.user, displayName: "Li Wei", homeCurrency: "CNY", region: "CN", preset: "SMART", moneyMode: "HANDOFF", frozenAt: null, createdAt: "2026-09-18T08:00:00.000Z" } satisfies SeedUser,
  profile: {
    userId: BUSINESS_IDS.liWeiCn.user,
    incomes: [{ source: "Part-time job", currency: "CNY", amountMinor: toMinor("6000", "CNY"), cadence: "MONTHLY", dayOfMonth: 10, nextDate: "2026-11-10" }],
    notificationMode: "EACH",
    reserveRules: { protectObligationCategories: [], minBalances: [{ currency: "CNY", amountMinor: toMinor("1000", "CNY") }] },
    caps: {
      perPaymentMinor: toMinor("3000", "CNY"),
      perDayMinor: toMinor("5000", "CNY"),
      perMonthMinor: toMinor("20000", "CNY"),
      smallAutoMinor: toMinor("100", "CNY"),
      reserveMinor: toMinor("1000", "CNY"),
    },
  } satisfies SeedProfile & { caps: SeedCaps },
  balances: [{ currency: "CNY", amountMinor: toMinor("8000", "CNY") }] as SeedBalance[],
  cards: [] as SeedCard[],
  cardFeeProfiles: [] as SeedCardFeeProfile[],
  payees: [
    {
      id: BUSINESS_IDS.liWeiCn.payees.pizzaShopSh,
      userId: BUSINESS_IDS.liWeiCn.user,
      name: "Pizza Shop in Shanghai",
      kind: "MERCHANT",
      account: "pizza shop in shanghai",
      accountScheme: "MERCHANT_ID",
      bic: null,
      country: "CN",
      currency: "CNY",
      status: "VERIFIED",
      verifiedAt: "2026-10-01T04:00:00.000Z",
      coolingUntil: null,
      replacesPayeeId: null,
    },
  ] satisfies SeedPayee[],
  obligations: [] as SeedObligation[],
  budgets: [
    { id: BUSINESS_IDS.liWeiCn.budgets.eatingOut, userId: BUSINESS_IDS.liWeiCn.user, category: "eating_out", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: toMinor("800", "CNY") },
  ] satisfies SeedBudget[],
  transactions: [] as SeedTransaction[],
} as const;

export const seed = {
  seedNow: SEED_NOW,
  homeCurrency: HOME_CURRENCY,
  mockBankProfileId: MOCK_BANK_PROFILE_ID,
  fx: SEED_FX,
  user,
  profile,
  balances,
  cards,
  cardFeeProfiles,
  payees,
  obligations,
  mandates,
  budgets,
  transactions,
  /** Extra demo personas, inserted only with `seedDatabase(..., { personas: true })`. */
  personas: [liWei, liWeiCn, pizzeriaBud, pizzeriaSha],
} as const;

export default seed;
