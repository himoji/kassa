import type { EntityStore } from "./types.ts";

/*
 * (added 2026-10-18) Keeps the books' in-memory maps (bank quotes/recipients/transfers, QR codes, shop orders, school
 * invoices, ...) in step with the shared entity rows of a deployed build (store/types.ts):
 *
 *   pull()  before a request or a tick: rows other instances changed since the last pull replace the local copy
 *           (only when their version is newer than the one this instance knows);
 *   push()  after it: every entity whose JSON differs from what was last read or written is upserted.
 *
 * Dirty checking by JSON keeps the books plain (no save call at each mutation). A reset anywhere starts a new
 * generation: the next pull here resets the books to their seeds and reloads everything. Last writer wins per entity;
 * money never goes through here (balances are rows of their own with atomic updates). Without an entity store (memory
 * mode) every call is a no-op.
 */

/** One synchronised map of a book. Values must be plain JSON (no Dates, no undefined that matters). */
export interface Collection {
  readonly kind: string;
  entries(): Iterable<[string, unknown]>;
  put(id: string, value: unknown): void;
}

export function mapCollection<K extends string | number, V>(kind: string, map: Map<K, V>, numericKeys = false): Collection {
  return {
    kind,
    entries: () => [...map.entries()].map(([k, v]) => [String(k), v] as [string, unknown]),
    put: (id, value) => map.set((numericKeys ? Number(id) : id) as K, value as V),
  };
}

export function setCollection(kind: string, set: Set<string | number>, numericKeys = false): Collection {
  return {
    kind,
    entries: () => [...set].map((k) => [String(k), true] as [string, unknown]),
    put: (id) => set.add(numericKeys ? Number(id) : id),
  };
}

/** A single value (a counter, a switch) as a one-entry collection. */
export function valueCollection<V>(kind: string, get: () => V, set: (v: V) => void): Collection {
  return { kind, entries: () => [["value", get()]], put: (_id, value) => set(value as V) };
}

/** Rows written in the same moment can commit slightly out of order: every pull re-reads this much history. */
const LOOKBACK_MS = 10_000;

export class WorldSync {
  private generation: number | null = null;
  private lastPullMs: number | null = null;
  /** `${kind}\u0000${id}` → what this instance last read or wrote. */
  private readonly known = new Map<string, { version: number; json: string }>();

  constructor(
    private readonly store: EntityStore | null,
    private readonly collections: Collection[],
    /** Puts every book back to its seed state (in memory), after a reset elsewhere. */
    private readonly resetLocal: () => void | Promise<void>,
  ) {
    const kinds = new Set<string>();
    for (const c of collections) {
      if (kinds.has(c.kind)) throw new Error(`duplicate collection ${c.kind}`);
      kinds.add(c.kind);
    }
  }

  get enabled(): boolean {
    return this.store !== null;
  }

  private byKind(kind: string): Collection | undefined {
    return this.collections.find((c) => c.kind === kind);
  }

  /** The seeds as they are now count as "known" (version 0): only real changes get written. */
  private rememberLocal(): void {
    this.known.clear();
    for (const c of this.collections) for (const [id, v] of c.entries()) this.known.set(`${c.kind}\u0000${id}`, { version: 0, json: JSON.stringify(v) });
  }

  async pull(): Promise<void> {
    if (!this.store) return;
    if (this.generation === null) this.rememberLocal();
    const since = this.lastPullMs === null ? null : this.lastPullMs - LOOKBACK_MS;
    let r = await this.store.load(since);
    if (this.generation !== null && r.generation !== this.generation) {
      // Reset elsewhere: back to the seeds, then everything the new generation has.
      await this.resetLocal();
      this.rememberLocal();
      r = await this.store.load(null);
    }
    this.generation = r.generation;
    this.lastPullMs = r.nowMs;
    for (const row of r.rows) {
      const key = `${row.kind}\u0000${row.id}`;
      const mine = this.known.get(key);
      if (mine && mine.version >= row.version) continue;
      const c = this.byKind(row.kind);
      if (!c) continue;
      c.put(row.id, row.data);
      this.known.set(key, { version: row.version, json: JSON.stringify(row.data) });
    }
  }

  async push(): Promise<void> {
    if (!this.store) return;
    if (this.generation === null) await this.pull();
    const dirty: { kind: string; id: string; data: unknown }[] = [];
    const jsonOf = new Map<string, string>();
    for (const c of this.collections) {
      for (const [id, v] of c.entries()) {
        const key = `${c.kind}\u0000${id}`;
        const json = JSON.stringify(v);
        if (this.known.get(key)?.json === json) continue;
        dirty.push({ kind: c.kind, id, data: JSON.parse(json) as unknown });
        jsonOf.set(key, json);
      }
    }
    if (dirty.length === 0) return;
    const saved = await this.store.save(this.generation!, dirty);
    if (saved === null) {
      // The world was reset meanwhile: these changes belong to the old world. Catch up instead.
      await this.pull();
      return;
    }
    for (const s of saved) {
      const key = `${s.kind}\u0000${s.id}`;
      this.known.set(key, { version: s.version, json: jsonOf.get(key)! });
    }
  }

  /** A reset here: new generation for everyone; the caller has already reset the books. */
  async reset(): Promise<void> {
    if (!this.store) return;
    this.generation = await this.store.reset();
    this.lastPullMs = null;
    this.rememberLocal();
  }

  /** pull → fn → push (ticks and other work outside a request). */
  async around<T>(fn: () => Promise<T>): Promise<T> {
    await this.pull();
    try {
      return await fn();
    } finally {
      await this.push();
    }
  }
}
