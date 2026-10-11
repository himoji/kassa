/*
 * Phase 2 security & compliance contracts (ADDITIVE; see docs/spec/PHASE1_COORDINATION.md "Contract changes").
 *
 * - AI transparency: EU AI Act Art. 50(1) (the user is told they interact with an AI system) and GDPR
 *   Art. 13(1)(e)/(f) (recipients of the data: the configured LLM provider; whether data leaves the server).
 * - Data-subject rights: GDPR Art. 15 + 20 (export), Art. 16 (rectification, PATCH /me), Art. 17 (erasure by
 *   crypto-shredding), Art. 18 (restriction = freeze + no AI processing), Art. 7(3) (withdraw AI consent).
 * - Unfreeze: a loosening (I8) — passkey over a server-built challenge, effective after 24 h.
 */
import { z } from "zod";

import { IsoDateTime, Uuid } from "./primitives.ts";
import { AuthenticationResponseJSON } from "./webauthn.ts";

/** One configured model role (planner / reader). `local` = runs on infrastructure we operate (no third-party transfer). */
export const AiModelInfo = z.object({
  provider: z.string(),
  model: z.string(),
  local: z.boolean(),
});
export type AiModelInfo = z.infer<typeof AiModelInfo>;

/** GET /me `aiNotice`: what the app must show before the first chat (EU AI Act Art. 50, GDPR Art. 13). */
export const AiNotice = z.object({
  /** Always true: Kassa's chat and document reading are AI systems. */
  isAiSystem: z.literal(true),
  /** English notice text (the app may translate by `noticeVersion`). */
  text: z.string(),
  noticeVersion: z.string(),
  planner: AiModelInfo,
  reader: AiModelInfo,
  /** Categories sent to the planner after I11 reduction, and to the Reader (raw document text). */
  plannerReceives: z.array(z.string()),
  readerReceives: z.array(z.string()),
  /** Personal identifiers replaced by placeholders before any planner call (I11). */
  redacted: z.array(z.string()),
  /** The AI only proposes; payments need rules + passkey (I1). */
  canPay: z.literal(false),
  consentRequired: z.literal(true),
});
export type AiNotice = z.infer<typeof AiNotice>;

/** POST /privacy/ai-consent — give (true) or withdraw (false, GDPR Art. 7(3)) consent to AI processing. */
export const AiConsentRequest = z.object({ consent: z.boolean() });
export type AiConsentRequest = z.infer<typeof AiConsentRequest>;
export const AiConsentResponse = z.object({ aiConsentAt: IsoDateTime.nullable() });
export type AiConsentResponse = z.infer<typeof AiConsentResponse>;

/** PATCH /me — GDPR Art. 16 rectification of the profile. */
export const UpdateMeRequest = z.object({ displayName: z.string().trim().min(1).max(80) });
export type UpdateMeRequest = z.infer<typeof UpdateMeRequest>;

/** Passkey-gated write: first call without assertion → HTTP 428 PasskeyChallenge; resend with both. */
export const PasskeyGatedRequest = z.object({
  challengeId: z.string().min(1).optional(),
  assertion: AuthenticationResponseJSON.optional(),
});
export type PasskeyGatedRequest = z.infer<typeof PasskeyGatedRequest>;

/** POST /unfreeze → a pending LOOSEN rule change (I8), applied by the scheduler at effectiveAt. */
export const UnfreezeRequest = PasskeyGatedRequest;
export type UnfreezeRequest = z.infer<typeof UnfreezeRequest>;
export const UnfreezeResponse = z.object({ ruleChangeId: Uuid, effectiveAt: IsoDateTime });
export type UnfreezeResponse = z.infer<typeof UnfreezeResponse>;

/** POST /privacy/restrict (GDPR Art. 18): freeze + no AI processing until lifted with POST /unfreeze. */
export const RestrictResponse = z.object({ restrictedAt: IsoDateTime, frozenAt: IsoDateTime });
export type RestrictResponse = z.infer<typeof RestrictResponse>;

/** POST /privacy/erase (GDPR Art. 17): passkey-gated, irreversible. */
export const EraseRequest = PasskeyGatedRequest.extend({ confirm: z.literal("ERASE") });
export type EraseRequest = z.infer<typeof EraseRequest>;
export const EraseResponse = z.object({
  erasedAt: IsoDateTime,
  /** Data categories deleted or made unreadable (crypto-shredded). */
  erased: z.array(z.string()),
  /** Data kept under a legal obligation (GDPR Art. 17(3)(b)) and why. */
  retained: z.array(z.object({ category: z.string(), basis: z.string() })),
});
export type EraseResponse = z.infer<typeof EraseResponse>;

/** GET /privacy/export (GDPR Art. 15 + Art. 20): machine-readable JSON of all the user's data. */
export const PrivacyExportResponse = z.object({
  format: z.literal("kassa.dsar-export"),
  version: z.literal(1),
  generatedAt: IsoDateTime,
  subject: z.object({ userId: Uuid }),
  /** Art. 15(1)(a)–(h): purposes, recipients, retention, source, automated decision-making. */
  processing: z.record(z.string(), z.unknown()),
  data: z.record(z.string(), z.unknown()),
});
export type PrivacyExportResponse = z.infer<typeof PrivacyExportResponse>;
