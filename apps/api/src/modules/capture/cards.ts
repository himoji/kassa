import type { CardKind } from "@kassa/shared";

import { cards } from "../../db/schema.ts";
import type { DbOrTx } from "../../db/client.ts";
import { notify } from "../notifications/service.ts";

/*
 * Cards learned from taps. The iOS Shortcut sends Wallet's "Card or Pass" name ("Revolut", "Visa ••1234"), Android
 * wallets and bank texts print the last 4 digits. When a tap names a card the user has not added, Kassa adds it
 * itself instead of dropping the hint, so the purchase, the fee x-ray and the card list know which card paid.
 * Deterministic on purpose: the card's name and last 4 digits are printed on the tap, so no model is needed (or sent
 * card details). Only the billing currency is not printed: it is assumed to be the home currency, or the spend's
 * currency for a multi-currency account (Revolut, Wise), and the notification says so; settlements later measure
 * the real markup. Adding a card loosens nothing (cards only label spending), so no passkey (I8).
 */

const MULTI = /revolut|wise|n26|monzo|multi[- ]?currency|payoneer|paysera/i;

const KIND_FOR_HOME: Record<string, CardKind> = { KZT: "HOME_KZT", HUF: "LOCAL_HUF", USD: "USD" };

/** "Visa ••1234" → { label: "Visa", last4: "1234" }; "Revolut" → { label: "Revolut", last4: "" }; null for junk. */
export function cardFromHint(hint: string): { label: string; last4: string } | null {
  const h = hint.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!h || h.length > 80) return null;
  const digits = /(\d{4})(?!.*\d)/.exec(h)?.[1] ?? "";
  const label = h
    .replace(/(?:••+|•|\*{2,}|·{2,}|x{2,}|ending(?:\s+in)?)?\s*\d{4,}\s*$/i, "")
    .replace(/[\s•·*-]+$/, "")
    .trim()
    .slice(0, 40);
  if (!label && !digits) return null;
  return { label: label || "Card", last4: digits };
}

export async function learnCard(
  db: DbOrTx,
  userId: string,
  hint: string,
  spend: { currency: string; homeCurrency: string },
): Promise<typeof cards.$inferSelect | null> {
  const c = cardFromHint(hint);
  if (!c) return null;
  const multi = MULTI.test(c.label);
  const billingCurrency = multi ? spend.currency : spend.homeCurrency;
  const kind: CardKind = multi ? "MULTI" : (KIND_FOR_HOME[spend.homeCurrency] ?? "MULTI");
  const row = (await db.insert(cards).values({ userId, label: c.label, last4: c.last4, billingCurrency, kind }).returning())[0]!;
  const name = c.last4 ? `${c.label} ••${c.last4}` : c.label;
  await notify(
    userId,
    {
      kind: "CARD_LEARNED",
      title: `New card: ${name}`,
      body: `Kassa saw ${name} pay for the first time and added it to your cards, billed in ${billingCurrency}. If it is billed in another currency, remove it in Cards and add it with the right one.`,
      data: { cardId: row.id, label: c.label, last4: c.last4, billingCurrency },
    },
    db,
  );
  return row;
}
