/*
 * Seed data for the demo user Dana (spec §18). Pure data: no I/O, deterministic. Track A's
 * apps/api/scripts/seed.ts inserts it; apps/mock-world reads balances and payee accounts from it.
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

type CardKey = keyof typeof IDS.cards | null;

/** [n, occurredAt, source, merchantRaw, merchantNorm, mcc, amount (major, decimal string), currency, card, category, flags] */
type Row = [
  number,
  string,
  TransactionSource,
  string,
  string,
  string | null,
  string,
  string,
  CardKey,
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

const CARD_BILLING: Record<string, string> = Object.fromEntries(cards.map((c) => [c.id, c.billingCurrency]));

function rateToHome(currency: string): string {
  return crossRate(SEED_FX.rates, currency, HOME_CURRENCY, 6);
}

function buildTransaction(row: Row): SeedTransaction {
  const [n, at, source, merchantRaw, merchantNorm, mcc, amount, currency, cardKey, category, flags] = row;
  const occurredAt = new Date(at).toISOString();
  const amountMinor = toMinor(amount, currency);
  const cardId = cardKey === null ? null : IDS.cards[cardKey];
  const homeAmountMinor = convertMinor(amountMinor, currency, HOME_CURRENCY, rateToHome(currency));

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
      const billing = CARD_BILLING[cardId]!;
      const markup = billing === currency ? 0 : (CARD_MARKUP_BPS[cardId]?.[currency] ?? 0);
      settledCurrency = billing;
      settledAmountMinor = convertMinor(amountMinor, currency, billing, crossRate(SEED_FX.rates, currency, billing, 10), {
        markupBps: markup,
      });
      const settledHome = convertMinor(settledAmountMinor, billing, HOME_CURRENCY, rateToHome(billing));
      feeHomeMinor = settledHome - homeAmountMinor; // spec §12: feeHome = settledHome − amount × mid
    }
  }
  const tenMinuteBucket = Math.floor(Date.parse(occurredAt) / 600_000);
  return {
    id: seedId(`txn/${String(n).padStart(2, "0")}`),
    userId: IDS.user,
    source,
    occurredAt,
    merchantRaw,
    merchantNorm,
    mcc,
    amountMinor,
    currency,
    cardId,
    homeAmountMinor,
    rateUsed: rateToHome(currency),
    // Example rates are applied as if published on the purchase date (labelled example values).
    rateDate: occurredAt.slice(0, 10),
    settledAmountMinor,
    settledCurrency,
    feeHomeMinor,
    category,
    dedupeKey: `${IDS.user}|${amountMinor}|${currency}|${merchantNorm}|${tenMinuteBucket}`,
    mergedIntoId: flags?.mergedInto ? seedId(`txn/${String(flags.mergedInto).padStart(2, "0")}`) : null,
    status: flags?.pending ? "PENDING" : "SETTLED",
  };
}

export const transactions: SeedTransaction[] = ROWS.map(buildTransaction);

/** Card fee profiles derived from the settled seed transactions (EXAMPLE values). */
export const cardFeeProfiles: SeedCardFeeProfile[] = Object.entries(CARD_MARKUP_BPS).flatMap(([cardId, byCurrency]) =>
  Object.entries(byCurrency).map(([fromCurrency, bps]) => ({
    cardId,
    fromCurrency,
    toCurrency: CARD_BILLING[cardId]!,
    medianMarkupBps: CARD_BILLING[cardId] === fromCurrency ? 0 : bps,
    fixedFeeMinor: 0,
    samples: transactions.filter(
      (t) => t.cardId === cardId && t.currency === fromCurrency && t.status === "SETTLED" && t.mergedIntoId === null,
    ).length,
    exampleValues: true as const,
  })),
);

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
} as const;

export default seed;
