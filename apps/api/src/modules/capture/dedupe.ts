/*
 * Dedupe key (spec §13), exactly: `userId|amountMinor|currency|merchantNorm|floor(occurredAt/10min)`,
 * occurredAt in UTC epoch milliseconds (same as fixtures/seed-data.ts). "Also check the neighbouring
 * bucket": the neighbour on the side the event is closer to (first half → previous bucket, second
 * half → next bucket), so two sightings < 5 min apart always collide. Later sources merge into the first.
 */

export const BUCKET_MS = 10 * 60 * 1000;

export interface DedupeFields {
  userId: string;
  amountMinor: number;
  currency: string;
  merchantNorm: string;
  occurredAt: Date;
}

export function bucketOf(occurredAt: Date): number {
  return Math.floor(occurredAt.getTime() / BUCKET_MS);
}

export function dedupeKey(f: DedupeFields, bucket = bucketOf(f.occurredAt)): string {
  return `${f.userId}|${f.amountMinor}|${f.currency}|${f.merchantNorm}|${bucket}`;
}

/** [own key, neighbouring-bucket key]. */
export function dedupeCandidates(f: DedupeFields): [string, string] {
  const b = bucketOf(f.occurredAt);
  const offset = f.occurredAt.getTime() - b * BUCKET_MS;
  const neighbour = offset < BUCKET_MS / 2 ? b - 1 : b + 1;
  return [dedupeKey(f, b), dedupeKey(f, neighbour)];
}
