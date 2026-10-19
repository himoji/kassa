import type { SqlClient } from "./types.ts";

/*
 * (added 2026-10-19, security review) Short exclusive claims that must hold across instances: a till bill is paid by
 * one customer, so whoever starts paying it (a card charge, or the shop's QR code handed to one Kassa order) holds its
 * lease until the payment lands (`final`, never given up) or fails (released). Another owner is refused while the
 * lease is live; a lease left behind by a crashed instance or an abandoned QR code expires after its ttl.
 *
 * The entity rows of store/sync.ts are last-writer-wins, so they cannot decide who pays first; a lease is one atomic
 * statement. In Postgres it is a row of the shared entity table under its own kind (sync ignores kinds it does not
 * know), so the world's reset clears leases with everything else.
 */

export interface Lease {
  owner: string;
  /** Wall-clock ms after which another owner may take it (unless final). */
  untilMs: number;
  /** The payment landed: the lease is never given to anyone else. */
  final: boolean;
}

export interface Leases {
  /**
   * Takes or renews `key` for `owner` when it is free, already `owner`'s (and not final), or expired (and not final).
   * Returns the lease as it stands afterwards: the caller holds it iff `owner` matches and it is not final.
   */
  acquire(key: string, owner: string, nowMs: number, ttlMs: number): Promise<Lease>;
  /** The payment landed: `owner`'s lease becomes final. */
  finalize(key: string, owner: string): Promise<void>;
  /** Gives `owner`'s lease up (not a final one). */
  release(key: string, owner: string): Promise<void>;
  /** The lease as it stands, or null. */
  get(key: string): Promise<Lease | null>;
}

/** One process: no await between the check and the change. */
export class MemoryLeases implements Leases {
  private readonly byKey = new Map<string, Lease>();

  acquire(key: string, owner: string, nowMs: number, ttlMs: number): Promise<Lease> {
    const cur = this.byKey.get(key);
    if (!cur || (!cur.final && (cur.owner === owner || cur.untilMs < nowMs))) {
      this.byKey.set(key, { owner, untilMs: nowMs + ttlMs, final: false });
    }
    return Promise.resolve({ ...this.byKey.get(key)! });
  }

  finalize(key: string, owner: string): Promise<void> {
    const cur = this.byKey.get(key);
    if (cur?.owner === owner) cur.final = true;
    return Promise.resolve();
  }

  release(key: string, owner: string): Promise<void> {
    const cur = this.byKey.get(key);
    if (cur?.owner === owner && !cur.final) this.byKey.delete(key);
    return Promise.resolve();
  }

  get(key: string): Promise<Lease | null> {
    const cur = this.byKey.get(key);
    return Promise.resolve(cur ? { ...cur } : null);
  }

  reset(): void {
    this.byKey.clear();
  }
}

const KIND = "lease";

function toLease(raw: unknown): Lease {
  const d = (typeof raw === "string" ? JSON.parse(raw) : raw) as { owner?: unknown; untilMs?: unknown; final?: unknown };
  return { owner: String(d.owner), untilMs: Number(d.untilMs), final: d.final === true };
}

/** Rows of mock_world_entities (migration 0024), kind "lease". */
export class PgLeases implements Leases {
  constructor(private readonly sql: SqlClient) {}

  async acquire(key: string, owner: string, nowMs: number, ttlMs: number): Promise<Lease> {
    const data = JSON.stringify({ owner, untilMs: nowMs + ttlMs, final: false });
    // One statement: insert, or take over only when the current lease is ours or expired, and never a final one.
    await this.sql.query(
      `insert into mock_world_entities (kind, id, data, version, updated_at)
       values ($1, $2, $3::text::jsonb, 1, clock_timestamp())
       on conflict (kind, id) do update set data = excluded.data, version = mock_world_entities.version + 1, updated_at = clock_timestamp()
        where coalesce((mock_world_entities.data->>'final')::boolean, false) = false
          and (mock_world_entities.data->>'owner' = $4 or (mock_world_entities.data->>'untilMs')::float8 < $5::float8)`,
      [KIND, key, data, owner, nowMs],
    );
    const lease = await this.get(key);
    // Deleted by a reset between the two statements: nobody holds it; report it as ours to retry-free callers.
    return lease ?? { owner, untilMs: nowMs + ttlMs, final: false };
  }

  async finalize(key: string, owner: string): Promise<void> {
    await this.sql.query(
      `update mock_world_entities set data = jsonb_set(data, '{final}', 'true'::jsonb), version = version + 1, updated_at = clock_timestamp()
        where kind = $1 and id = $2 and data->>'owner' = $3`,
      [KIND, key, owner],
    );
  }

  async release(key: string, owner: string): Promise<void> {
    await this.sql.query(
      `delete from mock_world_entities where kind = $1 and id = $2 and data->>'owner' = $3 and coalesce((data->>'final')::boolean, false) = false`,
      [KIND, key, owner],
    );
  }

  async get(key: string): Promise<Lease | null> {
    const rows = await this.sql.query(`select data::text as data from mock_world_entities where kind = $1 and id = $2`, [KIND, key]);
    return rows[0] ? toLease(rows[0].data) : null;
  }
}
