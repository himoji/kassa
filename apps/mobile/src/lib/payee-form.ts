/**
 * The add-payee form's logic, kept out of the component so it can be tested: which payout schemes fit a country and
 * currency, the usual currency of a country, and the typed fields → one account string (shared/payeeAccount.ts).
 */
import {
  encodePayeeAccount,
  payoutSchemesFor,
  SupportedCurrency,
  validatePayeeAccount,
  type AchAccountType,
  type PayeeAccountFields,
  type PayeeAccountProblem,
  type PayoutScheme,
} from "@kassa/shared";

import { countryName } from "@/lib/countries";

/** Currencies Kassa can actually pay out in (the bank rail's currencies). */
export const PAYEE_CURRENCIES: readonly string[] = SupportedCurrency.options;

const EURO_AREA = new Set("AT BE HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES".split(" "));

/** Local currencies of the other countries that use IBANs (Europe and around), for the IBAN country guess. */
const IBAN_LOCAL: Record<string, string> = {
  AD: "EUR",
  MC: "EUR",
  SM: "EUR",
  VA: "EUR",
  ME: "EUR",
  XK: "EUR",
  GB: "GBP",
  PL: "PLN",
  CZ: "CZK",
  CH: "CHF",
  LI: "CHF",
  SE: "SEK",
  DK: "DKK",
  NO: "NOK",
  IS: "ISK",
  RO: "RON",
  BG: "BGN",
  RS: "RSD",
  BA: "BAM",
  MK: "MKD",
  AL: "ALL",
  MD: "MDL",
  UA: "UAH",
  GE: "GEL",
  AZ: "AZN",
  TR: "TRY",
  AE: "AED",
  SA: "SAR",
  QA: "QAR",
  IL: "ILS",
  GI: "GIP",
};

/** The currency a payee in this country is usually paid in, when Kassa can pay it; otherwise null (keep the choice). */
export function usualCurrency(country: string): string | null {
  if (EURO_AREA.has(country)) return "EUR";
  const local: Record<string, string> = {
    CN: "CNY",
    US: "USD",
    HU: "HUF",
    KZ: "KZT",
    ...IBAN_LOCAL,
  };
  const usual = local[country];
  return usual && PAYEE_CURRENCIES.includes(usual) ? usual : null;
}

/** The country an IBAN belongs to: its first two letters, once they are a real country code (HU… → "HU"). */
export function ibanCountry(iban: string): string | null {
  const prefix = iban
    .replace(/[\s-]+/g, "")
    .slice(0, 2)
    .toUpperCase();
  return /^[A-Z]{2}$/.test(prefix) && countryName(prefix) ? prefix : null;
}

/** Everything the form holds; only the fields of the chosen scheme are used. */
export interface PayeeFormFields {
  scheme: PayoutScheme;
  iban: string;
  alipayId: string;
  cardNumber: string;
  routingNumber: string;
  accountNumber: string;
  accountType: AchAccountType;
  kassaId: string;
  other: string;
}

export const EMPTY_PAYEE_FIELDS: PayeeFormFields = {
  scheme: "IBAN",
  iban: "",
  alipayId: "",
  cardNumber: "",
  routingNumber: "",
  accountNumber: "",
  accountType: "CHECKING",
  kassaId: "",
  other: "",
};

export function accountFields(f: PayeeFormFields): PayeeAccountFields {
  switch (f.scheme) {
    case "IBAN":
      return { scheme: "IBAN", iban: f.iban };
    case "CN_ALIPAY":
      return { scheme: "CN_ALIPAY", alipayId: f.alipayId };
    case "CN_UNIONPAY":
      return { scheme: "CN_UNIONPAY", cardNumber: f.cardNumber };
    case "US_ACH":
      return {
        scheme: "US_ACH",
        routingNumber: f.routingNumber,
        accountNumber: f.accountNumber,
        accountType: f.accountType,
      };
    case "KASSA_USER":
      return { scheme: "KASSA_USER", kassaId: f.kassaId };
    case "OTHER":
      return { scheme: "OTHER", value: f.other };
  }
}

/** The schemes to offer; the chosen one stays if it still fits, else the first that does. */
export function schemesAndChoice(
  country: string,
  currency: string,
  current: PayoutScheme
): { schemes: PayoutScheme[]; scheme: PayoutScheme } {
  const schemes = payoutSchemesFor(country, currency);
  return { schemes, scheme: schemes.includes(current) ? current : schemes[0]! };
}

export type PayeeFormCheck =
  { ok: true; account: string } | { ok: false; problem: PayeeAccountProblem };

/** Validates the chosen scheme's fields against the currency and encodes them for POST /payees. */
export function checkPayeeForm(f: PayeeFormFields, currency: string): PayeeFormCheck {
  const fields = accountFields(f);
  const problem = validatePayeeAccount(fields, currency);
  return problem ? { ok: false, problem } : { ok: true, account: encodePayeeAccount(fields) };
}
