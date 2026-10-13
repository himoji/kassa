import { CURRENCIES, currencyExponent, isKnownCurrency, type DataChoices, type OnboardingProfileDraft } from "@kassa/shared";

/*
 * Pickers the onboarding chat shows even when the model forgets its `ask`: every question in a reply that asks about
 * the preset ("how hands-on ..."), notifications, money mode, region or home currency gets the matching buttons, a
 * question that lists its own answers ("what's it for (dorm, phone, transit…)?") gets those as buttons, and a reply
 * that proposes monthly budgets ("groceries 150000, transport 30000, ...") gets one "amounts" card with a slider per
 * category. Topics only for fields the draft does not have yet, so a recap of known facts shows no buttons.
 */

type Opt = { id: string; label: string; spoken?: string[] };
type Topic = { id: string; test: RegExp; missing: (d: OnboardingProfileDraft) => boolean; prompt: string; options: Opt[] };

const TOPICS: Topic[] = [
  {
    id: "preset",
    test: /autopilot|ask[ -]me|\bsmart\b|\bpreset\b|hands[- ]on|hands[- ]off|on (its|my|your) own|how much (control|freedom|should|can)|how involved|autonom|without asking/i,
    missing: (d) => !d.preset,
    prompt: "How much should Kassa do on its own?",
    options: [
      { id: "ask_me", label: "Ask me", spoken: ["ask me", "ask", "ask_me", "always ask"] },
      { id: "smart", label: "Smart", spoken: ["smart"] },
      { id: "autopilot", label: "Autopilot", spoken: ["autopilot", "auto pilot", "auto"] },
    ],
  },
  {
    id: "notifications",
    test: /notif|digest|threshold|ping you|alert/i,
    missing: (d) => !d.notificationMode,
    prompt: "When should I notify you?",
    options: [
      { id: "each", label: "Each payment", spoken: ["each", "every payment", "all"] },
      { id: "thresholds", label: "Above thresholds", spoken: ["thresholds", "threshold", "big ones"] },
      { id: "digest", label: "Daily digest", spoken: ["digest", "daily", "once a day"] },
    ],
  },
  {
    id: "money_mode",
    test: /money mode|pay in place|capped wallet|hand-?off/i,
    missing: (d) => !d.moneyMode,
    prompt: "How should payments run?",
    options: [
      { id: "pay_in_place", label: "Pay in place", spoken: ["pay in place", "in place"] },
      { id: "capped_wallet", label: "Capped wallet", spoken: ["capped wallet", "wallet", "capped"] },
      { id: "handoff", label: "Handoff (I pay)", spoken: ["handoff", "hand off", "i pay"] },
    ],
  },
  {
    id: "region",
    test: /\bregion\b|\bEU\b|europe|china/i,
    missing: (d) => !d.region,
    prompt: "Where do you study?",
    options: [
      { id: "eu", label: "Europe", spoken: ["eu", "europe"] },
      { id: "cn", label: "China", spoken: ["cn", "china"] },
    ],
  },
];

const EMOJI: Record<string, string> = {
  groceries: "🛒",
  food: "🛒",
  eating_out: "🍽️",
  restaurants: "🍽️",
  dining: "🍽️",
  coffee: "☕",
  transport: "🚌",
  transportation: "🚌",
  travel: "✈️",
  rent: "🏠",
  housing: "🏠",
  tuition: "🎓",
  education: "🎓",
  books: "📚",
  insurance: "🛡️",
  utilities: "💡",
  phone: "📱",
  subscriptions: "📱",
  shopping: "🛍️",
  clothes: "👕",
  health: "💊",
  gym: "🏋️",
  sport: "🏋️",
  fun: "🎉",
  entertainment: "🎬",
  going_out: "🎉",
  gifts: "🎁",
  savings: "💰",
  other: "📦",
  misc: "📦",
};

/** Emoji for a budget category id (falls back to a coin). */
export function categoryEmoji(id: string): string {
  return EMOJI[id] ?? "🪙";
}

const STOP = /\b(your|goal|hit|about|around|total|income|salary|month|per|budget|budgets|idea|rough)\b/i;

function categoryId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/^and\s+/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function majorAmount(raw: string, k: boolean): number | null {
  let s = raw.replace(/\s/g, "");
  const dec = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  // The last separator is the decimal point unless exactly three digits follow it ("150,000", "150.000").
  if (dec >= 0 && s.length - dec - 1 !== 3) s = `${s.slice(0, dec).replace(/[.,]/g, "")}.${s.slice(dec + 1)}`;
  else s = s.replace(/[.,]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return k ? n * 1000 : n;
}

/** "groceries 150000, transport 30000, eating out 60k" → the category amounts a reply proposes (major units). */
export function budgetPairs(text: string): { id: string; label: string; amount: number }[] {
  const out: { id: string; label: string; amount: number }[] = [];
  const re = /(?:^[ \t]*[-•*]?|[,;:—–\n•*]|\s-\s|\band\b)[ \t]*([A-Za-z][A-Za-z &/]{1,24}?)\s*[:=–-]?\s*[₸$€¥]?\s*(\d[\d.,\s]*\d|\d)\s*(k\b)?(?:\s*(?:₸|KZT|EUR|USD|CNY|HUF|€|\$|¥|Ft))?(?=[ \t]*(?:[,;.?!\n)]|$|\band\b|\/\s*mo))/gim;
  for (const m of text.matchAll(re)) {
    const label = m[1]!.trim().replace(/^and\s+/i, "");
    if (STOP.test(label) || label.split(/\s+/).length > 3) continue;
    const amount = majorAmount(m[2]!, !!m[3]);
    const id = categoryId(label);
    if (amount === null || !id || out.some((o) => o.id === id)) continue;
    out.push({ id, label: label.charAt(0).toUpperCase() + label.slice(1), amount });
  }
  return out;
}

/** An "amounts" picker for budgets, from category amounts in major units of `currency`. */
export function budgetsPicker(id: string, prompt: string, currency: string, items: { id: string; label: string; emoji?: string | null | undefined; amount: number }[]): DataChoices | null {
  if (items.length === 0) return null;
  const scale = 10 ** currencyExponent(currency);
  return {
    id,
    kind: "amounts",
    prompt,
    options: [],
    amounts: {
      currency,
      items: items.slice(0, 12).map((i) => ({
        id: categoryId(i.id) || categoryId(i.label) || "other",
        label: i.label.slice(0, 60),
        emoji: i.emoji || categoryEmoji(categoryId(i.id)),
        defaultMinor: Math.round(i.amount * scale),
        minMinor: 0,
      })),
    },
  };
}

const CURRENCY_QUESTION = /home currency|which currency|what currency|currency (do|are|is|should)|in which currency/i;

const SYMBOLS: Record<string, string> = { "₸": "KZT", "€": "EUR", $: "USD", "¥": "CNY", "£": "GBP", "₽": "RUB", "₺": "TRY", "₹": "INR", "₩": "KRW", "₴": "UAH", "₾": "GEL", zł: "PLN", Kč: "CZK", Ft: "HUF" };
const DEFAULT_CURRENCIES = ["EUR", "USD"];
/** Demonyms the country names below do not cover by prefix or suffix. */
const DEMONYMS: Record<string, string> = { chinese: "CNY", british: "GBP", american: "USD", japanese: "JPY", korean: "KRW", turkish: "TRY", czech: "CZK", ukrainian: "UAH", russian: "RUB", swiss: "CHF", french: "EUR", spanish: "EUR", italian: "EUR", dutch: "EUR", german: "EUR", irish: "EUR", greek: "EUR", finnish: "EUR", swedish: "SEK", danish: "DKK", norwegian: "NOK", thai: "THB", vietnamese: "VND", filipino: "PHP", egyptian: "EGP" };

/** Lower-case currency names ("forint", "tenge", "euro") and country names ("hungary") → ISO codes. */
const NAMES: [string, string][] = CURRENCIES.flatMap((c) => [
  [c.name.toLowerCase(), c.code] as [string, string],
  ...c.countries.filter((n) => !/\(|_/.test(n)).map((n) => [n.toLowerCase(), c.code] as [string, string]),
]);

/**
 * Currencies the conversation points at, best first: ISO codes, symbols, currency and country names (and their
 * prefixes: "kazakh" → Kazakhstan → KZT) in what was said, then the draft's currencies.
 */
export function contextCurrencies(text: string, draft: OnboardingProfileDraft): string[] {
  const found: string[] = [];
  const add = (c: string) => {
    if (isKnownCurrency(c) && !found.includes(c)) found.push(c);
  };
  for (const m of text.matchAll(/\b[A-Z]{3}\b/g)) add(m[0]);
  for (const [sym, code] of Object.entries(SYMBOLS)) if (text.includes(sym)) add(code);
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  for (const w of words) {
    if (DEMONYMS[w]) {
      add(DEMONYMS[w]);
      continue;
    }
    if (w.length < 5) continue;
    // Exact names, prefixes ("kazakh" → kazakhstan) and short suffixes ("georgian" → georgia).
    const hit = NAMES.find(([name]) => name === w || name.startsWith(w) || (name.length >= 5 && w.startsWith(name) && w.length - name.length <= 3));
    if (hit) add(hit[1]);
  }
  for (const c of [...draft.incomes.map((i) => i.currency), ...draft.obligations.map((o) => o.currency), ...draft.cards.map((c) => c.billingCurrency)]) add(c);
  return found;
}

/** The home-currency picker: the currencies the context suggests (at least three, at most five), any other typed. */
export function currencyPicker(id: string, contextText: string, draft: OnboardingProfileDraft, prompt = "Your home currency?"): DataChoices {
  const codes = contextCurrencies(contextText, draft);
  for (const d of DEFAULT_CURRENCIES) if (codes.length < 3 && !codes.includes(d)) codes.push(d);
  return {
    id,
    kind: "choice",
    prompt,
    allowOther: true,
    otherKind: "currency",
    options: codes.slice(0, 5).map((code) => {
      const name = CURRENCIES.find((c) => c.code === code)?.name ?? code;
      return { id: code.toLowerCase(), label: `${code} · ${name}`.slice(0, 60), value: code, spoken: [code.toLowerCase(), name.toLowerCase()] };
    }),
  };
}

/** Sentences of a reply that ask something (markdown emphasis removed). */
export function questions(reply: string): string[] {
  return reply
    .replace(/\*\*|__/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((q) => q.trim())
    .filter((q) => q.endsWith("?") || /\?\s*\S{0,3}$/.test(q));
}

function slug(label: string): string {
  return categoryId(label).replace(/_/g, "-").slice(0, 32);
}

/** "What's it for (dorm, phone, transit…)?" / "... rent, tuition or insurance?" → the answers the question offers. */
export function inlineOptions(question: string): string[] {
  const paren = /\(([^()]{3,160})\)/.exec(question)?.[1];
  const listed = paren ?? /(?:[:—–]|\blike\b|\be\.g\.,?|\bsuch as\b)\s*([^:—–?]{3,160})\?/i.exec(question)?.[1];
  if (!listed) return [];
  const items = listed
    .replace(/\b(e\.g\.|etc\.?|for example|or something else|something else)/gi, "")
    .split(/,|;|\/|\bor\b/i)
    .map((x) => x.replace(/[…."'`]+/g, "").trim())
    .filter((x) => x.length > 1 && x.length <= 30 && x.split(/\s+/).length <= 3 && !/\d{2,}/.test(x));
  const unique = [...new Map(items.map((x) => [slug(x), x])).values()];
  return unique.length >= 2 && unique.length <= 8 ? unique : [];
}

function topicPicker(topic: Topic, id: string): DataChoices {
  return { id, kind: "choice", prompt: topic.prompt, options: topic.options.map((o) => ({ id: o.id, label: o.label, value: o.id, ...(o.spoken ? { spoken: o.spoken } : {}) })) };
}

/** Which fallback topic a picker or question is about ("currency", "preset", ..., or "list:<options>"). */
export function pickerTopic(part: Pick<DataChoices, "prompt" | "options">): string | null {
  const text = `${part.prompt} ${part.options.map((o) => o.label).join(" ")}`;
  if (CURRENCY_QUESTION.test(part.prompt) || part.options.filter((o) => isKnownCurrency(o.value.toUpperCase())).length >= 2) return "currency";
  return TOPICS.find((t) => t.test.test(text))?.id ?? null;
}

/**
 * The pickers this reply should carry besides the model's own `ask` (see the header comment): one per question,
 * at most two per turn, never a second picker for what the model's picker already asks.
 */
export function fallbackPickers(o: {
  reply: string;
  draft: OnboardingProfileDraft;
  /** What the user said so far (currency hints for the home-currency picker). */
  context: string;
  newId: () => string;
  modelPicker: DataChoices | null;
}): DataChoices[] {
  const { reply, draft } = o;
  const out: DataChoices[] = o.modelPicker ? [o.modelPicker] : [];
  const covered = new Set<string>();
  if (o.modelPicker) {
    const t = pickerTopic(o.modelPicker);
    if (t) covered.add(t);
    for (const opt of o.modelPicker.options) covered.add(`opt:${slug(opt.label)}`);
  }
  if (!o.modelPicker && draft.homeCurrency && /budget/i.test(reply)) {
    const pairs = budgetPairs(reply);
    const p = pairs.length >= 2 ? budgetsPicker(o.newId(), "Monthly budgets: slide to adjust, then confirm", draft.homeCurrency, pairs) : null;
    if (p) return [p];
  }
  for (const q of questions(reply)) {
    if (out.length >= 2) break;
    let part: DataChoices | null = null;
    let topic: string | null = null;
    if (!draft.homeCurrency && CURRENCY_QUESTION.test(q)) {
      topic = "currency";
      if (!covered.has(topic)) part = currencyPicker(o.newId(), `${o.context}\n${reply}`, draft);
    } else {
      const t = TOPICS.find((x) => x.missing(draft) && x.test.test(q));
      if (t) {
        topic = t.id;
        if (!covered.has(topic)) part = topicPicker(t, o.newId());
      } else {
        const items = inlineOptions(q);
        if (items.length && !items.some((x) => covered.has(`opt:${slug(x)}`))) {
          part = {
            id: o.newId(),
            kind: "choice",
            prompt: q.slice(0, 200),
            allowOther: true,
            options: items.map((x) => ({ id: slug(x) || "other", label: x.charAt(0).toUpperCase() + x.slice(1), value: x })),
          };
          for (const x of items) covered.add(`opt:${slug(x)}`);
        }
      }
    }
    if (topic) covered.add(topic);
    if (part) out.push(part);
  }
  return out;
}

/** The first picker this reply should carry when the model gave none (kept for callers that show one). */
export function fallbackPicker(reply: string, draft: OnboardingProfileDraft, id: string): DataChoices | null {
  return fallbackPickers({ reply, draft, context: "", newId: () => id, modelPicker: null })[0] ?? null;
}
