/*
 * Public ledger API (spec §14, I12). `ledger.append(type, payload)` — B may log via it.
 * Pass `tx` to append inside the caller's transaction (the entry commits or rolls back with it).
 */
import { and, desc, lt, sql } from "drizzle-orm";
import type { KeyObject } from "node:crypto";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { ledgerEntries } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { clock } from "../clock/index.ts";
import { appendInTx, verifyChain, type AppendedEntry, type VerifyReport } from "./internal.ts";
import { loadPrivateKey, publicFromPrivate, loadPublicKey } from "./keys.ts";

let keyCache: { b64: string; priv: KeyObject } | null = null;
function checkpointKey(): KeyObject {
  const b64 = env().LEDGER_CHECKPOINT_KEY;
  if (!keyCache || keyCache.b64 !== b64) keyCache = { b64, priv: loadPrivateKey(b64) };
  return keyCache.priv;
}

export function checkpointPublicKey(): KeyObject {
  const pub = env().LEDGER_CHECKPOINT_PUBLIC_KEY;
  return pub ? loadPublicKey(pub) : publicFromPrivate(checkpointKey());
}

export const ledger = {
  async append(type: string, payload: unknown, tx?: DbOrTx): Promise<AppendedEntry> {
    const key = checkpointKey();
    if (tx) return appendInTx(tx, clock.now(), key, type, payload);
    return getDb().transaction((t) => appendInTx(t, clock.now(), key, type, payload));
  },
  async verify(): Promise<VerifyReport> {
    return verifyChain(getDb(), checkpointPublicKey());
  },
  /** Newest first, scoped to entries whose payload.userId matches; cursor = seq to continue below. */
  async page(userId: string, cursor: number | null, limit: number) {
    const db = getDb();
    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          sql`${ledgerEntries.payload}->>'userId' = ${userId}`,
          cursor !== null ? lt(ledgerEntries.seq, cursor) : undefined,
        ),
      )
      .orderBy(desc(ledgerEntries.seq))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? String(last.seq) : null };
  },
};

export type { AppendedEntry, VerifyReport };
