/** Import commits in chunks (api/hooks/dataport.ts). Pure, so it is unit-tested on its own. */

/** Rows per POST /import/commit: a year of statements is several requests, each well inside the client timeout. */
const COMMIT_CHUNK = 100;
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
