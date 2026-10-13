/*
 * Vercel Function (Bun runtime, `bunVersion` in vercel.json): the API and the mock world in one instance.
 * vercel.json rewrites /api/* and /mock/* here; the web export is served as static files next to it, so the
 * deployment has one origin for WebAuthn, like the Caddy setup in docker-compose.yml.
 *
 * Both Fastify apps listen on loopback inside the instance and each request is proxied to the right one.
 * That keeps everything the plain servers do (cookies, multipart, the streamed agent chat) and lets the API
 * reach the mock world (MOCK_WORLD_URL) and back (API_URL) without leaving the instance. The mock world keeps
 * its state in memory, so it resets on a cold start (see README, "Deploy on Vercel").
 *
 * Timers only run while an instance is awake, so the 15 s scheduler and the mock bank tick also run, at
 * most once per interval, after requests (waitUntil keeps the instance alive until they finish).
 */
import { waitUntil } from "@vercel/functions";

// Loaded through computed dynamic imports elsewhere; imported here so Vercel's file tracing ships them and their dependencies.
import "../apps/api/src/modules/agent/routes.ts";
import "../apps/api/src/modules/budget/index.ts";
import "../apps/api/src/modules/budget/routes.ts";
import "../apps/api/src/modules/capture/index.ts";
import "../apps/api/src/modules/capture/routes.ts";
import "../apps/api/src/modules/fx/index.ts";
import "../apps/api/src/modules/fx/routes.ts";
import "../apps/api/src/modules/onboarding/index.ts";
import "../apps/api/src/modules/onboarding/routes.ts";
import "../fixtures/seed-data.ts";

const API_PORT = 4000;
const MOCK_PORT = 4001;
const SCHEDULER_TICK_MS = 15_000;

// Before any config is read: the two apps talk over loopback, and Vercel's edge overwrites X-Forwarded-For.
process.env.MOCK_WORLD_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.API_URL = `http://127.0.0.1:${API_PORT}`;
process.env.TRUST_PROXY ??= "true";

type Instance = { schedulerTick: () => Promise<void>; mockTick: () => Promise<void>; mockTickMs: number };

let started: Promise<Instance> | null = null;
let lastSchedulerTick = 0;
let lastMockTick = 0;

async function start(): Promise<Instance> {
  const { resolveDbTarget } = await import("../apps/api/src/db/client.ts");
  if (resolveDbTarget().driver !== "postgres") {
    throw new Error("DATABASE_URL must be a postgres:// URL on Vercel (the PGlite file database needs a writable disk)");
  }
  const { env } = await import("../apps/api/src/env.ts");
  const { clock } = await import("../apps/api/src/modules/clock/index.ts");
  const { startScheduler, tick } = await import("../apps/api/src/modules/scheduler/index.ts");
  const { buildServer } = await import("../apps/api/src/server.ts");
  const { buildMockWorld } = await import("../apps/mock-world/src/app.ts");
  const { loadConfig } = await import("../apps/mock-world/src/config.ts");

  const e = env();
  const mockConfig = { ...loadConfig(), host: "127.0.0.1", port: MOCK_PORT };
  const mock = await buildMockWorld({ config: mockConfig });
  await mock.app.listen({ host: "127.0.0.1", port: MOCK_PORT });

  const api = await buildServer();
  await clock.load().catch((err: unknown) => api.log.warn({ err }, "demo_state not readable yet (run bun run db:migrate)"));
  const log = (msg: string, err?: unknown) => api.log.error({ err }, msg);
  if (e.SCHEDULER_ENABLED) startScheduler(log);
  await api.listen({ host: "127.0.0.1", port: API_PORT });

  return {
    schedulerTick: e.SCHEDULER_ENABLED ? () => tick(log) : async () => undefined,
    mockTick: async () => {
      await Promise.allSettled([mock.bank.tick(), mock.shop.tick()]);
    },
    mockTickMs: mockConfig.bankTickMs,
  };
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
    const inst = await started;

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
