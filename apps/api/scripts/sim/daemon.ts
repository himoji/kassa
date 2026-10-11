#!/usr/bin/env bun
/*
 * Sim daemon (started by `bun run sim up`, never by hand). The ONE process that opens the sim PGlite
 * directory (PGlite is single-writer), hosting:
 *   - the real API (buildServer) on 127.0.0.1:SIM_API_PORT, demo routes on, scheduler off unless --scheduler;
 *   - mock-world as a child process on 127.0.0.1:SIM_MOCK_PORT (its own entry point, same HMAC secret);
 *   - the harness control port on 127.0.0.1:SIM_CONTROL_PORT (control.ts; token-protected, harness only).
 * Writes .data/sim/state.json when ready; SIGTERM / POST /shutdown stops everything it started.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import { createServer } from "node:http";

import { eq } from "drizzle-orm";

import { closeDb, getDb, migrateDatabaseUrl } from "../../src/db/client.ts";
import { demoState } from "../../src/db/schema.ts";
import { env } from "../../src/env.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { startScheduler } from "../../src/modules/scheduler/index.ts";
import { buildServer } from "../../src/server.ts";
import { controlHandler } from "./control.ts";
import { type DaemonState, FILES, MOCK_WORLD_DIR, PORTS, readText, removeFile, writeJson } from "./lib/config.ts";

const log = (msg: string, extra?: unknown) => console.error(`[sim-daemon] ${new Date().toISOString()} ${msg}`, extra ?? "");

const token = readText(FILES.token);
if (!token) {
  log("no control token file; start with `bun run sim up`");
  process.exit(2);
}
const withScheduler = process.argv.includes("--scheduler");
// Offline example FX rates by default (fixtures/fx-rates.json) so demo numbers are deterministic; `sim up --live-fx` opts in.
if (process.argv.includes("--live-fx")) delete process.env.FX_OFFLINE;
else process.env.FX_OFFLINE = "1";

await migrateDatabaseUrl();
const seeded = (await getDb().select().from(demoState).where(eq(demoState.id, 1)))[0];
if (!seeded?.demoUserId) {
  const { userId } = await seedDatabase(getDb(), await loadSeedData(), { reset: false, personas: true });
  log(`seeded demo user ${userId}`);
}
await clock.load();

const e = env();
const app = await buildServer({ logger: true });
await app.listen({ port: PORTS.api, host: "127.0.0.1" });
const stopScheduler = withScheduler ? startScheduler((msg, err) => app.log.error({ err }, msg)) : () => undefined;

// mock-world: separate process with its own entry point; it follows the API's demo clock and must share
// the API's MOCK_HMAC_SECRET (passed explicitly so it also matches under NODE_ENV=test).
const mockLog = openSync(FILES.mockLog, "a");
const mock: ChildProcess = spawn(process.execPath, ["src/index.ts"], {
  cwd: MOCK_WORLD_DIR,
  stdio: ["ignore", mockLog, mockLog],
  env: {
    ...process.env,
    PORT: String(PORTS.mock),
    HOST: "127.0.0.1",
    API_URL: `http://127.0.0.1:${PORTS.api}`,
    MOCK_PUBLIC_URL: `http://127.0.0.1:${PORTS.mock}`,
    MOCK_HMAC_SECRET: e.MOCK_HMAC_SECRET,
    LOG_LEVEL: process.env.SIM_MOCK_LOG_LEVEL ?? "warn",
  },
});
mock.on("exit", (code, signal) => log(`mock-world exited (code ${code}, signal ${signal})`));

let stopping = false;
const control = createServer(
  controlHandler(token, {
    shutdown: () => void shutdown("control"),
    info: () => ({ daemonPid: process.pid, mockPid: mock.pid ?? null, ports: PORTS, scheduler: withScheduler }),
  }),
);
await new Promise<void>((resolve, reject) => {
  control.once("error", reject);
  control.listen(PORTS.control, "127.0.0.1", () => resolve());
});

async function waitMock(): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    if (mock.exitCode !== null) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${PORTS.mock}/mock/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
if (!(await waitMock())) {
  log("mock-world did not become healthy; see logs/mock-world.log");
  await shutdown("mock-world failed", 1);
}

const state: DaemonState = {
  daemonPid: process.pid,
  mockPid: mock.pid ?? null,
  ports: PORTS,
  startedAt: new Date().toISOString(),
  dbDir: FILES.db,
  origin: e.origins[0]!,
  rpId: e.RP_ID,
  scheduler: withScheduler,
};
writeJson(FILES.state, state);
log(`ready: api :${PORTS.api}, mock-world :${PORTS.mock} (pid ${mock.pid}), control :${PORTS.control}`);

async function killMock(): Promise<void> {
  if (mock.exitCode !== null || mock.signalCode !== null) return;
  const exited = new Promise<void>((r) => mock.once("exit", () => r()));
  mock.kill("SIGTERM");
  const t = setTimeout(() => mock.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(t);
}

async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`shutting down (${reason})`);
  stopScheduler();
  await killMock().catch((err: unknown) => log("mock kill failed", err));
  await new Promise<void>((r) => control.close(() => r()));
  await app.close().catch((err: unknown) => log("api close failed", err));
  await closeDb().catch((err: unknown) => log("db close failed", err));
  removeFile(FILES.state);
  removeFile(FILES.pid);
  process.exit(code);
}

// Owner watchdog (Y7): a sim started by a test (SIM_OWNER_PID = the test worker) stops itself when the owner is gone,
// so a test run killed before its afterAll (outer command timeout, Ctrl-C) leaves no orphan daemon tree.
const ownerPid = Number(process.env.SIM_OWNER_PID ?? "");
if (Number.isSafeInteger(ownerPid) && ownerPid > 1) {
  const ownerAlive = () => {
    try {
      process.kill(ownerPid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  setInterval(() => {
    if (!ownerAlive()) void shutdown(`owner ${ownerPid} gone`);
  }, 1000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  log("uncaught exception", err);
  void shutdown("uncaughtException", 1);
});
