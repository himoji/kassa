/*
 * Small JSON HTTP client for mock-world (base = MOCK_WORLD_URL + "/mock", coordination doc) with a
 * timeout. Tests replace the transport with `setMockWorldTransportForTests`.
 * Every request carries X-Kassa-Request-Auth (HMAC over method, path and body with MOCK_HMAC_SECRET): deployed builds
 * of the mock world refuse its control routes (bank, wallets, remittances, reset) without it or the demo admin token
 * (apps/mock-world/src/access.ts). User-triggered actions therefore always pass through an authenticated API route,
 * which picks the user's own bank profile from the session.
 */
import { MOCK_REQUEST_AUTH_HEADER, mockRequestAuth, mockWebhookHeaders } from "@kassa/shared";

import { env } from "../../env.ts";
import { clock } from "../clock/index.ts";

export type Transport = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: unknown }>;

const defaultTransport: Transport = async (method, path, body, headers) => {
  const res = await fetch(`${env().MOCK_WORLD_URL.replace(/\/$/, "")}/mock${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(4000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
};

let transport: Transport = defaultTransport;

export function setMockWorldTransportForTests(t: Transport | null): void {
  transport = t ?? defaultTransport;
}

export class MockWorldError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** X-Kassa-Request-Auth for `/mock${path}` (wall time: the mock world checks it against its own real clock). */
function requestAuth(method: string, path: string, body: unknown): Record<string, string> {
  const raw = body !== undefined ? JSON.stringify(body) : "";
  return { [MOCK_REQUEST_AUTH_HEADER]: mockRequestAuth(env().MOCK_HMAC_SECRET, method, `/mock${path}`, raw, Math.floor(clock.realNowMs() / 1000)) };
}

export async function mockWorld<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await transport(method, path, body, requestAuth(method, path, body));
  if (r.status < 200 || r.status >= 300) throw new MockWorldError(`mock-world ${method} ${path} → ${r.status}`, r.status);
  return r.json as T;
}

/**
 * (M5) A request mock-world must authenticate as coming from Kassa (e.g. a signed purchase order sent to a supplier):
 * the body is signed like mock-world's own webhooks (X-Kassa-Timestamp / X-Kassa-Signature over the raw JSON body,
 * MOCK_HMAC_SECRET, demo-clock seconds).
 */
export async function mockWorldSigned<T = Record<string, unknown>>(method: string, path: string, body: unknown): Promise<T> {
  const raw = JSON.stringify(body);
  const r = await transport(method, path, body, { ...mockWebhookHeaders(env().MOCK_HMAC_SECRET, raw, Math.floor(clock.nowMs() / 1000)), ...requestAuth(method, path, body) });
  if (r.status < 200 || r.status >= 300) throw new MockWorldError(`mock-world ${method} ${path} → ${r.status}`, r.status);
  return r.json as T;
}
