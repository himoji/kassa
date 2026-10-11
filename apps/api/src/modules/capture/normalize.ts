/*
 * Merchant normalisation (spec §13 step 3): lower case, strip legal suffixes and city. Also strips
 * trailing store numbers and ISO 3166-1 alpha-2 country codes printed after the name, and anything after
 * the first comma (bank formats print "MERCHANT, CITY, CC"). CJK names keep their characters (incl.
 * parentheses), only company-form suffixes (有限公司…) are removed.
 */

const LEGAL_SUFFIXES = new Set([
  "kft", "zrt", "nyrt", "bt", "kkt", "llc", "ltd", "limited", "inc", "corp", "co", "gmbh", "ag", "sa", "sas", "srl",
  "spa", "bv", "nv", "plc", "oy", "ab", "as", "sro", "too", "тоо", "ао", "ип", "ооо", "llp",
]);

const CITIES = new Set([
  "budapest", "bp", "debrecen", "szeged", "pecs", "győr", "gyor", "almaty", "astana", "nur-sultan", "shymkent",
  "karaganda", "shanghai", "beijing", "shenzhen", "guangzhou", "vienna", "wien", "berlin", "london", "paris",
  "prague", "praha", "warsaw", "warszawa",
]);

const COUNTRY_CODES = new Set(["hu", "kz", "cn", "at", "de", "gb", "uk", "fr", "cz", "pl", "sk", "eu", "us"]);

const CJK_SUFFIX = /(股份有限公司|有限责任公司|有限公司|集团)$/;

export function normalizeMerchant(raw: string): string {
  let s = raw.normalize("NFKC").trim();
  const comma = s.indexOf(",");
  if (comma > 0) s = s.slice(0, comma);
  s = s.toLowerCase().replace(CJK_SUFFIX, "");
  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}(]+|[^\p{L}\p{N})]+$/gu, ""))
    .filter(Boolean);
  // Strip from the end: legal suffixes, cities, country codes, store numbers ("0412", "#12").
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (LEGAL_SUFFIXES.has(last) || CITIES.has(last) || COUNTRY_CODES.has(last) || /^#?\d{1,6}$/.test(last)) tokens.pop();
    else break;
  }
  return tokens.join(" ").trim();
}
