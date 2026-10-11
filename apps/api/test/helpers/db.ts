/*
 * Per-file PGlite database (in-process Postgres, all migrations applied) injected with setDb().
 * Usage: `const t = useTestDb();` at the top of a describe/file; `await t.reset()` truncates tables.
 */
import { afterAll, beforeAll } from "vitest";

import { closeDb, createPgliteDb, setDb, type Db } from "../../src/db/client.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { truncateAll } from "../../src/modules/demo/seed.ts";

export function useTestDb(): { db: () => Db; reset: () => Promise<void> } {
  let db: Db | null = null;
  beforeAll(async () => {
    const created = await createPgliteDb();
    db = created.db;
    setDb(created.db, created.close);
    clock.setOffsetInMemoryForTests(0);
  });
  afterAll(async () => {
    await closeDb();
  });
  return {
    db: () => {
      if (!db) throw new Error("test db not ready");
      return db;
    },
    reset: async () => {
      if (!db) throw new Error("test db not ready");
      await truncateAll(db);
      clock.setOffsetInMemoryForTests(0);
    },
  };
}
