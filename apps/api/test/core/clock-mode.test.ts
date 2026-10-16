/*
 * Real or demo time (demo_state.clock_mode). REAL (the default) is the system clock; DEMO adds the stored offset the
 * Stage moves. Switching keeps the offset, so the story time comes back; advancing from REAL starts at real now.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { demoState, ledgerEntries } from "../../src/db/schema.ts";
import { clock, HOUR_MS } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

const near = (ms: number, target: number) => Math.abs(ms - target) < 60_000;

describe("clock mode", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    clock.setModeInMemoryForTests("REAL");
  });

  it("a fresh database runs real time", async () => {
    await clock.load();
    expect(clock.mode()).toBe("REAL");
    expect(near(clock.nowMs(), Date.now())).toBe(true);
    const res = await app().inject({ method: "GET", url: "/api/demo/clock" });
    expect(res.json()).toMatchObject({ clockMode: "REAL", clockOffsetMs: 0 });
  });

  it("the seed runs story time by default; deployments seed with real time and keep the offset", async () => {
    const data = await loadSeedData();
    await seedDatabase(getDb(), data, { reset: true });
    expect(clock.mode()).toBe("DEMO");
    expect(near(clock.nowMs(), Date.parse(data.seedNow))).toBe(true);

    await seedDatabase(getDb(), data, { reset: true, clockMode: "REAL" });
    await clock.load();
    expect(clock.mode()).toBe("REAL");
    expect(near(clock.nowMs(), Date.now())).toBe(true);
    expect(near(Date.now() + clock.storedOffsetMs(), Date.parse(data.seedNow))).toBe(true);
  });

  it("the Stage switch moves between real and story time, logged, and /me shows the mode", async () => {
    const data = await loadSeedData();
    const { userId } = await seedDatabase(getDb(), data, { reset: true });
    const headers = await bearer(userId);
    const toReal = await app().inject({ method: "POST", url: "/api/demo/clock/mode", payload: { mode: "REAL" } });
    expect(toReal.statusCode).toBe(200);
    expect(toReal.json()).toMatchObject({ clockMode: "REAL", clockOffsetMs: 0 });
    expect(near(Date.parse(toReal.json().now), Date.now())).toBe(true);

    const me = await app().inject({ method: "GET", url: "/api/me", headers: await bearer(userId) });
    expect(me.json().demo).toMatchObject({ clockMode: "REAL", clockOffsetMs: 0 });

    const toDemo = await app().inject({ method: "POST", url: "/api/demo/clock/mode", payload: { mode: "DEMO" } });
    expect(toDemo.json().clockMode).toBe("DEMO");
    expect(near(Date.parse(toDemo.json().now), Date.parse(data.seedNow))).toBe(true);

    // Sessions follow wall time: a token minted in story time still works in real time and back.
    expect((await app().inject({ method: "GET", url: "/api/me", headers })).statusCode).toBe(200);
    const logged = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "DEMO_CLOCK_MODE"));
    expect(logged.map((e) => (e.payload as { mode: string }).mode)).toEqual(["REAL", "DEMO"]);
  });

  it("advancing from real time starts the demo clock at real now", async () => {
    await seedDatabase(getDb(), await loadSeedData(), { reset: true, clockMode: "REAL" });
    const res = await app().inject({ method: "POST", url: "/api/demo/clock/advance", payload: { hours: 24 } });
    expect(res.json().clockMode).toBe("DEMO");
    expect(near(Date.parse(res.json().now), Date.now() + 24 * HOUR_MS)).toBe(true);
    const row = (await getDb().select().from(demoState).where(eq(demoState.id, 1)))[0]!;
    expect(row.clockMode).toBe("DEMO");
  });

  it("the reset keeps the mode the Stage chose", async () => {
    await seedDatabase(getDb(), await loadSeedData(), { reset: true, clockMode: "REAL" });
    const res = await app().inject({ method: "POST", url: "/api/demo/reset", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().clockMode).toBe("REAL");
  });
});
