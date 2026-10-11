/*
 * HTTP clients: the product API (as a persona), mock-world, and the daemon's harness control port.
 * Persona calls handle the hardened API's statuses:
 *  - 401 → rotate the refresh token, else sign in again with the persona's soft passkey; retry once.
 *  - 429 → honour Retry-After (≤ 10 s), up to 3 retries; then RATE_LIMITED.
 *  - 403 AI_CONSENT_REQUIRED / PIPL_CONSENT_REQUIRED → returned as is: consent is never given automatically.
 */
import { API_BASE, CONTROL_BASE, FILES, MOCK_BASE, readText, SIM_TOKEN_HEADER } from "./config.ts";
import { fail } from "./out.ts";

export type HttpResult = { status: number; body: unknown; headers: Headers };

export type Problem = { code?: string; error?: string; detail?: string; title?: string; reasonCodes?: string[]; details?: unknown };

export function problemOf(r: HttpResult): Problem {
  return r.body && typeof r.body === "object" ? (r.body as Problem) : {};
}

export function codeOf(r: HttpResult): string | null {
  const p = problemOf(r);
  return p.code ?? (p.reasonCodes?.[0] ?? null);
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

export async function rawRequest(
  base: string,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; form?: FormData; rawBody?: string; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: FormData | string | undefined;
  if (opts.form) body = opts.form;
  else if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers["content-type"] ??= "application/json";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  } catch (e) {
    return fail("UNREACHABLE", `${method} ${base}${path}: ${(e as Error).message} (is the sim up? run: bun run sim up)`);
  }
  return { status: res.status, body: await parse(res), headers: res.headers };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries 429 (Retry-After, max 10 s each, 3 retries). */
export async function withRateLimitRetry(fn: () => Promise<HttpResult>, retries = 3): Promise<HttpResult> {
  let r = await fn();
  for (let i = 0; i < retries && r.status === 429; i++) {
    const ra = Number(r.headers.get("retry-after"));
    await sleep(Math.min(10_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** i));
    r = await fn();
  }
  return r;
}

export function mockRequest(method: string, path: string, body?: unknown): Promise<HttpResult> {
  return rawRequest(MOCK_BASE, method, `/mock${path}`, body === undefined ? {} : { body });
}

export function controlToken(): string {
  const t = readText(FILES.token);
  if (!t) fail("SIM_DOWN", "sim is not running (no control token); run: bun run sim up");
  return t;
}

/** Harness control port (daemon only, 127.0.0.1, token from .data/sim/token). */
export async function control<T = unknown>(path: string, body: unknown = {}, bearer?: string): Promise<T> {
  const headers: Record<string, string> = { [SIM_TOKEN_HEADER]: controlToken() };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await rawRequest(CONTROL_BASE, "POST", path, { body, headers, timeoutMs: 120_000 });
  if (r.status >= 400) {
    const p = problemOf(r) as Problem & { message?: string };
    fail(p.error ?? p.code ?? `CONTROL_${r.status}`, p.message ?? p.detail ?? "control call failed", { httpStatus: r.status, body: r.body });
  }
  return r.body as T;
}

export function apiRequestRaw(method: string, path: string, opts: Parameters<typeof rawRequest>[3] = {}): Promise<HttpResult> {
  return rawRequest(API_BASE, method, `/api${path}`, opts);
}
