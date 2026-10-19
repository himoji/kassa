/*
 * (added 2026-10-18) The mock world's shared state on a deployed build lives in this database (migration
 * 0024_mock_world_state, apps/mock-world/src/store/postgres.ts). The mock world only needs a minimal SQL client;
 * these adapt the two drivers the API uses.
 */
import type { PGlite, Transaction } from "@electric-sql/pglite";
import postgres from "postgres";

import type { Row, SqlClient } from "../../../mock-world/src/store/types.ts";

function fromPostgresJs(sql: postgres.Sql | postgres.TransactionSql): SqlClient {
  return {
    query: async (text, params = []) => [...(await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]))] as Row[],
    transaction: async <T>(fn: (tx: SqlClient) => Promise<T>) => (await (sql as postgres.Sql).begin((tx) => fn(fromPostgresJs(tx)))) as T,
  };
}

/** A small pool of its own on DATABASE_URL (Postgres only), so mock-world calls never queue behind the API's. */
export function postgresSqlClient(url: string): { client: SqlClient; close: () => Promise<void> } {
  const sql = postgres(url, { max: 3 });
  return { client: fromPostgresJs(sql), close: () => sql.end({ timeout: 5 }) };
}

function fromPglite(db: PGlite | Transaction, top: PGlite | null): SqlClient {
  return {
    query: async (text, params = []) => (await db.query<Row>(text, params)).rows,
    transaction: async <T>(fn: (tx: SqlClient) => Promise<T>) => {
      // PGlite has no nested transactions: inside one, run on the same transaction.
      if (!top) return fn(fromPglite(db, null));
      return top.transaction((tx) => fn(fromPglite(tx, null)));
    },
  };
}

/** Tests: the same store over an in-process PGlite with the migrations applied. */
export function pgliteSqlClient(client: PGlite): SqlClient {
  return fromPglite(client, client);
}
