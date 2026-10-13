/*
 * Payee account details per payout scheme: what a sender must know to pay someone in the EU (SEPA, IBAN only since
 * Regulation (EU) 260/2012 dropped the BIC), in China (Alipay ID or a UnionPay card, the two CNY payout types Wise
 * offers) and in the US (ACH: ABA routing number + account number + checking/savings).
 *
 * On the wire and at rest a payee account stays ONE string (CreatePayeeRequest.account, AES-GCM in accountEnc, its
 * sha256 in accountHash), so encryption, hashing and the cooling period (I7) work unchanged for every scheme:
 *   IBAN         "DE89370400440532013000"            (plain electronic format, as before)
 *   CN_ALIPAY    "ALIPAY:li.wei@example.cn" | "ALIPAY:+8613800138000"
 *   CN_UNIONPAY  "UNIONPAY:6222020200112233445"
 *   US_ACH       "ACH:021000021:123456789:CHECKING"
 *   KASSA_USER   "KASSA:KSA-7QMX-2HVA"              (another Kassa user's wallet, paid inside the sandbox bank)
 * Anything else (a merchant id for a QR handoff, an account captured from a document) is OTHER and kept as typed.
 */
import { isValidIban, normalizeIban } from "./iban.ts";

export const PAYOUT_SCHEMES = ["IBAN", "CN_ALIPAY", "CN_UNIONPAY", "US_ACH", "KASSA_USER", "OTHER"] as const;
export type PayoutScheme = (typeof PAYOUT_SCHEMES)[number];

export type AchAccountType = "CHECKING" | "SAVINGS";

export type PayeeAccountFields =
  | { scheme: "IBAN"; iban: string }
  | { scheme: "CN_ALIPAY"; alipayId: string }
  | { scheme: "CN_UNIONPAY"; cardNumber: string }
  | { scheme: "US_ACH"; routingNumber: string; accountNumber: string; accountType: AchAccountType }
  | { scheme: "KASSA_USER"; kassaId: string }
  | { scheme: "OTHER"; value: string };

/** Which field is wrong and why, for inline form errors; the server answers with the same codes. */
export type PayeeAccountProblem =
  | { field: "iban"; code: "IBAN_INVALID" }
  | { field: "alipayId"; code: "ALIPAY_ID_INVALID" }
  | { field: "cardNumber"; code: "UNIONPAY_CARD_INVALID" }
  | { field: "routingNumber"; code: "ACH_ROUTING_INVALID" }
  | { field: "accountNumber"; code: "ACH_ACCOUNT_INVALID" }
  | { field: "kassaId"; code: "KASSA_ID_INVALID" }
  | { field: "value"; code: "ACCOUNT_TOO_SHORT" }
  | { field: "currency"; code: "SCHEME_CURRENCY_MISMATCH" };

const digitsOnly = (s: string) => s.replace(/[\s-]+/g, "");

/** Kassa ID alphabet: no 0/O, 1/I/L or U, so an ID read aloud or typed from a screen survives. */
export const KASSA_ID_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const KASSA_ID_RE = new RegExp(`^KSA-[${KASSA_ID_ALPHABET}]{4}-[${KASSA_ID_ALPHABET}]{4}$`);

/** "ksa 7qmx 2hva", "KSA7QMX2HVA" → "KSA-7QMX-2HVA"; null when it is not a Kassa ID. */
export function normalizeKassaId(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]+/g, "").replace(/^KSA/, "");
  if (raw.length !== 8) return null;
  const id = `KSA-${raw.slice(0, 4)}-${raw.slice(4)}`;
  return KASSA_ID_RE.test(id) ? id : null;
}

/** Luhn (ISO/IEC 7812-1 Annex B) check over a digit string. */
export function luhnOk(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** ABA routing transit number: 9 digits, weights 3-7-1 repeated, sum ≡ 0 (mod 10). */
export function abaRoutingOk(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = w.reduce((s, wi, i) => s + wi * (routing.charCodeAt(i) - 48), 0);
  return sum % 10 === 0;
}

/** An Alipay ID is the account's email or its mainland mobile number; phones are kept as +86 and 11 digits. */
function normalizeAlipayId(id: string): string | null {
  const t = id.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return t.toLowerCase();
  const d = t.replace(/[\s()-]+/g, "").replace(/^(\+?86|0086)/, "");
  return /^1[3-9]\d{9}$/.test(d) ? `+86${d}` : null;
}

/** The one canonical account string for these fields (what the API stores, hashes and the bank rail decodes). */
export function encodePayeeAccount(f: PayeeAccountFields): string {
  switch (f.scheme) {
    case "IBAN":
      return normalizeIban(f.iban);
    case "CN_ALIPAY":
      return `ALIPAY:${normalizeAlipayId(f.alipayId) ?? f.alipayId.trim()}`;
    case "CN_UNIONPAY":
      return `UNIONPAY:${digitsOnly(f.cardNumber)}`;
    case "US_ACH":
      return `ACH:${digitsOnly(f.routingNumber)}:${digitsOnly(f.accountNumber)}:${f.accountType}`;
    case "KASSA_USER":
      return `KASSA:${normalizeKassaId(f.kassaId) ?? f.kassaId.trim().toUpperCase()}`;
    case "OTHER":
      return f.value.trim();
  }
}

/** Reads an account string back into fields. Plain IBAN-looking strings are IBAN; unknown shapes are OTHER. */
export function decodePayeeAccount(account: string): PayeeAccountFields {
  const a = account.trim();
  const tagged = /^(ALIPAY|UNIONPAY|ACH|KASSA):(.*)$/i.exec(a);
  if (tagged) {
    const [, tag, rest = ""] = tagged;
    switch (tag!.toUpperCase()) {
      case "ALIPAY":
        return { scheme: "CN_ALIPAY", alipayId: rest };
      case "UNIONPAY":
        return { scheme: "CN_UNIONPAY", cardNumber: rest };
      case "KASSA":
        return { scheme: "KASSA_USER", kassaId: rest };
      case "ACH": {
        const [routingNumber = "", accountNumber = "", type = "CHECKING"] = rest.split(":");
        return { scheme: "US_ACH", routingNumber, accountNumber, accountType: type.toUpperCase() === "SAVINGS" ? "SAVINGS" : "CHECKING" };
      }
    }
  }
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(normalizeIban(a).replace(/-/g, ""))) return { scheme: "IBAN", iban: a };
  return { scheme: "OTHER", value: a };
}

/** Currencies each scheme pays out in (Wise payout types: iban, chinese_alipay, chinese_card, aba). */
const SCHEME_CURRENCIES: Record<Exclude<PayoutScheme, "OTHER" | "IBAN" | "KASSA_USER">, readonly string[]> = {
  CN_ALIPAY: ["CNY"],
  CN_UNIONPAY: ["CNY"],
  US_ACH: ["USD"],
};

/** Field-level validation. `currency`, when given, must be one the scheme can pay out in. */
export function validatePayeeAccount(f: PayeeAccountFields, currency?: string): PayeeAccountProblem | null {
  switch (f.scheme) {
    case "IBAN":
      if (!isValidIban(f.iban.replace(/-/g, ""))) return { field: "iban", code: "IBAN_INVALID" };
      if (currency === "CNY") return { field: "currency", code: "SCHEME_CURRENCY_MISMATCH" };
      return null;
    case "CN_ALIPAY":
      if (!normalizeAlipayId(f.alipayId)) return { field: "alipayId", code: "ALIPAY_ID_INVALID" };
      break;
    case "CN_UNIONPAY": {
      const d = digitsOnly(f.cardNumber);
      if (!/^62\d{14,17}$/.test(d) || !luhnOk(d)) return { field: "cardNumber", code: "UNIONPAY_CARD_INVALID" };
      break;
    }
    case "US_ACH":
      if (!abaRoutingOk(digitsOnly(f.routingNumber))) return { field: "routingNumber", code: "ACH_ROUTING_INVALID" };
      if (!/^\d{4,17}$/.test(digitsOnly(f.accountNumber))) return { field: "accountNumber", code: "ACH_ACCOUNT_INVALID" };
      break;
    case "KASSA_USER":
      // A Kassa wallet holds every currency Kassa supports; the server checks the currency against that list.
      return normalizeKassaId(f.kassaId) ? null : { field: "kassaId", code: "KASSA_ID_INVALID" };
    case "OTHER":
      return f.value.trim().length >= 4 ? null : { field: "value", code: "ACCOUNT_TOO_SHORT" };
  }
  if (currency && !SCHEME_CURRENCIES[f.scheme].includes(currency)) return { field: "currency", code: "SCHEME_CURRENCY_MISMATCH" };
  return null;
}

/**
 * The schemes that fit a payee's currency and country, most usual first. CNY: Alipay, then UnionPay card; USD to a US
 * account: ACH; everything else (EUR, HUF, KZT, …): IBAN. Another Kassa user's wallet works everywhere; OTHER is always
 * last (merchant ids, QR handoffs).
 */
export function payoutSchemesFor(country: string, currency: string): PayoutScheme[] {
  if (currency === "CNY") return ["CN_ALIPAY", "CN_UNIONPAY", "KASSA_USER", "OTHER"];
  if (currency === "USD" && country === "US") return ["US_ACH", "KASSA_USER", "OTHER"];
  return ["IBAN", "KASSA_USER", "OTHER"];
}

/** Canonical form for hashing and storage: a known scheme re-encoded, anything else stripped and upper-cased. */
export function normalizePayeeAccount(account: string): string {
  const f = decodePayeeAccount(account);
  if (f.scheme === "OTHER") return account.replace(/[\s-]+/g, "").toUpperCase();
  if (f.scheme === "IBAN") return normalizeIban(f.iban).replace(/-/g, "");
  return encodePayeeAccount(f);
}

const last4 = (s: string) => s.slice(-4);

/** What the app may show: the scheme and the last characters, never the whole account. */
export function maskPayeeAccount(account: string): string {
  const f = decodePayeeAccount(normalizePayeeAccount(account));
  switch (f.scheme) {
    case "IBAN": {
      const n = normalizeIban(f.iban);
      return `${n.slice(0, 2)} •••• ${last4(n)}`;
    }
    case "CN_ALIPAY": {
      const at = f.alipayId.indexOf("@");
      return at > 0 ? `Alipay ${f.alipayId[0]}•••${f.alipayId.slice(at)}` : `Alipay •••• ${last4(f.alipayId)}`;
    }
    case "CN_UNIONPAY":
      return `UnionPay •••• ${last4(f.cardNumber)}`;
    case "US_ACH":
      return `ACH •••• ${last4(f.accountNumber)}`;
    case "KASSA_USER":
      // A Kassa ID is a public handle (like a username), shown whole so the sender can check it.
      return `Kassa ${normalizeKassaId(f.kassaId) ?? f.kassaId}`;
    case "OTHER":
      return f.value.length <= 4 ? `•••• ${f.value}` : `•••• ${last4(f.value)}`;
  }
}
