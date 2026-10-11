/*
 * IBAN checks per ISO 13616-1 (structure, electronic format without spaces, upper case) and
 * ISO/IEC 7064 MOD 97-10 (check digits: rearranged numeric value mod 97 == 1).
 */
const IBAN_LENGTHS: Record<string, number> = {
  // ISO 13616 registry lengths for the countries Kassa's demo touches (+ common EU ones).
  AT: 20, BE: 16, CH: 21, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GR: 27,
  HR: 21, HU: 28, IE: 22, IT: 27, KZ: 20, LT: 20, LU: 20, LV: 21, NL: 18, NO: 15, PL: 28, PT: 25,
  RO: 24, SE: 24, SI: 19, SK: 24,
};

export function normalizeIban(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}

/** Looks like an IBAN (country code + 2 check digits + BBAN). */
export function looksLikeIban(input: string): boolean {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(normalizeIban(input));
}

export function mod97(numeric: string): number {
  let rem = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    rem = Number(String(rem) + numeric.slice(i, i + 7)) % 97;
  }
  return rem;
}

export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) return false;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return mod97(numeric) === 1;
}
