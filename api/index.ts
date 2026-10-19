/*
 * Vercel Function (Bun runtime, `bunVersion` in vercel.json): the API and the mock world in one instance.
 * vercel.json rewrites /api/* and /mock/* here; the web export is served as static files next to it, so the
 * deployment has one origin for WebAuthn, like the Caddy setup in docker-compose.yml.
 *
 * Both Fastify apps listen on loopback inside the instance and each request is proxied to the right one.
 * That keeps everything the plain servers do (cookies, multipart, the streamed agent chat) and lets the API
 * reach the mock world (MOCK_WORLD_URL) and back (API_URL) without leaving the instance. The mock world keeps
 * its state in the same Postgres database (migration 0024_mock_world_state, apps/mock-world/src/store), so every
 * instance sees the same balances, transfers, QR codes, orders and school invoices, and a cold start loses nothing.
 *
 * Timers only run while an instance is awake, so the 15 s scheduler and the mock bank tick also run, at
 * most once per interval, after requests (waitUntil keeps the instance alive until they finish).
 */
import { waitUntil } from "@vercel/functions";

import type { SeedWallet } from "../apps/mock-world/src/store/types.ts";


const API_PORT = 4000;
const MOCK_PORT = 4001;
const SCHEDULER_TICK_MS = 15_000;

// Before any config is read: the two apps talk over loopback, and Vercel's edge overwrites X-Forwarded-For.
process.env.MOCK_WORLD_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.API_URL = `http://127.0.0.1:${API_PORT}`;
process.env.TRUST_PROXY ??= "true";
// The production domain Vercel gives the project (kassa-xyz.vercel.app, or your custom domain): the WebAuthn origin
// and RP ID, and the base of mock-world links, unless set explicitly (a custom domain set as the primary one).
const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
if (host) {
  process.env.PUBLIC_ORIGIN ??= `https://${host}`;
  process.env.RP_ID ??= host;
  process.env.MOCK_PUBLIC_URL ??= `https://${host}`;
  process.env.KASSA_APP_URL ??= `https://${host}`;
}

type Instance = { schedulerTick: () => Promise<void>; mockTick: () => Promise<void>; mockTickMs: number };

let started: Promise<Instance> | null = null;
let lastSchedulerTick = 0;
let lastMockTick = 0;

/**
 * Modules the API loads through computed import() paths, named here with literal paths so Vercel's file tracing
 * ships them and their dependencies. Imported inside start(), so a failing module becomes a STARTUP_FAILED answer
 * instead of a function that cannot load at all.
 */
async function preloadTracedModules(): Promise<void> {
  await Promise.all([
    import("../apps/api/src/modules/agent/routes.ts"),
    import("../apps/api/src/modules/budget/index.ts"),
    import("../apps/api/src/modules/budget/routes.ts"),
    import("../apps/api/src/modules/capture/index.ts"),
    import("../apps/api/src/modules/capture/routes.ts"),
    import("../apps/api/src/modules/fx/index.ts"),
    import("../apps/api/src/modules/fx/routes.ts"),
    import("../apps/api/src/modules/onboarding/index.ts"),
    import("../apps/api/src/modules/onboarding/routes.ts"),
    import("../fixtures/seed-data.ts"),
  ]);
}

async function start(): Promise<Instance> {
  await preloadTracedModules();
  const { resolveDbTarget } = await import("../apps/api/src/db/client.ts");
  if (resolveDbTarget().driver !== "postgres") {
    throw new Error("DATABASE_URL must be a postgres:// URL on Vercel (the PGlite file database needs a writable disk)");
  }
  const { env } = await import("../apps/api/src/env.ts");
  const { clock } = await import("../apps/api/src/modules/clock/index.ts");
  const { startScheduler, tick } = await import("../apps/api/src/modules/scheduler/index.ts");
  const { buildServer } = await import("../apps/api/src/server.ts");
  const { buildMockWorld, seedWallets } = await import("../apps/mock-world/src/app.ts");
  const { loadConfig } = await import("../apps/mock-world/src/config.ts");

  const e = env();
  // Pending migrations run at cold start (one instance at a time, db/client.ts): a preview build that skipped
  // db:migrate must not serve 500s from columns its database lacks. MIGRATE_ON_START=false opts out. Before the mock
  // world starts: its state tables come from a migration too.
  if (process.env.MIGRATE_ON_START !== "false") {
    const { migrateDatabaseUrl } = await import("../apps/api/src/db/client.ts");
    await migrateDatabaseUrl().catch((err: unknown) => console.error("migrate on start failed", err));
  }

  const mockConfig = { ...loadConfig(), host: "127.0.0.1", port: MOCK_PORT };
  const mock = await buildMockWorld({ config: mockConfig, store: await mockWorldStore(seedWallets()) });
  await mock.app.listen({ host: "127.0.0.1", port: MOCK_PORT });
  if (e.DEMO_ENABLED) await seedIfEmpty();
  const api = await buildServer();
  await clock.load().catch((err: unknown) => api.log.warn({ err }, "demo_state not readable yet (run bun run db:migrate)"));
  const log = (msg: string, err?: unknown) => api.log.error({ err }, msg);
  if (e.SCHEDULER_ENABLED) startScheduler(log);
  await api.listen({ host: "127.0.0.1", port: API_PORT });

  return {
    schedulerTick: e.SCHEDULER_ENABLED ? () => tick(log) : async () => undefined,
    mockTick: () => mock.tick().catch((err: unknown) => console.error("mock world tick failed", err)),
    mockTickMs: mockConfig.bankTickMs,
  };
}

/**
 * The mock world's shared state in DATABASE_URL. If its tables are missing (the migration did not run), the mock world
 * falls back to memory, as before 0024: it works per instance and says so in GET /mock/health ("persistence").
 */
async function mockWorldStore(seeds: SeedWallet[]) {
  const { postgresSqlClient } = await import("../apps/api/src/db/mockWorldSql.ts");
  const { postgresStore } = await import("../apps/mock-world/src/store/postgres.ts");
  const { memoryStore } = await import("../apps/mock-world/src/store/memory.ts");
  const { client, close } = postgresSqlClient(process.env.DATABASE_URL!);
  try {
    return await postgresStore(client, seeds);
  } catch (err) {
    console.error("kassa: mock-world state tables unavailable, keeping the mock world in memory (per instance)", err);
    await close().catch(() => undefined);
    return memoryStore(seeds);
  }
}

/**
 * Demo deployments: load the demo data once, into an empty database. Two instances starting at the same moment can
 * both try; the loser fails on the seeded rows' primary keys and simply finds the data there.
 */
async function seedIfEmpty(): Promise<void> {
  const { getDb } = await import("../apps/api/src/db/client.ts");
  const { users } = await import("../apps/api/src/db/schema.ts");
  const { loadSeedData, seedDatabase } = await import("../apps/api/src/modules/demo/seed.ts");
  const empty = async () => (await getDb().select({ id: users.id }).from(users).limit(1)).length === 0;
  if (!(await empty())) return;
  console.log("kassa: empty database, loading the demo data");
  try {
    // Real time by default: the Stage can switch to the demo clock (story time) when a script needs it.
    await seedDatabase(getDb(), await loadSeedData(), { reset: false, personas: true, clockMode: "REAL" });
  } catch (err) {
    if (await empty()) throw err;
  }
}

/** A start failure as problem+json, so the reason shows in the browser too (credentials in URLs masked). */
function startFailure(err: unknown): Response {
  console.error("kassa: start failed", err);
  const detail = (err instanceof Error ? err.message : String(err)).replace(/\/\/[^@\s/]+@/g, "//***@");
  return Response.json(
    { type: "/problems/STARTUP_FAILED", title: "The server could not start", status: 500, detail },
    { status: 500, headers: { "content-type": "application/problem+json" } },
  );
}

function catchUpTimers(inst: Instance): void {
  const now = Date.now();
  if (now - lastMockTick >= inst.mockTickMs) {
    lastMockTick = now;
    waitUntil(inst.mockTick());
  }
  if (now - lastSchedulerTick >= SCHEDULER_TICK_MS) {
    lastSchedulerTick = now;
    waitUntil(inst.schedulerTick());
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    started ??= start().catch((err: unknown) => {
      started = null; // retry the start on the next request
      throw err;
    });
    let inst: Instance;
    try {
      inst = await started;
    } catch (err) {
      return startFailure(err);
    }

    const url = new URL(request.url);
    const port = url.pathname === "/mock" || url.pathname.startsWith("/mock/") ? MOCK_PORT : API_PORT;
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    const res = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      signal: request.signal,
    });
    catchUpTimers(inst);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  },
};
