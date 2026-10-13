import { currencyExponent, type DataChoices, type OnboardingProfileDraft } from "@kassa/shared";

/*
 * Pickers the onboarding chat shows even when the model forgets its `ask`: a reply that asks about the preset,
 * notifications, money mode, region or home currency gets the matching buttons, and a reply that proposes monthly
 * budgets ("groceries 150000, transport 30000, ...") gets one "amounts" card with a slider per category. Only for
 * fields the draft does not have yet, so a recap of known facts shows no buttons.
 */

type Opt = { id: string; label: string; spoken?: string[] };
type Topic = { test: RegExp; missing: (d: OnboardingProfileDraft) => boolean; prompt: string; options: Opt[] };

const TOPICS: Topic[] = [
  {
    test: /autopilot|ask[ -]me|\bsmart\b|\bpreset\b/i,
    missing: (d) => !d.preset,
    prompt: "How much should Kassa do on its own?",
    options: [
      { id: "ask_me", label: "Ask me", spoken: ["ask me", "ask", "ask_me", "always ask"] },
      { id: "smart", label: "Smart", spoken: ["smart"] },
      { id: "autopilot", label: "Autopilot", spoken: ["autopilot", "auto pilot", "auto"] },
    ],
  },
  {
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
    test: /\bregion\b|\bEU\b|europe|china/i,
    missing: (d) => !d.region,
    prompt: "Where do you study?",
    options: [
      { id: "eu", label: "Europe", spoken: ["eu", "europe"] },
      { id: "cn", label: "China", spoken: ["cn", "china"] },
    ],
  },
  {
    test: /home currency|which currency|what currency/i,
    missing: (d) => !d.homeCurrency,
    prompt: "Your home currency?",
    options: [
      { id: "kzt", label: "KZT ₸", spoken: ["kzt", "tenge", "₸"] },
      { id: "eur", label: "EUR €", spoken: ["eur", "euro", "euros", "€"] },
      { id: "usd", label: "USD $", spoken: ["usd", "dollar", "dollars", "$"] },
      { id: "cny", label: "CNY ¥", spoken: ["cny", "yuan", "rmb", "¥"] },
      { id: "huf", label: "HUF Ft", spoken: ["huf", "forint", "ft"] },
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

function lastQuestion(reply: string): string {
  const qs = reply.split(/(?<=[.!?\n])\s+/).filter((s) => s.includes("?"));
  return qs.at(-1) ?? reply;
}

/** The picker this reply should carry when the model gave none (see the header comment), or null. */
export function fallbackPicker(reply: string, draft: OnboardingProfileDraft, id: string): DataChoices | null {
  if (draft.homeCurrency && /budget/i.test(reply)) {
    const pairs = budgetPairs(reply);
    if (pairs.length >= 2) return budgetsPicker(id, "Monthly budgets: slide to adjust, then confirm", draft.homeCurrency, pairs);
  }
  for (const scope of [lastQuestion(reply), reply]) {
    const topic = TOPICS.find((t) => t.missing(draft) && t.test.test(scope));
    if (topic) return { id, kind: "choice", prompt: topic.prompt, options: topic.options.map((o) => ({ id: o.id, label: o.label, value: o.id, ...(o.spoken ? { spoken: o.spoken } : {}) })) };
  }
  return null;
}
