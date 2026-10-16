import { createHash } from "node:crypto";

import { z } from "zod";

import type { Clock } from "../clock.ts";

/*
 * (added 2026-10-16) Identity check (KYC), simulated. Stands in for the identity verification a licensed partner runs
 * (document check + liveness), in the shape such providers answer: an outcome and machine reason codes. Kassa sends a
 * fictitious document, the account's display name and the result of a simulated liveness step; nothing is fetched,
 * nothing is stored here except the outcome log (no name, number or date of birth), and the same input on the same
 * day always gives the same answer.
 *
 * Rules, in order (all that apply are reported):
 *   liveness FAIL                                     → REJECTED  LIVENESS_FAILED
 *   liveness INCONCLUSIVE                             → REVIEW    LIVENESS_INCONCLUSIVE
 *   document number not 6–20 letters/digits           → REJECTED  DOCUMENT_NUMBER_INVALID
 *   expiry date before today                          → REJECTED  DOCUMENT_EXPIRED
 *   date of birth in the future or not a date         → REJECTED  DATE_OF_BIRTH_INVALID
 *   under 18 today                                    → REJECTED  UNDER_18
 *   document name ≠ account name (letters, any order) → REJECTED  NAME_MISMATCH,
 *     unless one name's words are all in the other (a middle name or patronymic left out) → REVIEW NAME_PARTIAL_MATCH
 *   document number ending in "000" (test value)      → REVIEW    MANUAL_REVIEW
 * REJECTED wins over REVIEW; no reason means VERIFIED.
 *
 * In production the partner reads the document chip or image, checks it against issuer data and runs a real liveness
 * check; Kassa would receive the same three outcomes.
 */

export const KycDocumentType = z.enum(["PASSPORT", "ID_CARD", "DRIVING_LICENCE", "RESIDENCE_PERMIT"]);
export const KycOutcome = z.enum(["VERIFIED", "REVIEW", "REJECTED"]);
export type KycOutcome = z.infer<typeof KycOutcome>;
export const KycLiveness = z.enum(["PASS", "FAIL", "INCONCLUSIVE"]);

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const KycCheckBody = z.object({
  /** The name on the Kassa account the document must match. */
  accountName: z.string().trim().min(1).max(140),
  document: z.object({
    type: KycDocumentType,
    number: z.string().trim().min(1).max(40),
    country: z.string().regex(/^[A-Z]{2}$/),
    fullName: z.string().trim().min(1).max(140),
    dateOfBirth: IsoDate,
    expiresOn: IsoDate,
  }),
  liveness: z.object({ result: KycLiveness }),
});
export type KycCheckBody = z.infer<typeof KycCheckBody>;

export type KycReason =
  | "LIVENESS_FAILED"
  | "LIVENESS_INCONCLUSIVE"
  | "DOCUMENT_NUMBER_INVALID"
  | "DOCUMENT_EXPIRED"
  | "DATE_OF_BIRTH_INVALID"
  | "UNDER_18"
  | "NAME_MISMATCH"
  | "NAME_PARTIAL_MATCH"
  | "MANUAL_REVIEW";

const REJECTING = new Set<KycReason>(["LIVENESS_FAILED", "DOCUMENT_NUMBER_INVALID", "DOCUMENT_EXPIRED", "DATE_OF_BIRTH_INVALID", "UNDER_18", "NAME_MISMATCH"]);

export type KycResult = {
  checkId: string;
  outcome: KycOutcome;
  reasonCodes: KycReason[];
  document: { type: z.infer<typeof KycDocumentType>; country: string; last4: string };
  checkedAt: string;
  provider: "mock-kyc";
  simulated: true;
};

/** Words of a name: letters only (any script), lower case, accents removed, in sorted order. */
export function nameWords(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .sort();
}

export function compareNames(a: string, b: string): "MATCH" | "PARTIAL" | "MISMATCH" {
  const x = nameWords(a);
  const y = nameWords(b);
  if (x.length === 0 || y.length === 0) return "MISMATCH";
  if (x.join(" ") === y.join(" ")) return "MATCH";
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.every((w) => long.has(w)) ? "PARTIAL" : "MISMATCH";
}

function validDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Whole years between a date of birth and `today` (both YYYY-MM-DD, UTC). */
export function ageOn(dateOfBirth: string, today: string): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** Pure decision: same body and day → same outcome and checkId. */
export function checkIdentity(body: KycCheckBody, now: Date): KycResult {
  const today = now.toISOString().slice(0, 10);
  const d = body.document;
  const number = d.number.replace(/[\s-]/g, "").toUpperCase();
  const reasons: KycReason[] = [];
  if (body.liveness.result === "FAIL") reasons.push("LIVENESS_FAILED");
  if (body.liveness.result === "INCONCLUSIVE") reasons.push("LIVENESS_INCONCLUSIVE");
  if (!/^[A-Z0-9]{6,20}$/.test(number)) reasons.push("DOCUMENT_NUMBER_INVALID");
  if (!validDate(d.expiresOn) || d.expiresOn < today) reasons.push("DOCUMENT_EXPIRED");
  if (!validDate(d.dateOfBirth) || d.dateOfBirth > today) reasons.push("DATE_OF_BIRTH_INVALID");
  else if (ageOn(d.dateOfBirth, today) < 18) reasons.push("UNDER_18");
  const names = compareNames(d.fullName, body.accountName);
  if (names === "MISMATCH") reasons.push("NAME_MISMATCH");
  if (names === "PARTIAL") reasons.push("NAME_PARTIAL_MATCH");
  if (/000$/.test(number)) reasons.push("MANUAL_REVIEW");
  const outcome: KycOutcome = reasons.some((r) => REJECTING.has(r)) ? "REJECTED" : reasons.length > 0 ? "REVIEW" : "VERIFIED";
  const checkId = `kyc_${createHash("sha256").update(JSON.stringify([body.accountName, d.type, number, d.country, d.fullName, d.dateOfBirth, d.expiresOn, body.liveness.result, today])).digest("hex").slice(0, 24)}`;
  return {
    checkId,
    outcome,
    reasonCodes: reasons,
    document: { type: d.type, country: d.country, last4: number.slice(-4) },
    checkedAt: now.toISOString(),
    provider: "mock-kyc",
    simulated: true,
  };
}

/** The desk keeps outcomes only (for GET /kyc/checks/:id), never the document or the name. */
export class KycDesk {
  private readonly log = new Map<string, Pick<KycResult, "checkId" | "outcome" | "reasonCodes" | "checkedAt">>();

  constructor(private readonly deps: { clock: Clock }) {}

  async check(body: KycCheckBody): Promise<KycResult> {
    const r = checkIdentity(body, await this.deps.clock.now());
    this.log.set(r.checkId, { checkId: r.checkId, outcome: r.outcome, reasonCodes: r.reasonCodes, checkedAt: r.checkedAt });
    return r;
  }

  get(checkId: string) {
    return this.log.get(checkId) ?? null;
  }

  reset(): void {
    this.log.clear();
  }
}
