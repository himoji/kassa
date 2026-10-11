/*
 * Small JSON HTTP client for mock-world (base = MOCK_WORLD_URL + "/mock", coordination doc) with a
 * timeout. Tests replace the transport with `setMockWorldTransportForTests`.
 */
import { env } from "../../env.ts";

export type Transport = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

const defaultTransport: Transport = async (method, path, body) => {
  const res = await fetch(`${env().MOCK_WORLD_URL.replace(/\/$/, "")}/mock${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
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

export async function mockWorld<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await transport(method, path, body);
  if (r.status < 200 || r.status >= 300) throw new MockWorldError(`mock-world ${method} ${path} → ${r.status}`, r.status);
  return r.json as T;
}
