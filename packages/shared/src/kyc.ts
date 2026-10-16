/*
 * (added 2026-10-16) Identity check (KYC), sandbox. The user enters a fictitious identity document and runs a
 * simulated liveness step; the API asks the identity checker (mock-world, in production a licensed partner) and keeps
 * only the outcome, the document type and country, the last 4 characters of the number (sealed with the user's data
 * key) and the timestamps. Payments above the KYC threshold, and adding more than it in a day, need VERIFIED
 * (reason code KYC_REQUIRED).
 */
import { z } from "zod";

export const KycDocumentType = z.enum(["PASSPORT", "ID_CARD", "DRIVING_LICENCE", "RESIDENCE_PERMIT"]);
export type KycDocumentType = z.infer<typeof KycDocumentType>;

export const KycOutcome = z.enum(["VERIFIED", "REVIEW", "REJECTED"]);
export type KycOutcome = z.infer<typeof KycOutcome>;

/** The user's standing: the latest check's outcome, or NONE before any check. */
export const KycStatus = z.enum(["NONE", "VERIFIED", "REVIEW", "REJECTED"]);
export type KycStatus = z.infer<typeof KycStatus>;

export const KycLivenessResult = z.enum(["PASS", "FAIL", "INCONCLUSIVE"]);
export type KycLivenessResult = z.infer<typeof KycLivenessResult>;

/** Reason codes the identity checker answers with (shown translated in the app). */
export const KycReason = z.enum([
  "LIVENESS_FAILED",
  "LIVENESS_INCONCLUSIVE",
  "DOCUMENT_NUMBER_INVALID",
  "DOCUMENT_EXPIRED",
  "DATE_OF_BIRTH_INVALID",
  "UNDER_18",
  "NAME_MISMATCH",
  "NAME_PARTIAL_MATCH",
  "MANUAL_REVIEW",
]);
export type KycReason = z.infer<typeof KycReason>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const KycStartRequest = z.object({
  document: z.object({
    type: KycDocumentType,
    number: z.string().trim().min(1).max(40),
    country: z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2"),
    fullName: z.string().trim().min(1).max(140),
    dateOfBirth: IsoDate,
    expiresOn: IsoDate,
  }),
  liveness: z.object({ result: KycLivenessResult }),
});
export type KycStartRequest = z.infer<typeof KycStartRequest>;

export const KycCheckDto = z.object({
  id: z.string(),
  outcome: KycOutcome,
  reasonCodes: z.array(KycReason),
  documentType: KycDocumentType,
  documentCountry: z.string().length(2),
  /** Last 4 characters of the document number; null after erasure (the data key is gone). */
  documentLast4: z.string().nullable(),
  createdAt: z.string(),
  checkedAt: z.string(),
  simulated: z.boolean(),
});
export type KycCheckDto = z.infer<typeof KycCheckDto>;

export const KycStatusResponse = z.object({
  status: KycStatus,
  latest: KycCheckDto.nullable(),
  /** Payments above this (home currency, minor units) and a day's top-ups above it need VERIFIED. */
  thresholdHomeMinor: z.number().int().nonnegative(),
  homeCurrency: z.string().length(3),
  simulated: z.literal(true),
});
export type KycStatusResponse = z.infer<typeof KycStatusResponse>;
