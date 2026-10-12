/*
 * The real mock world (apps/mock-world, in process) wired to the API under test, no network:
 * - API → mock world: rails/http transport → mock-world app.inject (bank, QR wallet);
 * - API → mock world via global fetch (agent catalog port): `stubCatalogFetch()` routes `/mock/*` URLs to inject;
 * - mock world → API: webhooks are captured, then `deliverWebhooks(app)` signs each one with the API's
 *   MOCK_HMAC_SECRET at the demo-clock time (like mock-world's WebhookClient) and injects it into the API.
 * The mock world reads time from the API's demo Clock.
 */
import { mockWebhookHeaders } from "@kassa/shared";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";

import { buildMockWorld, type MockWorld } from "../../../mock-world/src/app.ts";
import { FIXTURE_RATES, type RateProvider } from "../../../mock-world/src/bank/rates.ts";
import { loadConfig } from "../../../mock-world/src/config.ts";
import { FakeIssuerClient } from "../../../mock-world/src/shop/issuer.ts";
import type { OutboxEntry, WebhookKind, WebhookSink } from "../../../mock-world/src/webhooks.ts";
import { env } from "../../src/env.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { setMockWorldTransportForTests } from "../../src/modules/rails/http.ts";

export type CapturedWebhook = { kind: WebhookKind; body: unknown };

export type TestMockWorld = MockWorld & {
  /** Webhooks the mock world sent and that were not delivered yet. */
  pending: CapturedWebhook[];
  close(): Promise<void>;
};

class CaptureSink implements WebhookSink {
  readonly pending: CapturedWebhook[] = [];
  send(kind: WebhookKind, body: unknown): OutboxEntry {
    this.pending.push({ kind, body });
    return { id: `cap-${this.pending.length}`, kind, url: `capture://${kind}`, body, createdAt: "", attempts: 0, status: "pending", lastStatusCode: null, lastError: null, deliveredAt: null };
  }
}

const fixtureRates: RateProvider = { getRates: async () => FIXTURE_RATES };

/**
 * Start the mock world and route the API's rail transport to it. Call `close()` in afterAll.
 * `env` adds mock-world settings (e.g. DEMO_ENABLED for the till); `api` routes the shops' card charges (fake issuer,
 * HMAC-signed) into the API app under test, so a shop charge exercises Kassa's real authorization path.
 */
export async function startMockWorld(opts: { env?: Record<string, string>; api?: () => FastifyInstance } = {}): Promise<TestMockWorld> {
  const sink = new CaptureSink();
  const api = opts.api;
  const issuer = api
    ? new FakeIssuerClient({
        apiUrl: "http://api.test",
        secret: env().MOCK_HMAC_SECRET,
        clock: { now: async () => clock.now() },
        fetch: async (input, init) => {
          const res = await api().inject({ method: "POST", url: new URL(input).pathname, headers: init?.headers as Record<string, string>, payload: String(init?.body ?? "") });
          return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
        },
      })
    : undefined;
  const mw = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", MOCK_HMAC_SECRET: env().MOCK_HMAC_SECRET, ...opts.env } as NodeJS.ProcessEnv),
    ...(issuer ? { issuer } : {}),
    clock: { now: async () => clock.now() },
    rates: fixtureRates,
    webhooks: sink,
    logger: false,
    startTicker: false,
  });
  setMockWorldTransportForTests(async (method, path, body, headers) => {
    // Signed requests (mockWorldSigned) send the exact JSON string their signature covers.
    const res = await mw.app.inject({ method: method as "GET", url: `/mock${path}`, ...(headers ? { headers: { "content-type": "application/json", ...headers } } : {}), ...(body !== undefined ? { payload: headers ? JSON.stringify(body) : (body as object) } : {}) });
    return { status: res.statusCode, json: res.body ? res.json() : null };
  });
  return {
    ...mw,
    pending: sink.pending,
    async close() {
      setMockWorldTransportForTests(null);
      vi.unstubAllGlobals();
      await mw.app.close();
    },
  };
}

/** Sign a webhook body exactly like mock-world's WebhookClient (demo-clock seconds). */
export function signedWebhookHeaders(rawBody: string, tsSeconds = Math.floor(clock.nowMs() / 1000)): Record<string, string> {
  return { "content-type": "application/json", ...mockWebhookHeaders(env().MOCK_HMAC_SECRET, rawBody, tsSeconds) };
}

/** POST a signed mock webhook to the API. Returns the inject response. */
export function postSignedWebhook(app: FastifyInstance, kind: WebhookKind, body: unknown, tsSeconds?: number) {
  const raw = JSON.stringify(body);
  return app.inject({ method: "POST", url: `/api/webhooks/mock/${kind}`, payload: raw, headers: signedWebhookHeaders(raw, tsSeconds) });
}

/** Deliver every captured webhook (in order) to the API; returns status code and JSON per delivery. */
export async function deliverWebhooks(mw: TestMockWorld, app: FastifyInstance): Promise<{ kind: WebhookKind; body: unknown; statusCode: number; json: unknown }[]> {
  const out = [];
  while (mw.pending.length > 0) {
    const w = mw.pending.shift()!;
    const res = await postSignedWebhook(app, w.kind, w.body);
    out.push({ ...w, statusCode: res.statusCode, json: res.body ? res.json() : null });
  }
  return out;
}

/** Route global fetch for `${MOCK_WORLD_URL}/mock/*` (agent catalog port) to the in-process mock world. */
export function stubCatalogFetch(mw: MockWorld): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.pathname.startsWith("/mock/")) throw new Error(`unexpected fetch in test: ${url.href}`);
    const res = await mw.app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
    return new Response(res.body, { status: res.statusCode, headers: { "content-type": String(res.headers["content-type"] ?? "application/json") } });
  });
}

/** GET a mock-world resource as bytes (PDFs) or JSON. */
export async function mockGet(mw: MockWorld, path: string): Promise<{ statusCode: number; bytes: Uint8Array; json: () => unknown }> {
  const res = await mw.app.inject({ method: "GET", url: `/mock${path}` });
  return { statusCode: res.statusCode, bytes: new Uint8Array(res.rawPayload), json: () => res.json() };
}
