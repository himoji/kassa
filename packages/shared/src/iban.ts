/*
 * IBAN (ISO 13616-1) and structured creditor reference (ISO 11649) helpers. Both use the
 * ISO 7064 MOD 97-10 check: move the first four characters to the end, map letters A..Z to
 * 10..35, and the resulting integer mod 97 must equal 1. Pure JS (no BigInt needed: the mod is
 * computed over decimal chunks).
 */

/** ISO 13616 IBAN lengths for the countries Kassa's fixtures and payees use (SWIFT IBAN registry). */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AT: 20,
  BE: 16,
  CZ: 24,
  DE: 22,
  ES: 24,
  FR: 27,
  GB: 22,
  HU: 28,
  IT: 27,
  KZ: 20,
  NL: 18,
  PL: 28,
  SK: 24,
};

/** Upper-case and strip spaces (paper format uses groups of four, ISO 13616-1 §5). */
export function normalizeIban(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

/** ISO 7064 MOD 97-10 remainder of an alphanumeric string (letters A=10 .. Z=35). */
export function mod97(alnum: string): number {
  let remainder = 0;
  for (const ch of alnum) {
    const code = ch.charCodeAt(0);
    let digits: string;
    if (code >= 48 && code <= 57) digits = ch;
    else if (code >= 65 && code <= 90) digits = String(code - 55);
    else throw new RangeError(`mod97: invalid character ${JSON.stringify(ch)}`);
    for (const d of digits) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder;
}

/** The two IBAN check digits for a country code and BBAN. */
export function ibanCheckDigits(country: string, bban: string): string {
  const cd = 98 - mod97(`${normalizeIban(bban)}${country.toUpperCase()}00`);
  return String(cd).padStart(2, "0");
}

/** Build an IBAN (electronic format) from country + BBAN. */
export function buildIban(country: string, bban: string): string {
  const c = country.toUpperCase();
  return `${c}${ibanCheckDigits(c, bban)}${normalizeIban(bban)}`;
}

/** Structural + check-digit validation. Unknown countries are checked for 15..34 chars only. */
export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const expectedLength = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expectedLength !== undefined && iban.length !== expectedLength) return false;
  return mod97(iban.slice(4) + iban.slice(0, 4)) === 1;
}

/** Paper format: groups of four separated by spaces. */
export function formatIbanPrint(input: string): string {
  return normalizeIban(input).replace(/(.{4})(?=.)/g, "$1 ");
}

/** ISO 11649 structured creditor reference "RFcc<ref>" (ref: 1..21 alphanumerics). */
export function buildRfReference(reference: string): string {
  const ref = normalizeIban(reference);
  if (!/^[A-Z0-9]{1,21}$/.test(ref)) throw new RangeError("buildRfReference: 1..21 alphanumerics");
  const cd = 98 - mod97(`${ref}RF00`);
  return `RF${String(cd).padStart(2, "0")}${ref}`;
}

export function isValidRfReference(input: string): boolean {
  const ref = normalizeIban(input);
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(ref)) return false;
  return mod97(ref.slice(4) + ref.slice(0, 4)) === 1;
}
