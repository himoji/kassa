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

/** Currencies Kassa can actually pay out in (the bank rail's currencies). */
export const PAYEE_CURRENCIES: readonly string[] = SupportedCurrency.options;

const EURO_AREA = new Set("AT BE HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES".split(" "));

/** The currency a payee in this country is usually paid in, when Kassa can pay it; otherwise null (keep the choice). */
export function usualCurrency(country: string): string | null {
  if (EURO_AREA.has(country)) return "EUR";
  const local: Record<string, string> = { CN: "CNY", US: "USD", HU: "HUF", KZ: "KZT" };
  return local[country] ?? null;
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
