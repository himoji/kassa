import { z } from "zod";

import { parseShortcut } from "./shortcut.ts";
import type { ParsedEvent, ParserFormat } from "./types.ts";

/*
 * Android wallet notifications, forwarded to POST /capture/shortcut by an automation app (MacroDroid, Tasker, Samsung
 * Modes & Routines + a webhook) with the same device token as the iOS Shortcut: `{ app, title, text }`.
 *  - Google Wallet (com.google.android.apps.walletnfcrel), one per tap:  title "Cafe Frei", text "€4.50 with Visa ••1234"
 *    (older Google Pay builds: "Paid €4.50 with Mastercard •••• 1234").
 *  - Samsung Wallet / Pay (com.samsung.android.spay): title "Samsung Wallet", text "Payment of ₸2 500 at Magnum completed"
 *    or "You paid $4.50 to Starbucks with card ending 1234".
 * The amount text goes through the iOS Shortcut amount rules (same locales, same "unknown currency → not logged").
 * Alipay, WeChat Pay and bank apps forwarded the same way go to the text parsers (alipay.ts, wechat.ts, kzBank.ts).
 */

export const ForwardedNotification = z.object({
  /** Package name or app label of the app that posted the notification, when the forwarder knows it. */
  app: z.string().max(120).optional(),
  title: z.string().max(300).optional(),
  text: z.string().min(1).max(2000),
});
export type ForwardedNotification = z.infer<typeof ForwardedNotification>;

const GOOGLE = /google|walletnfcrel|com\.google\.android\.apps\.nbu\.paisa/i;
const SAMSUNG = /samsung|spay/i;

/** First amount with a currency marker before or after the number ("€4.50", "4,50 €", "₸2 500", "HUF 1,290"). */
const AMOUNT =
  /-?\s?(?:US\$|CN¥|CN￥|[€$£¥￥₸]|\b(?:KZT|EUR|HUF|USD|CNY|RMB|GBP)\b)\s?-?\d[\d\u00a0\u202f\u2009 ,.']*|-?\d[\d\u00a0\u202f\u2009 ,.']*\s?(?:Ft\b|€|₸|тг|元|\b(?:KZT|EUR|HUF|USD|CNY|RMB)\b)/i;
const MERCHANT_AT = /\b(?:at|to)\s+(.+?)(?:\s+(?:with|using|on|via|was|has been|completed|is)\b|[.,!\n]|$)/i;
const CARD = /(?:••+|•|\*{2,}|·{2,}|ending(?:\s+in)?|x{2,})\s*(\d{4})\b/i;
/** App names as notification titles: not a merchant. */
const APP_TITLE = /^(google (wallet|pay)|samsung (wallet|pay)|wallet|payment|paid|payment (complete|successful))$/i;

function walletFormat(n: ForwardedNotification): ParserFormat | null {
  const hint = `${n.app ?? ""} ${n.title ?? ""} ${n.text}`;
  if (GOOGLE.test(n.app ?? "") || /google (wallet|pay)/i.test(hint)) return "GOOGLE_WALLET";
  if (SAMSUNG.test(n.app ?? "") || /samsung (wallet|pay)/i.test(hint)) return "SAMSUNG_WALLET";
  return null;
}

/** A Google / Samsung Wallet tap; null when the notification is not one (or has no amount Kassa can read). */
export function parseWalletNotification(n: ForwardedNotification, fallbackCurrency?: string): ParsedEvent | null {
  const format = walletFormat(n);
  if (!format) return null;
  const text = n.text.trim();
  const amount = AMOUNT.exec(text)?.[0]?.trim().replace(/[\s.,']+$/, "");
  if (!amount) return null;
  const title = n.title?.trim() ?? "";
  const merchant = MERCHANT_AT.exec(text)?.[1]?.trim() ?? (title && !APP_TITLE.test(title) ? title : "");
  const card = CARD.exec(text)?.[1];
  const ev = parseShortcut({ merchant, amount, ...(card ? { card } : {}) }, fallbackCurrency);
  if (!ev) return null;
  return { ...ev, format, kind: /\brefund/i.test(text) ? "REFUND" : ev.kind };
}
