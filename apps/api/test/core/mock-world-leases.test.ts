/*
 * (added 2026-10-19, security review) One payer per till bill across serverless instances: the bill's lease is a row
 * of the shared entity table (apps/mock-world/src/store/leases.ts), taken in one statement, so two instances paying
 * the same bill for two customers at the same moment charge one card and refuse the other order.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildMockWorld, seedWallets, type MockWorld } from "../../../mock-world/src/app.ts";
import { StaticRates } from "../../../mock-world/src/bank/rates.ts";
import { ManualClock } from "../../../mock-world/src/clock.ts";
import { loadConfig } from "../../../mock-world/src/config.ts";
import type { Issuer } from "../../../mock-world/src/shop/issuer.ts";
import { PgLeases } from "../../../mock-world/src/store/leases.ts";
import { postgresStore } from "../../../mock-world/src/store/postgres.ts";
import type { SqlClient } from "../../../mock-world/src/store/types.ts";
import { RecordingSink } from "../../../mock-world/src/webhooks.ts";
import { MIGRATIONS_DIR } from "../../src/db/client.ts";
import { pgliteSqlClient } from "../../src/db/mockWorldSql.ts";

let pg: PGlite;
let sql: SqlClient;
const clock = new ManualClock(Date.parse("2026-10-27T18:00:00Z"));
const open: MockWorld[] = [];
const charged: string[] = [];

/** Approves every card, slowly enough that two requests overlap. */
const slowIssuer: Issuer = {
  provider: "fake",
  authorize: async (req) => {
    charged.push(req.cardId);
    await new Promise((r) => setTimeout(r, 30));
    return { approved: true, provider: "fake", authorizationId: `auth_${charged.length}`, reasonCode: null, issuerStatus: 200 };
  },
};

beforeAll(async () => {
  pg = new PGlite();
  await migrate(drizzle(pg), { migrationsFolder: MIGRATIONS_DIR });
  sql = pgliteSqlClient(pg);
});

afterAll(async () => {
  for (const w of open) await w.app.close();
  await pg.close();
});

beforeEach(async () => {
  charged.length = 0;
  const w = await instance();
  await w.app.inject({ method: "POST", url: "/mock/reset", payload: {} });
});

async function instance(): Promise<MockWorld> {
  const w = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", MOCK_HMAC_SECRET: "s3cret", DEMO_ENABLED: "true" } as NodeJS.ProcessEnv),
    clock,
    rates: new StaticRates(),
    webhooks: new RecordingSink(),
    issuer: slowIssuer,
    logger: false,
    startTicker: false,
    store: await postgresStore(sql, seedWallets()),
  });
  open.push(w);
  return w;
}

describe("till bill leases (Postgres)", () => {
  it("two instances paying one bill for two orders at once: one card charged, the other order refused", async () => {
    const a = await instance();
    const b = await instance();
    const bill = (await a.app.inject({ method: "POST", url: "/mock/shop/bud/bills", payload: { items: [{ sku: "PZ-MARG", qty: 1 }] } })).json().bill as { billId: string };
    const pay = (w: MockWorld, cardId: string, clientRef: string) => w.app.inject({ method: "POST", url: `/mock/shop/bud/bills/${bill.billId}/pay`, payload: { cardId, clientRef } });
    const [ra, rb] = await Promise.all([pay(a, "fic_alice", "p-alice"), pay(b, "fic_bob", "p-bob")]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    expect(charged).toHaveLength(1);
    // Later, from a third instance (cold start): paid for good.
    const late = await pay(await instance(), "fic_carol", "p-carol");
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("ALREADY_PAID");
  });

  it("lease rules: one owner at a time, renewable by its owner, taken over only when expired, never once final", async () => {
    const leases = new PgLeases(sql);
    const t = 1_000_000;
    expect(await leases.acquire("bill:x", "p1", t, 100)).toMatchObject({ owner: "p1", final: false });
    expect((await leases.acquire("bill:x", "p2", t + 50, 100)).owner).toBe("p1");
    expect((await leases.acquire("bill:x", "p1", t + 60, 100)).untilMs).toBe(t + 160);
    expect((await leases.acquire("bill:x", "p2", t + 200, 100)).owner).toBe("p2");
    await leases.release("bill:x", "p1");
    expect((await leases.get("bill:x"))?.owner).toBe("p2");
    await leases.finalize("bill:x", "p2");
    expect(await leases.acquire("bill:x", "p3", t + 10_000, 100)).toMatchObject({ owner: "p2", final: true });
    await leases.release("bill:x", "p2");
    expect(await leases.get("bill:x")).toMatchObject({ owner: "p2", final: true });
    const many = await Promise.all(["q1", "q2", "q3", "q4"].map((o) => leases.acquire("bill:y", o, t, 100)));
    expect(new Set(many.map((l) => l.owner)).size).toBe(1);
  });
});
