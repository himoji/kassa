/**
 * Minimal typed JSON client (data/react-query module).
 *
 * Relative paths resolve against `env.API_URL` (`EXPO_PUBLIC_API_URL`);
 * absolute URLs pass through. Non-2xx responses reject with `ApiError`.
 */
import { env } from "@/lib/env";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface FetchJsonInit extends Omit<RequestInit, "body"> {
  /** Serialised as JSON with `content-type: application/json`. */
  json?: unknown;
  /** Abort after this many milliseconds. Default 15s. */
  timeoutMs?: number;
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

export function resolveUrl(path: string, base: string | undefined = env.API_URL): string {
  if (ABSOLUTE_URL.test(path)) return path;
  if (!base) {
    throw new Error(`fetchJson("${path}"): set EXPO_PUBLIC_API_URL or pass an absolute URL`);
  }
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function fetchJson<T>(path: string, init: FetchJsonInit = {}): Promise<T> {
  const { json, timeoutMs = 15_000, headers, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (rest.signal) {
    rest.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(resolveUrl(path), {
      ...rest,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new ApiError(response.status, `${response.status} ${response.statusText}`.trim(), body);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}
