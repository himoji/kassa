/**
 * Kassa API client (spec §8). One place decides how a request proves the session:
 * - web: the httpOnly session cookie, sent with `credentials: "include"`; no token in JS;
 * - native: `Authorization: Bearer <access JWT>` (RFC 6750 §2.1). The access token lives 15 min;
 *   it is refreshed shortly before expiry, and once more on a 401, through a single in-flight
 *   POST /auth/refresh (rotating refresh token). A failed refresh ends the session.
 *
 * Responses are validated against the `@kassa/shared` zod schemas, so screens only ever see
 * contract-shaped data (the order sheet relies on this for I3).
 */
// @graph node=service:kassa-api kind=service label="Kassa API (/api)" edges=env:EXPO_PUBLIC_API_URL
import { SessionTokens as SessionTokensSchema, type SessionTokens } from "@kassa/shared";
import type { z } from "zod";

import { apiBaseUrl } from "./config";
import { ContractError, KassaApiError, NetworkError } from "./errors";
import { tokenStore as defaultTokenStore } from "./token-store";
import type { TokenStore } from "./types";

/** Refresh this long before the access token expires, so a request never races the expiry. */
export const REFRESH_SKEW_MS = 30_000;

export interface ApiClientDeps {
  baseUrl: string;
  tokenStore: TokenStore;
  fetch: typeof globalThis.fetch;
  /** Called when the server says the session is gone (401 after a refresh attempt). */
  onSessionLost?: () => void;
  now?: () => number;
  timeoutMs?: number;
}

export interface RequestOptions<T> {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Serialised as JSON. */
  json?: unknown;
  /** Response schema; the parsed (stripped) value is returned. Omit for empty (204) bodies. */
  schema?: z.ZodType<T>;
  /** Send session credentials. Default true; auth endpoints pass false. */
  auth?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ApiClient {
  readonly baseUrl: string;
  readonly kind: TokenStore["kind"];
  request<T = void>(path: string, options?: RequestOptions<T>): Promise<T>;
  /** `fetch` with the session attached and the refresh-on-401 retry, for streaming endpoints. */
  authorizedFetch(input: string, init?: RequestInit): Promise<Response>;
  /** Headers that prove the session right now (empty on web: the cookie does it). */
  authHeaders(): Promise<Record<string, string>>;
  setTokens(tokens: SessionTokens | null): Promise<void>;
  hasSession(): Promise<boolean>;
  url(path: string): string;
}

function isExpiringSoon(tokens: SessionTokens, now: number): boolean {
  const exp = Date.parse(tokens.accessTokenExpiresAt);
  return Number.isNaN(exp) || exp - now <= REFRESH_SKEW_MS;
}

/** The pure header rule, exported for tests: bearer only for native with a token. */
export function sessionHeaders(
  kind: TokenStore["kind"],
  tokens: SessionTokens | null
): Record<string, string> {
  const headers: Record<string, string> = { "x-kassa-client": kind };
  if (kind === "native" && tokens) headers.authorization = `Bearer ${tokens.accessToken}`;
  return headers;
}

function mergeHeaders(base: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(base);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return headers;
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

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const { kind } = deps.tokenStore;
  let refreshing: Promise<SessionTokens | null> | null = null;

  const url = (path: string) => `${deps.baseUrl}/${path.replace(/^\/+/, "")}`;

  async function doRefresh(): Promise<SessionTokens | null> {
    const current = await deps.tokenStore.load();
    if (!current?.refreshToken) return null;
    let response: Response;
    try {
      response = await deps.fetch(url("/auth/refresh"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-kassa-client": kind,
        },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
    } catch (err) {
      // Offline is not a logout: keep the tokens and let the caller see the network error.
      throw new NetworkError(err);
    }
    if (!response.ok) {
      await deps.tokenStore.clear();
      return null;
    }
    const parsed = SessionTokensSchema.safeParse(await readBody(response));
    if (!parsed.success) {
      await deps.tokenStore.clear();
      return null;
    }
    await deps.tokenStore.save(parsed.data);
    return parsed.data;
  }

  /** Single-flight: concurrent 401s share one refresh (a rotating refresh token is single-use). */
  function refresh(): Promise<SessionTokens | null> {
    refreshing ??= doRefresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function currentTokens(): Promise<SessionTokens | null> {
    if (kind !== "native") return null;
    const tokens = await deps.tokenStore.load();
    if (tokens && isExpiringSoon(tokens, now())) return refresh();
    return tokens;
  }

  async function authorizedFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const send = (tokens: SessionTokens | null) =>
      deps.fetch(input, {
        ...init,
        credentials: kind === "web" ? "include" : init.credentials,
        headers: mergeHeaders(init.headers, sessionHeaders(kind, tokens)),
      });

    const tokens = await currentTokens();
    let response = await send(tokens);
    if (response.status === 401 && kind === "native" && tokens) {
      const next = await refresh();
      if (next) response = await send(next);
    }
    if (response.status === 401) deps.onSessionLost?.();
    return response;
  }

  async function request<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
    const {
      method = options.json === undefined ? "GET" : "POST",
      json,
      schema,
      auth = true,
    } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onCallerAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });

    const init: RequestInit = {
      method,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    };

    let response: Response;
    try {
      response = auth
        ? await authorizedFetch(url(path), init)
        : await deps.fetch(url(path), {
            ...init,
            credentials: kind === "web" ? "include" : undefined,
            headers: mergeHeaders(init.headers, { "x-kassa-client": kind }),
          });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      if (err instanceof NetworkError) throw err;
      throw new NetworkError(err);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    }

    const body = await readBody(response);
    if (!response.ok) throw new KassaApiError(response.status, body);
    if (!schema) return undefined as T;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      if (__DEV__)
        console.warn(`[api] contract mismatch on ${method} ${path}`, parsed.error.issues);
      throw new ContractError(path, parsed.error.issues);
    }
    return parsed.data;
  }

  return {
    baseUrl: deps.baseUrl,
    kind,
    request,
    authorizedFetch,
    authHeaders: async () => sessionHeaders(kind, await currentTokens()),
    setTokens: (tokens) => (tokens ? deps.tokenStore.save(tokens) : deps.tokenStore.clear()),
    hasSession: async () => (kind === "web" ? true : Boolean(await deps.tokenStore.load())),
    url,
  };
}

type SessionLostListener = () => void;
const sessionLostListeners = new Set<SessionLostListener>();

/** Subscribe to "the server ended the session" (used by the session store). */
export function onSessionLost(listener: SessionLostListener): () => void {
  sessionLostListeners.add(listener);
  return () => sessionLostListeners.delete(listener);
}

/** The app's client. On native the global `fetch` is expo/fetch (WinterCG, streams bodies). */
export const api: ApiClient = createApiClient({
  baseUrl: apiBaseUrl(),
  tokenStore: defaultTokenStore,
  fetch: (input, init) => globalThis.fetch(input, init),
  onSessionLost: () => sessionLostListeners.forEach((l) => l()),
});
