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
