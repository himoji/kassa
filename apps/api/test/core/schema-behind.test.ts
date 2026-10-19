/*
 * A database one migration behind (a preview deployment that skipped db:migrate) must not take down the app: on
 * 2026-10-15 a missing profiles.money_history column made /me and /forecast answer 500, and every screen that loads
 * /me (Cards among them) showed the error. Core reads now name their columns, and /health says the schema is behind.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

describe("a database one migration behind", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  // First: the next test removes a journal row for good.
  it("counts this code's migrations by hash: a row left by an earlier build is extra, not applied (2026-10-19)", async () => {
    const health = async () => (await app().inject({ method: "GET", url: "/api/health" })).json().schema as Record<string, unknown>;
    const before = await health();
    expect(before).toEqual({ status: "current", applied: before.expected, expected: before.expected });
    // The public demo showed "applied 28, expected 27": one migration recorded twice (renumbered before it merged).
    await getDb().execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) SELECT hash, created_at + 1 FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1`);
    await getDb().execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('stale', 1)`);
    expect(await health()).toEqual({ status: "current", applied: before.expected, expected: before.expected, extra: 2 });
    await getDb().execute(sql`DELETE FROM drizzle.__drizzle_migrations WHERE id IN (SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 2)`);
  });

  it("still serves the core screens, and /health says it is behind", async () => {
    const { userId } = await createUserWithPasskey();
    const headers = await bearer(userId);
    expect((await app().inject({ method: "GET", url: "/api/health" })).json().schema).toMatchObject({ status: "current" });

    // What a skipped migration 0015 looks like: no money_history column, one journal row fewer.
    await getDb().execute(sql`ALTER TABLE profiles DROP COLUMN money_history`);
    await getDb().execute(sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`);

    for (const url of ["/api/me", "/api/cards", "/api/cards/fees", "/api/forecast", "/api/budgets", "/api/funding-sources"]) {
      const r = await app().inject({ method: "GET", url, headers });
      expect(r.statusCode, `${url}: ${r.body.slice(0, 120)}`).toBe(200);
    }
    expect((await app().inject({ method: "GET", url: "/api/health" })).json().schema).toMatchObject({ status: "behind" });
  });
});
