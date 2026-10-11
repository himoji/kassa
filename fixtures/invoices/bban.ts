import { buildIban } from "@kassa/shared";

/*
 * Fictitious IBAN builders with national BBAN check digits where the national standard defines a
 * simple one. IBAN check digits: ISO 13616 / ISO 7064 MOD 97-10 (via @kassa/shared buildIban).
 * None of these accounts belong to a real person or company.
 */

const W9731 = [9, 7, 3, 1];

/** Hungarian GIRO check digit: weights 9,7,3,1 repeating; the weighted sum must be ≡ 0 (mod 10). */
function huCheck(digits: string): string {
  let s = 0;
  for (let i = 0; i < digits.length; i++) s += Number(digits[i]) * W9731[i % 4]!;
  return String((10 - (s % 10)) % 10);
}

/** HU: bank(3) branch(4) check(1) account(15) check(1). */
export function huIban(bank: string, branch: string, account15: string): string {
  const head = bank + branch;
  return buildIban("HU", head + huCheck(head) + account15 + huCheck(account15));
}

/** DE: Bankleitzahl(8) + account(10). Account-level check methods vary per bank; not applied. */
export function deIban(blz: string, account10: string): string {
  return buildIban("DE", blz + account10);
}

/** AT: bank code(5) + account(11). */
export function atIban(bank: string, account11: string): string {
  return buildIban("AT", bank + account11);
}

/** NL: bank code (4 letters) + account(10). */
export function nlIban(bank: string, account10: string): string {
  return buildIban("NL", bank + account10);
}

/** KZ: bank code(3) + account(13 alphanumerics). */
export function kzIban(bank: string, account13: string): string {
  return buildIban("KZ", bank + account13);
}

/** FR: bank(5) branch(5) account(11 digits) + RIB key(2) = 97 − ((89·bank + 15·branch + 3·account) mod 97). */
export function frIban(bank: string, branch: string, account11: string): string {
  const key = 97 - ((89 * Number(bank) + 15 * Number(branch) + 3 * Number(account11)) % 97);
  return buildIban("FR", bank + branch + account11 + String(key).padStart(2, "0"));
}

const ES_W = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];
function esDigit(ten: string): string {
  let s = 0;
  for (let i = 0; i < 10; i++) s += Number(ten[i]) * ES_W[i]!;
  const d = 11 - (s % 11);
  return String(d === 11 ? 0 : d === 10 ? 1 : d);
}

/** ES: bank(4) branch(4) DC(2) account(10); DC per the Spanish CCC algorithm. */
export function esIban(bank: string, branch: string, account10: string): string {
  const dc = esDigit(`00${bank}${branch}`) + esDigit(account10);
  return buildIban("ES", bank + branch + dc + account10);
}
