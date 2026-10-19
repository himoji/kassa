import { z } from "zod";

import type { PlaceJson } from "../../db/schema.ts";

/*
 * Where a tap happened and which place it most likely was (the payment notification's "when · where · what").
 *  - `PlaceHint`: optional location fields the iOS Shortcut (Get Current Location → Get Details of Locations) or an
 *    Android forwarder can add to the capture body. All optional; old Shortcuts keep working unchanged.
 *  - `cleanMerchant`: card statements print the payment processor in front of the shop ("SQ *BLUE BOTTLE",
 *    "SUMUP *CAFE FREI", "ZETTLE_*BISTRO"); the shop is what people recognise, so the processor is moved aside.
 *  - `PlaceJson`: what is kept on the transaction. Coordinates are rounded to 3 decimals (about 100 m): enough to
 *    tell two shops apart, not enough to track a person to a doorstep (data minimisation, docs/security/privacy.md).
 * Location text is untrusted like any other capture text: it is shown and stored, never followed.
 */

const coord = (min: number, max: number) =>
  z
    .union([z.number(), z.string().max(32)])
    .transform((v) => (typeof v === "number" ? v : Number(v.trim().replace(",", "."))))
    .pipe(z.number().min(min).max(max));

/** Text fields: iOS fills an empty string when it has no value; that is treated as absent. */
const text = (max: number) =>
  z
    .string()
    .max(max * 2)
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .transform((s) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max))
    .optional();

export const PlaceHint = z.object({
  street: text(120),
  city: text(80),
  /** Country name ("Hungary") or ISO 3166-1 alpha-2 code ("HU"); iOS prints the name in the phone's language. */
  country: text(60),
  latitude: coord(-90, 90).optional().catch(undefined),
  longitude: coord(-180, 180).optional().catch(undefined),
});
export type PlaceHint = z.infer<typeof PlaceHint>;

export type { PlaceJson };
export type PlaceSource = NonNullable<PlaceJson["source"]>;

/** Processor prefixes seen on card statements and wallet notifications, longest first within a family. */
const PROCESSORS: Array<[RegExp, string]> = [
  [/^sq\s*\*\s*/i, "Square"],
  [/^sumup\s*\*\s*/i, "SumUp"],
  [/^(?:izettle|zettle)[_\s]*\*\s*/i, "Zettle"],
  [/^iz\s*\*\s*/i, "Zettle"],
  [/^paypal\s*\*\s*/i, "PayPal"],
  [/^pp\s*\*\s*/i, "PayPal"],
  [/^tst\s*\*\s*/i, "Toast"],
  [/^sp\s*\*\s*/i, "Shopify"],
  [/^mypos\s*\*\s*/i, "myPOS"],
  [/^stripe\s*\*\s*/i, "Stripe"],
  [/^payu\s*\*\s*/i, "PayU"],
  [/^cko\s*\*\s*/i, "Checkout.com"],
  [/^dnh\s*\*\s*/i, "GoDaddy"],
  [/^google\s*\*\s*/i, "Google"],
  [/^apple\.com\/bill\b/i, "Apple"],
];

const SMALL_WORDS = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "the", "to"]);

function titleCase(s: string): string {
  if (/\p{Ll}/u.test(s) || !/\p{Lu}/u.test(s)) return s;
  return s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

/**
 * "SQ *BLUE BOTTLE 0412" → { name: "Blue Bottle", processor: "Square" }. Store numbers ("#12", "0412") and "*" are
 * dropped; a name with no processor is only title-cased when it was printed in capitals.
 */
/** A trailing upper-case country code after a name of its own ("SPAR HU", "ZARA KZ"). */
const TRAILING_COUNTRY = /(?<=\S)\s+(?:HU|KZ|DE|AT|GB|UK|US|FR|IT|ES|NL|PL|CZ|SK|RO|HR|SI|RS|UA|TR|CN|HK|SG|JP|KR|AE|UZ|KG|RU|GE|AM|AZ|IE|PT|BE|CH|SE|NO|DK|FI|LT|LV|EE|BG|GR|CA|AU)$/;

export function cleanMerchant(raw: string): { name: string; processor: string | null } {
  let s = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  let processor: string | null = null;
  for (const [re, label] of PROCESSORS) {
    if (re.test(s)) {
      const rest = s.replace(re, "").trim();
      if (rest) {
        s = rest;
        processor = label;
      }
      break;
    }
  }
  s = s
    .replace(/\s+(?:#\d+|\d{4,})$/, "")
    // Card networks append the country ("MUNKARUHASHOP HU"); it is not part of the name.
    .replace(TRAILING_COUNTRY, "")
    .replace(/[*_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { name: titleCase(s || raw.trim()), processor };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The place kept on a transaction, from the capture's location fields and what the parser read. */
export function placeFrom(
  hint: PlaceHint | undefined,
  parsed: { city?: string; country?: string } | undefined,
  name: { name?: string; kind?: string; source?: PlaceSource; processor?: string | null },
): PlaceJson | null {
  const p: PlaceJson = {};
  if (name.name) p.name = name.name;
  if (name.kind) p.kind = name.kind;
  if (name.source) p.source = name.source;
  if (name.processor) p.processor = name.processor;
  const street = hint?.street;
  const city = hint?.city || parsed?.city;
  const country = hint?.country || parsed?.country;
  if (street) p.street = street;
  if (city) p.city = city;
  if (country) p.country = country;
  if (hint?.latitude !== undefined && hint.longitude !== undefined) {
    p.lat = round3(hint.latitude);
    p.lon = round3(hint.longitude);
  }
  return Object.keys(p).length ? p : null;
}

/** "Váci utca, Budapest", "Budapest", "Hungary"; null when nothing is known. */
export function whereLabel(p: PlaceJson | null | undefined): string | null {
  if (!p) return null;
  const parts = [p.street, p.city].filter((x): x is string => !!x);
  if (parts.length === 0 && p.country) parts.push(p.country);
  return parts.length ? parts.join(", ") : null;
}

/** Shorter form for the in-app notification: the city, else the country. */
export function cityLabel(p: PlaceJson | null | undefined): string | null {
  return p?.city ?? p?.country ?? null;
}
