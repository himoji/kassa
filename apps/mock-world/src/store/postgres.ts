import { sameCardCharge, type BalanceStore, type CardDebitRecord, type CardDebitResult, type EntityRow, type EntityStore, type Row, type SeedWallet, type SqlClient, type TopUpResult, type WorldStore } from "./types.ts";
import { PgLeases } from "./leases.ts";

/*
 * (added 2026-10-18) Mock-world state in Postgres, shared by every serverless instance of a deployed build (tables:
 * apps/api/drizzle/0024_mock_world_state.sql). Money moves in single statements (`amount = amount + $n`, a debit only
 * `where amount >= $n`), so concurrent instances never lose an update or overdraw a wallet. Bigints are read as
 * text and parsed: drivers differ in how they return int8.
 */

const ID_BLOCK = 1000;

const num = (v: unknown): number => Number(v);

export class PgBalanceStore implements BalanceStore {
  private readonly aliasCache = new Map<string, number>();
  private block: { next: number; end: number } | null = null;
  private refill: Promise<void> | null = null;

  constructor(
    private readonly sql: SqlClient,
    private readonly seeds: SeedWallet[],
  ) {}

  /** Seeded wallets that do not exist yet (first start, or after a reset elsewhere). Never overwrites balances. */
  async seed(): Promise<void> {
    await this.sql.transaction(async (tx) => {
      for (const s of this.seeds) await this.seedOne(tx, s);
    });
  }

  private async seedOne(tx: SqlClient, s: SeedWallet): Promise<void> {
    const created = await tx.query(`insert into mock_world_wallets (profile_id) values ($1) on conflict do nothing returning profile_id`, [s.profileId]);
    await this.addAliases(tx, s.profileId, s.aliases ?? []);
    if (created.length === 0) return;
    for (const b of s.balances) {
      await tx.query(`insert into mock_world_balances (profile_id, currency, amount_minor) values ($1, $2, $3) on conflict do nothing`, [s.profileId, b.currency, b.amountMinor]);
    }
  }

  private async addAliases(q: SqlClient, profile: number, aliases: string[]): Promise<void> {
    for (const a of [String(profile), ...aliases.map((x) => x.toLowerCase())]) {
      await q.query(`insert into mock_world_aliases (alias, profile_id) values ($1, $2) on conflict (alias) do update set profile_id = excluded.profile_id`, [a, profile]);
      this.aliasCache.set(a, profile);
    }
  }

  async resolve(alias: string): Promise<number | undefined> {
    const key = alias.toLowerCase();
    const cached = this.aliasCache.get(key);
    if (cached !== undefined) return cached;
    const rows = await this.sql.query(`select profile_id::text as p from mock_world_aliases where alias = $1`, [key]);
    if (rows.length === 0) return undefined;
    const p = num(rows[0]!.p);
    this.aliasCache.set(key, p);
    return p;
  }

  async hasWallet(profile: number): Promise<boolean> {
    return (await this.sql.query(`select 1 from mock_world_wallets where profile_id = $1`, [profile])).length > 0;
  }

  async openWallet(profile: number, aliases: string[]): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      const created = await tx.query(`insert into mock_world_wallets (profile_id) values ($1) on conflict do nothing returning profile_id`, [profile]);
      await this.addAliases(tx, profile, aliases);
      return created.length > 0;
    });
  }

  async balances(profile: number): Promise<[string, number][] | null> {
    const rows = await this.sql.query(
      `select b.currency, b.amount_minor::text as amount from mock_world_wallets w
         left join mock_world_balances b on b.profile_id = w.profile_id
        where w.profile_id = $1 order by b.position`,
      [profile],
    );
    if (rows.length === 0) return null;
    return rows.filter((r) => r.currency !== null).map((r) => [String(r.currency), num(r.amount)]);
  }

  private async creditWith(q: SqlClient, profile: number, currency: string, amountMinor: number): Promise<number | null> {
    // The wallet check is in the statement: no row for an unknown profile (and the foreign key would refuse it anyway).
    const rows = await q.query(
      `insert into mock_world_balances (profile_id, currency, amount_minor)
         select profile_id, $2, $3 from mock_world_wallets where profile_id = $1
       on conflict (profile_id, currency) do update set amount_minor = mock_world_balances.amount_minor + excluded.amount_minor
       returning amount_minor::text as amount`,
      [profile, currency, amountMinor],
    );
    return rows.length > 0 ? num(rows[0]!.amount) : null;
  }

  credit(profile: number, currency: string, amountMinor: number): Promise<number | null> {
    return this.creditWith(this.sql, profile, currency, amountMinor);
  }

  debit(profile: number, currency: string, amountMinor: number): Promise<number | null> {
    return this.debitWith(this.sql, profile, currency, amountMinor);
  }

  private async debitWith(q: SqlClient, profile: number, currency: string, amountMinor: number): Promise<number | null> {
    const rows = await q.query(
      `update mock_world_balances set amount_minor = amount_minor - $3
        where profile_id = $1 and currency = $2 and amount_minor >= $3
       returning amount_minor::text as amount`,
      [profile, currency, amountMinor],
    );
    return rows.length > 0 ? num(rows[0]!.amount) : null;
  }

  async topUp(reference: string, profile: number, currency: string, amountMinor: number): Promise<TopUpResult> {
    return this.sql.transaction(async (tx): Promise<TopUpResult> => {
      // A second top-up with the same reference waits on this row's unique key until the first commits, then sees it.
      const inserted = await tx.query(
        `insert into mock_world_top_ups (reference, profile_id, currency, amount_minor) values ($1, $2, $3, $4)
         on conflict (reference) do nothing returning reference`,
        [reference, profile, currency, amountMinor],
      );
      if (inserted.length === 0) {
        const seen = (await tx.query(
          `select profile_id::text as p, currency, amount_minor::text as amount, balance_after_minor::text as after from mock_world_top_ups where reference = $1`,
          [reference],
        ))[0] as Row;
        if (num(seen.p) !== profile || seen.currency !== currency || num(seen.amount) !== amountMinor) return { kind: "conflict" };
        return { kind: "ok", balanceAfterMinor: num(seen.after), created: false };
      }
      const after = await this.creditWith(tx, profile, currency, amountMinor);
      if (after === null) throw new NoWallet(); // rolls the reference back too
      await tx.query(`update mock_world_top_ups set balance_after_minor = $2 where reference = $1`, [reference, after]);
      return { kind: "ok", balanceAfterMinor: after, created: true };
    }).catch((err: unknown) => {
      if (err instanceof NoWallet) return { kind: "no_wallet" } as const;
      throw err;
    });
  }

  private async findCardDebitWith(q: SqlClient, reference: string, cardId: string): Promise<CardDebitRecord | null> {
    const r = (await q.query(
      `select reference, card_id, profile_id::text as p, request_currency, request_amount_minor::text as req, currency,
              amount_minor::text as amount, balance_after_minor::text as after
         from mock_world_card_debits where reference = $1 or card_id = $2
        order by (reference = $1) desc limit 1`,
      [reference, cardId],
    ))[0];
    if (!r) return null;
    return {
      reference: String(r.reference),
      cardId: String(r.card_id),
      profile: num(r.p),
      requestCurrency: String(r.request_currency),
      requestAmountMinor: num(r.req),
      currency: String(r.currency),
      amountMinor: num(r.amount),
      balanceAfterMinor: num(r.after),
    };
  }

  findCardDebit(reference: string, cardId: string): Promise<CardDebitRecord | null> {
    return this.findCardDebitWith(this.sql, reference, cardId);
  }

  async cardDebit(d: Omit<CardDebitRecord, "balanceAfterMinor">): Promise<CardDebitResult> {
    return this.sql.transaction(async (tx): Promise<CardDebitResult> => {
      // Unique reference and unique card: a concurrent debit of the same authorization or card waits on the key until
      // the first commits (then sees its row) or rolls back (then this one goes ahead).
      const inserted = await tx.query(
        `insert into mock_world_card_debits (reference, card_id, profile_id, request_currency, request_amount_minor, currency, amount_minor, balance_after_minor)
         values ($1, $2, $3, $4, $5, $6, $7, 0) on conflict do nothing returning reference`,
        [d.reference, d.cardId, d.profile, d.requestCurrency, d.requestAmountMinor, d.currency, d.amountMinor],
      );
      if (inserted.length === 0) {
        const seen = await this.findCardDebitWith(tx, d.reference, d.cardId);
        if (!seen) throw new Error("card debit conflict without a recorded debit");
        return sameCardCharge(seen, d) ? { kind: "ok", debit: seen, created: false } : { kind: "conflict" };
      }
      const after = await this.debitWith(tx, d.profile, d.currency, d.amountMinor);
      if (after === null) throw new Insufficient(); // rolls the record back too
      await tx.query(`update mock_world_card_debits set balance_after_minor = $2 where reference = $1`, [d.reference, after]);
      return { kind: "ok", debit: { ...d, balanceAfterMinor: after }, created: true };
    }).catch((err: unknown) => {
      if (err instanceof Insufficient) return { kind: "insufficient" } as const;
      throw err;
    });
  }

  async nextId(): Promise<number> {
    for (;;) {
      if (this.block && this.block.next < this.block.end) return this.block.next++;
      this.refill ??= this.sql
        .query(`select nextval('mock_world_ids')::text as v`)
        .then((rows) => {
          const v = num(rows[0]!.v);
          this.block = { next: v, end: v + ID_BLOCK };
        })
        .finally(() => {
          this.refill = null;
        });
      await this.refill;
    }
  }

  async reset(): Promise<void> {
    this.aliasCache.clear();
    await this.sql.transaction(async (tx) => {
      await tx.query(`delete from mock_world_top_ups`);
      await tx.query(`delete from mock_world_card_debits`);
      await tx.query(`delete from mock_world_balances`);
      await tx.query(`delete from mock_world_aliases`);
      await tx.query(`delete from mock_world_wallets`);
      for (const s of this.seeds) await this.seedOne(tx, s);
    });
  }
}

class NoWallet extends Error {}
class Insufficient extends Error {}

export class PgEntityStore implements EntityStore {
  constructor(private readonly sql: SqlClient) {}

  async load(sinceMs: number | null): Promise<{ generation: number; nowMs: number; rows: EntityRow[] }> {
    const rows = await this.sql.query(
      `select coalesce(m.generation, 0) as generation, (extract(epoch from clock_timestamp()) * 1000)::float8 as now_ms,
              e.kind, e.id, e.data::text as data, e.version
         from (select 1 as one) o
         left join mock_world_meta m on m.id = 1
         left join mock_world_entities e on ($1::float8 is null or e.updated_at > to_timestamp($1::float8 / 1000))`,
      [sinceMs],
    );
    const head = rows[0]!;
    return {
      generation: num(head.generation),
      nowMs: num(head.now_ms),
      rows: rows.filter((r) => r.kind !== null).map((r) => ({ kind: String(r.kind), id: String(r.id), data: JSON.parse(String(r.data)) as unknown, version: num(r.version) })),
    };
  }

  async save(generation: number, rows: { kind: string; id: string; data: unknown }[]): Promise<{ kind: string; id: string; version: number }[] | null> {
    if (rows.length === 0) return [];
    // Cast through text: drivers would otherwise serialise a string parameter typed jsonb a second time.
    const out = await this.sql.query(
      `insert into mock_world_entities (kind, id, data, version, updated_at)
         select x.kind, x.id, x.data, 1, clock_timestamp()
           from jsonb_to_recordset($1::text::jsonb) as x(kind text, id text, data jsonb)
          where coalesce((select generation from mock_world_meta where id = 1), 0) = $2::int
       on conflict (kind, id) do update set data = excluded.data, version = mock_world_entities.version + 1, updated_at = clock_timestamp()
       returning kind, id, version`,
      [JSON.stringify(rows), generation],
    );
    if (out.length === 0) return null;
    return out.map((r) => ({ kind: String(r.kind), id: String(r.id), version: num(r.version) }));
  }

  async reset(): Promise<number> {
    return this.sql.transaction(async (tx) => {
      // Upsert: the API's demo reset truncates every table, this one included (generation 0 until the next reset).
      const rows = await tx.query(
        `insert into mock_world_meta (id, generation) values (1, 1)
         on conflict (id) do update set generation = mock_world_meta.generation + 1 returning generation`,
      );
      await tx.query(`delete from mock_world_entities`);
      return num(rows[0]!.generation);
    });
  }
}

/** The shared store: seeds the persona wallets that are missing. Throws when the tables are missing (migrations). */
export async function postgresStore(sql: SqlClient, seeds: SeedWallet[]): Promise<WorldStore> {
  const balances = new PgBalanceStore(sql, seeds);
  await balances.seed();
  return { persistence: "postgres", balances, entities: new PgEntityStore(sql), leases: new PgLeases(sql) };
}
