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
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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
  const client = postgres(target.url, { max: 1 });
  try {
    await migratePostgres(drizzlePostgres(client), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client.end({ timeout: 5 });
  }
  return "postgres";
}

export { schema };
