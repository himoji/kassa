/*
 * Database handle. Two drivers, same Drizzle schema:
 * - PGlite (in-process Postgres, WASM): the DEFAULT. File-backed for local dev — DATABASE_URL unset, or
 *   `pglite://<dir>` (relative dirs resolve against the repo root; default `pglite://./.data/kassa`), or
 *   `pglite://memory`. One process at a time may open a PGlite directory (stop the API before `bun run seed`,
 *   or use POST /api/demo/reset). Tests use in-memory PGlite via `createPgliteDb`.
 * - Postgres via `postgres` (postgres.js) when DATABASE_URL is `postgres://` / `postgresql://`.
 *
 * Everything takes `Db` (the common PgDatabase surface of both drivers), so modules never care which
 * driver is underneath. Use `getDb()` at call time (not at import time) so tests can `setDb()` first.
 */
import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import * as schema from "./schema.ts";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Accepts the root handle or an open transaction. */
export type DbOrTx = Db | Tx;

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const DEFAULT_DATABASE_URL = "pglite://./.data/kassa";

export type DbTarget = { driver: "pglite"; dataDir: string | null } | { driver: "postgres"; url: string };

/** Parse DATABASE_URL (unset → file-backed PGlite under the repo's .data/). */
export function resolveDbTarget(url: string | undefined = process.env.DATABASE_URL): DbTarget {
  const u = url && url.length > 0 ? url : DEFAULT_DATABASE_URL;
  if (u.startsWith("postgres://") || u.startsWith("postgresql://")) return { driver: "postgres", url: u };
  if (u.startsWith("pglite://")) {
    const rest = u.slice("pglite://".length);
    if (rest === "" || rest === "memory") return { driver: "pglite", dataDir: null };
    return { driver: "pglite", dataDir: isAbsolute(rest) ? rest : resolve(REPO_ROOT, rest) };
  }
  throw new Error(`Unsupported DATABASE_URL scheme: ${u} (use postgres:// or pglite://<dir>)`);
}

function openPglite(dataDir: string | null): PGlite {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  return dataDir ? new PGlite(dataDir) : new PGlite();
}

let current: Db | null = null;
let closer: (() => Promise<void>) | null = null;

/** The process-wide database. Lazily connects to DATABASE_URL unless a db was injected with `setDb`. */
export function getDb(): Db {
  if (current) return current;
  const target = resolveDbTarget();
  if (target.driver === "pglite") {
    const client = openPglite(target.dataDir);
    current = drizzlePglite(client, { schema }) as unknown as Db;
    closer = async () => {
      await client.close();
    };
    return current;
  }
  // postgres.js connects lazily on the first query.
  const client = postgres(target.url, { max: 10 });
  current = drizzlePostgres(client, { schema }) as unknown as Db;
  closer = async () => {
    await client.end({ timeout: 5 });
  };
  return current;
}

/** Inject a database (tests, scripts). */
export function setDb(db: Db, close?: () => Promise<void>): void {
  current = db;
  closer = close ?? null;
}

export async function closeDb(): Promise<void> {
  const c = closer;
  current = null;
  closer = null;
  if (c) await c();
}

/** Fresh in-memory PGlite database with all migrations applied. */
export async function createPgliteDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS_DIR });
  return {
    db: db as unknown as Db,
    close: async () => {
      await client.close();
    },
  };
}

/** Apply migrations to DATABASE_URL (scripts/migrate.ts); PGlite file or Postgres. Returns a description. */
export async function migrateDatabaseUrl(url: string | undefined = process.env.DATABASE_URL): Promise<string> {
  const target = resolveDbTarget(url);
  if (target.driver === "pglite") {
    const client = openPglite(target.dataDir);
    try {
      await migratePglite(drizzlePglite(client), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await client.close();
    }
    return `pglite ${target.dataDir ?? "(memory)"}`;
  }
  // A session-level advisory lock needs one server connection from lock to unlock. Behind a transaction-mode pooler
  // (Neon's -pooler host) the unlock can reach another connection and the lock leaks into the pool, so every later
  // cold start waits on it: migrate over the direct URL when the platform provides one.
  const direct = url === process.env.DATABASE_URL ? directDatabaseUrl() : undefined;
  const client = postgres(direct ?? target.url, { max: 1 });
  try {
    // Serverless cold starts can migrate at the same moment: one at a time. Wait a bounded time, never forever: an
    // instance that cannot get the lock skips (another one is migrating, or the build already did).
    if (!(await acquireMigrationLock(client))) return "postgres (skipped: migration lock busy)";
    try {
      await migratePostgres(drizzlePostgres(client), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
  return "postgres";
}

/** The unpooled Postgres URL Vercel's Neon integration sets next to DATABASE_URL, if any. */
function directDatabaseUrl(): string | undefined {
  for (const key of ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING"]) {
    const v = process.env[key]?.trim();
    if (v && /^postgres(ql)?:\/\//.test(v)) return v;
  }
  return undefined;
}

const MIGRATION_LOCK_WAIT_MS = 30_000;

async function acquireMigrationLock(client: postgres.Sql): Promise<boolean> {
  const until = Date.now() + MIGRATION_LOCK_WAIT_MS;
  for (;;) {
    const [row] = await client<{ ok: boolean }[]>`select pg_try_advisory_lock(${MIGRATION_LOCK}) as ok`;
    if (row?.ok) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Advisory lock key for migrations ("kassa" in ASCII, as a bigint). */
const MIGRATION_LOCK = 0x6b61737361;

/** Migrations in the repository (drizzle's journal). */
export function expectedMigrations(): number {
  return migrationHashes().length;
}

/** Each journal migration's hash as drizzle records it: sha256 of the .sql file (drizzle-orm/migrator readMigrationFiles). */
function migrationHashes(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  return journal.entries.map((e) => createHash("sha256").update(readFileSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), "utf8")).digest("hex"));
}

/**
 * Whether the database has every migration this code expects (GET /api/health): "behind" means a deploy skipped
 * `db:migrate`, and endpoints that read the newest columns will fail until it runs.
 *
 * (2026-10-19) `applied` counts this code's migrations found in the database, by hash, not the database's rows: a row
 * left by an earlier build (a migration renumbered before it merged was recorded twice) showed as "applied 28,
 * expected 27". Such rows are reported apart as `extra`.
 */
export async function schemaStatus(): Promise<{ status: "current" | "behind" | "unknown"; applied: number | null; expected: number; extra?: number }> {
  const hashes = migrationHashes();
  const expected = hashes.length;
  try {
    const r = await getDb().execute(sql`select hash from drizzle.__drizzle_migrations`);
    const rows = (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as { hash: string }[];
    const inDb = new Set(rows.map((row) => row.hash));
    const applied = hashes.filter((h) => inDb.has(h)).length;
    const extra = rows.length - applied;
    // A migration file edited after it ran no longer matches its row; the row count still shows it ran.
    const status = applied === expected || rows.length >= expected ? "current" : "behind";
    return { status, applied, expected, ...(extra > 0 ? { extra } : {}) };
  } catch {
    return { status: "unknown", applied: null, expected };
  }
}

export { schema };
