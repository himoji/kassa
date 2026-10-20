/** Import commits in chunks (api/hooks/dataport.ts). Pure, so it is unit-tested on its own. */

/**
 * Rows per POST /import/commit: the server writes a chunk in one transaction with a handful of queries (capture/
 * importBatch.ts), so a chunk finishes well inside COMMIT_TIMEOUT_MS even on a far database, and a year of statements
 * stays far under the server's 30 sensitive requests a minute (a 429 is waited out and retried: it wrote nothing).
 */
export const COMMIT_CHUNK = 200;
export const COMMIT_TIMEOUT_MS = 60_000;
/** Waits before retrying a chunk the rate limit refused. */
export const COMMIT_RETRY_WAITS_MS = [15_000, 30_000, 60_000];
/** Dedupe looks at 10-minute buckets and their neighbour: a chunk only ends where the next row is 20+ minutes later. */
const SAFE_GAP_MS = 20 * 60 * 1000;

/** Split spending into commit chunks in time order, never between two rows that could be the same purchase. */
export function commitChunks<T extends { occurredAt: string }>(
  rows: T[],
  size = COMMIT_CHUNK
): T[][] {
  const sorted = [...rows].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const out: T[][] = [];
  let cur: T[] = [];
  for (const [i, r] of sorted.entries()) {
    cur.push(r);
    const next = sorted[i + 1];
    if (
      cur.length >= size &&
      (!next || Date.parse(next.occurredAt) - Date.parse(r.occurredAt) >= SAFE_GAP_MS)
    ) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
