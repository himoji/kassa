/*
 * (added 2026-10-19) The payment reference a bank transfer (or a QR payment request) carries to the recipient.
 *
 * A judge paid tuition and the school never matched it: the reference was the first 35 characters of the order's
 * purpose, which the planner wrote ("Tuition term fee RF43RUB2026F042171B6409 · …"), so the 23-character invoice
 * reference of a judge copy was cut to "…RF43RUB2026F042171" and the invoice stayed open. The reference is now built
 * from structured data first, each part whole or not at all, and free text only fills what space is left:
 *
 *   1. the linked bill's own reference (obligations.reference, e.g. the invoice's ISO 11649 RF reference), through the
 *      obligation the signed order names (obligationId), owned by the order's user and paid to the order's payee;
 *   2. ISO 11649 creditor references written in the signed purpose, only when their check digits are valid (a typo or
 *      a cut one is never promoted);
 *   3. the identifier the recipient files payments under, from the payee's own details: the student ID (tuition),
 *      the rent reference, the biller's reference or customer number;
 *   4. the rest of the purpose, without the parts already sent, cut at a word boundary.
 *
 * The bank limit is 35 characters (Wise's reference field on most routes; SEPA's structured reference fits in it).
 * A structured part longer than the whole limit is the only thing ever cut, and only when it is the first part.
 */
import { isValidRfReference, orderObligation, type CanonicalOrder, type RecipientDetails } from "@kassa/shared";
import { and, eq } from "drizzle-orm";

import type { DbOrTx } from "../../db/client.ts";
import { obligations, payees } from "../../db/schema.ts";
import { readDetails } from "../payees/crypto.ts";

export const BANK_REFERENCE_MAX = 35;

const compact = (s: string) => s.replace(/\s+/g, "").toUpperCase();

/** ISO 11649 references with valid check digits inside free text (spaces inside a reference allowed, as printed). */
export function rfReferencesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toUpperCase().matchAll(/RF\d{2}(?:\s?[A-Z0-9]){1,21}/g)) {
    // Longest valid prefix: a reference glued to the next word ("RF18539007547034TUITION") still counts once.
    const raw = compact(m[0]);
    for (let end = raw.length; end > 4; end--) {
      const candidate = raw.slice(0, end);
      if (isValidRfReference(candidate)) {
        out.push(candidate);
        break;
      }
    }
  }
  return [...new Set(out)];
}

/** The identifiers a recipient matches payments by, from its details (never free-text notes). */
export function recipientIdentifiers(details: RecipientDetails | null): string[] {
  if (!details) return [];
  switch (details.category) {
    case "TUITION":
      return [details.studentId].filter((x): x is string => typeof x === "string" && x.trim() !== "");
    case "RENT":
      return details.reference ? [details.reference] : [];
    case "BILLS":
      return [details.reference ?? details.customerNumber].filter((x): x is string => typeof x === "string" && x.trim() !== "");
    default:
      return [];
  }
}

/**
 * The reference from its parts (see the header): structured parts whole, in order, skipping one that is already in
 * the reference or does not fit; then the purpose, without the structured parts, in the space left.
 */
export function buildBankReference(structured: readonly (string | null | undefined)[], purpose: string, max = BANK_REFERENCE_MAX): string {
  const parts: string[] = [];
  let ref = "";
  const has = (p: string) => compact(ref).includes(compact(p));
  for (const raw of structured) {
    const p = raw?.replace(/\s+/g, " ").trim();
    if (!p || has(p)) continue;
    if (ref === "") {
      // The first structured part is the one the recipient needs most: sent even when it alone is too long.
      ref = p.slice(0, max);
      parts.push(p);
      continue;
    }
    if (ref.length + 1 + p.length > max) continue;
    ref = `${ref} ${p}`;
    parts.push(p);
  }
  let rest = purpose;
  for (const p of parts) rest = rest.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*"), "gi"), " ");
  // Separators left behind by removed parts ("Tuition · · Fall") and repeated spaces go.
  rest = rest
    .replace(/(\s*[·|,;:/-]\s*)+$/g, "")
    .replace(/^(\s*[·|,;:/-]\s*)+/g, "")
    .replace(/(\s*·\s*)+/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
  if (!rest) return ref;
  const room = ref === "" ? max : max - ref.length - 1;
  if (room < 4) return ref;
  let piece = rest;
  if (piece.length > room) {
    const cut = piece.slice(0, room);
    const space = cut.lastIndexOf(" ");
    piece = (space >= Math.min(4, room) ? cut.slice(0, space) : cut).replace(/[\s·|,;:/-]+$/, "");
  }
  if (!piece) return ref;
  return ref === "" ? piece : `${ref} ${piece}`;
}

/**
 * The reference for a signed order, from the database: the linked bill's reference (only an obligation of the
 * order's user, to the order's payee), valid RF references in the purpose, then the payee's own identifiers.
 */
export async function referenceForOrder(db: DbOrTx, order: CanonicalOrder): Promise<string> {
  let link: ReturnType<typeof orderObligation> = null;
  try {
    link = orderObligation(order);
  } catch {
    link = null;
  }
  const bill = link
    ? (
        await db
          .select({ reference: obligations.reference })
          .from(obligations)
          .where(and(eq(obligations.id, link.obligationId), eq(obligations.userId, order.userId), eq(obligations.payeeId, order.payeeId)))
      )[0]
    : undefined;
  const payee = (await db.select({ userId: payees.userId, detailsEnc: payees.detailsEnc }).from(payees).where(and(eq(payees.id, order.payeeId), eq(payees.userId, order.userId))))[0];
  return buildBankReference([bill?.reference ?? null, ...rfReferencesIn(order.purpose), ...recipientIdentifiers(payee ? readDetails(payee) : null)], order.purpose);
}
