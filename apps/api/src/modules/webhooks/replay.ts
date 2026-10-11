/*
 * Mock-world webhook replay protection (I13). The HMAC + 5-minute window (verifyMockWebhook) stops forged and
 * stale deliveries; this store stops a captured VALID delivery from being replayed inside the window.
 * Key = sha256(`${timestamp}.${signature}`): the signature already covers the body, so the pair identifies one
 * signed request. Mock-world signs every retry afresh (new timestamp), so legitimate retries are not affected.
 * Rows are kept while their timestamp can still pass the window check, then purged by the scheduler.
 */
import { MOCK_WEBHOOK_WINDOW_SECONDS } from "@kassa/shared";
import { lt } from "drizzle-orm";
import { createHash } from "node:crypto";

import { getDb } from "../../db/client.ts";
import { webhookSeenSignatures } from "../../db/schema.ts";
import { clock } from "../clock/index.ts";

/** Kept for twice the window: the window is ± 5 min around the receiver's (demo) clock. */
export const SEEN_SIGNATURE_RETENTION_MS = 2 * MOCK_WEBHOOK_WINDOW_SECONDS * 1000;

export function seenSignatureKey(timestamp: string, signature: string): string {
  return createHash("sha256").update(`${timestamp}.${signature.trim().toLowerCase()}`).digest("hex");
}

/**
 * Record an authenticated delivery. Returns false when the same signed request was already accepted
 * (a replay). Call only after the HMAC and window checks passed.
 */
export async function rememberWebhookSignature(kind: string, timestamp: string, signature: string): Promise<boolean> {
  const inserted = await getDb()
    .insert(webhookSeenSignatures)
    .values({ sigHash: seenSignatureKey(timestamp, signature), kind, signedAt: new Date(Number(timestamp) * 1000), receivedAt: clock.now() })
    .onConflictDoNothing()
    .returning({ sigHash: webhookSeenSignatures.sigHash });
  return inserted.length > 0;
}

/** Scheduler job: drop entries whose timestamp can no longer pass the window check. Returns the count. */
export async function purgeSeenWebhookSignatures(now: Date = clock.now()): Promise<number> {
  const rows = await getDb()
    .delete(webhookSeenSignatures)
    .where(lt(webhookSeenSignatures.signedAt, new Date(now.getTime() - SEEN_SIGNATURE_RETENTION_MS)))
    .returning({ sigHash: webhookSeenSignatures.sigHash });
  return rows.length;
}
