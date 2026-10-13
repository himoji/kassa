/*
 * Structured audit log of authentication and authorisation decisions (OWASP ASVS 4.0.3 V7.1.3/V7.2.1,
 * OWASP API Top 10 2023 API1 — log access-control failures). Entries go to the hash-chained ledger (I12), so
 * they are tamper-evident. Account events carry `userId` (they show in that user's Activity).
 *
 * Object-level authorisation (API1/BOLA) answers 404 for both "missing" and "someone else's", so the
 * response never confirms that an id exists. The AUTHZ_DENIED entry is written in BOTH cases (uniform work)
 * and names the actor as `actorUserId`, not `userId`: GET /ledger shows a user only `userId` entries, so the
 * prober cannot read `existed` back (that would turn the audit log into an existence oracle).
 */
import type { DbOrTx } from "../db/client.ts";
import { ledger } from "../modules/ledger/index.ts";
import { HttpProblem } from "./problem.ts";

export type AuditType =
  | "AUTH_LOGIN_SUCCEEDED"
  | "AUTH_LOGIN_FAILED"
  | "AUTH_ASSERTION_FAILED"
  | "AUTHZ_DENIED"
  | "UNFREEZE_REQUESTED"
  | "ACCOUNT_UNFROZEN"
  | "PRIVACY_EXPORTED"
  | "PRIVACY_RESTRICTED"
  | "PRIVACY_ERASED"
  | "PROFILE_RECTIFIED"
  | "AI_CONSENT_GIVEN"
  | "AI_CONSENT_WITHDRAWN"
  // (added 2026-10-12, Track Y3) PIPL Art. 38–39 separate cross-border consent (region CN)
  | "PIPL_CONSENT_GIVEN"
  | "PIPL_CONSENT_WITHDRAWN"
  | "RETENTION_PURGED"
  // (added 2026-10-13) KassaLite pairing (auth/pair.ts)
  | "DEVICE_PAIRING_STARTED"
  | "DEVICE_PAIRING_FAILED"
  | "DEVICE_PAIRED"
  // (added) backup codes (auth/recovery.ts)
  | "AUTH_RECOVERY_FAILED";

export async function audit(type: AuditType, payload: Record<string, unknown>, tx?: DbOrTx): Promise<void> {
  await ledger.append(type, payload, tx);
}

/**
 * Not-found for an owned resource: audits AUTHZ_DENIED (existed = the id belongs to another user) and returns
 * the same 404 problem either way.
 */
export async function ownedNotFound(
  actorUserId: string,
  resource: string,
  id: string,
  existsForAnyone: () => Promise<boolean>,
): Promise<HttpProblem> {
  await audit("AUTHZ_DENIED", { actorUserId, resource, resourceId: id, existed: await existsForAnyone() });
  return new HttpProblem(404, "NOT_FOUND", `${resource} not found`);
}

/** A passkey assertion failed on a gated action (settings, mandates, unfreeze, erase…). */
export async function auditAssertionFailure(userId: string, purpose: string, reason: string): Promise<void> {
  await audit("AUTH_ASSERTION_FAILED", { userId, purpose, reasonCodes: [reason] });
}
