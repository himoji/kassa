import { describe, expect, it, jest } from "@jest/globals";
import type { SessionTokens } from "@kassa/shared";
import { z } from "zod";

import { createApiClient, sessionHeaders } from "../client";
import { ContractError, KassaApiError, NetworkError } from "../errors";
import type { TokenStore } from "../types";

const BASE = "https://x.test/api";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const FRESH: SessionTokens = {
  accessToken: "access-1",
  accessTokenExpiresAt: iso(NOW + 15 * 60_000),
  refreshToken: "refresh-1",
};
const EXPIRING: SessionTokens = { ...FRESH, accessTokenExpiresAt: iso(NOW + 10_000) };
const ROTATED: SessionTokens = {
  accessToken: "access-2",
  accessTokenExpiresAt: iso(NOW + 15 * 60_000),
  refreshToken: "refresh-2",
};

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeStore(kind: TokenStore["kind"], initial: SessionTokens | null) {
  let current = initial;
  return {
    kind,
    load: jest.fn(async (): Promise<SessionTokens | null> => current),
    save: jest.fn(async (tokens: SessionTokens): Promise<void> => {
      current = tokens;
    }),
    clear: jest.fn(async (): Promise<void> => {
      current = null;
    }),
  };
}

function makeClient(options: {
  kind?: TokenStore["kind"];
  tokens?: SessionTokens | null;
  handler: Handler;
  onSessionLost?: () => void;
}) {
  const store = fakeStore(options.kind ?? "native", options.tokens ?? null);
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    options.handler(String(input), init ?? {})
  );
  const client = createApiClient({
    baseUrl: BASE,
    tokenStore: store,
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    now: () => NOW,
    onSessionLost: options.onSessionLost,
  });
  return { client, store, fetchMock };
}

const authOf = (init: RequestInit | undefined) => new Headers(init?.headers).get("authorization");
const isRefresh = (url: string) => url.endsWith("/auth/refresh");

describe("sessionHeaders", () => {
  it("native sends a bearer token and the client marker", () => {
    expect(sessionHeaders("native", FRESH)).toEqual({
      "x-kassa-client": "native",
      authorization: "Bearer access-1",
    });
  });

  it("web never sends an authorization header", () => {
    expect(sessionHeaders("web", FRESH)).toEqual({ "x-kassa-client": "web" });
  });
});

describe("createApiClient", () => {
  it("native request sends the bearer token to baseUrl + path", async () => {
    const { client, fetchMock } = makeClient({
      tokens: FRESH,
      handler: () => json({ ok: true }),
    });

    await client.request("/me");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/me`);
    expect(authOf(fetchMock.mock.calls[0]?.[1])).toBe("Bearer access-1");
  });

  it("web request includes the cookie and sends no authorization header", async () => {
    const { client, store, fetchMock } = makeClient({
      kind: "web",
      tokens: null,
      handler: () => json({ ok: true }),
    });

    await client.request("/me");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("include");
    expect(authOf(init)).toBeNull();
    expect(store.load).not.toHaveBeenCalled();
  });

  it("refreshes a token expiring within 30s once, before the request, then uses the new token", async () => {
    const { client, store, fetchMock } = makeClient({
      tokens: EXPIRING,
      handler: (url) => (isRefresh(url) ? json(ROTATED) : json({ ok: true })),
    });

    await client.request("/me");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[0] ?? [];
    expect(refreshUrl).toBe(`${BASE}/auth/refresh`);
    expect(refreshInit?.method).toBe("POST");
    expect(JSON.parse(String(refreshInit?.body))).toEqual({ refreshToken: "refresh-1" });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${BASE}/me`);
    expect(authOf(fetchMock.mock.calls[1]?.[1])).toBe("Bearer access-2");
    expect(store.save).toHaveBeenCalledWith(ROTATED);
  });

  it("on 401 refreshes once and retries with the new token", async () => {
    const { client, store, fetchMock } = makeClient({
      tokens: FRESH,
      handler: (url, init) => {
        if (isRefresh(url)) return json(ROTATED);
        return authOf(init) === "Bearer access-2" ? json({ ok: true }) : json({ error: "no" }, 401);
      },
    });

    await expect(client.request("/me")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(authOf(fetchMock.mock.calls[0]?.[1])).toBe("Bearer access-1");
    expect(isRefresh(String(fetchMock.mock.calls[1]?.[0]))).toBe(true);
    expect(authOf(fetchMock.mock.calls[2]?.[1])).toBe("Bearer access-2");
    expect(store.save).toHaveBeenCalledWith(ROTATED);
  });

  it("when the refresh is refused, clears tokens, signals session loss and rejects with 401", async () => {
    const onSessionLost = jest.fn();
    const { client, store, fetchMock } = makeClient({
      tokens: FRESH,
      onSessionLost,
      handler: (url) =>
        isRefresh(url) ? json({ error: "refresh expired" }, 401) : json({ error: "no" }, 401),
    });

    const err = await client.request("/me").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KassaApiError);
    expect((err as KassaApiError).status).toBe(401);
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(onSessionLost).toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => isRefresh(String(url)))).toHaveLength(1);
  });

  it("two concurrent 401s share one refresh (single-flight)", async () => {
    const { client, fetchMock } = makeClient({
      tokens: FRESH,
      handler: (url, init) => {
        // Resolve the refresh on a later macrotask so both 401s land while it is in flight.
        if (isRefresh(url)) {
          return new Promise<Response>((resolve) => setTimeout(() => resolve(json(ROTATED)), 0));
        }
        return authOf(init) === "Bearer access-2" ? json({ ok: true }) : json({ error: "no" }, 401);
      },
    });

    await Promise.all([client.request("/a"), client.request("/b")]);

    const refreshCalls = fetchMock.mock.calls.filter(([url]) => isRefresh(String(url)));
    expect(refreshCalls).toHaveLength(1);
  });

  it("maps a 422 error body to KassaApiError with reason codes", async () => {
    const { client } = makeClient({
      tokens: FRESH,
      handler: () => json({ error: "x", code: "REFUSE_CAP", reasonCodes: ["REFUSE_CAP"] }, 422),
    });

    const err = await client.request("/orders").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KassaApiError);
    expect((err as KassaApiError).allReasonCodes).toEqual(["REFUSE_CAP"]);
  });

  it("exposes the passkey challenge on a 428 PASSKEY_REQUIRED", async () => {
    const { client } = makeClient({
      tokens: FRESH,
      handler: () =>
        json(
          {
            error: "passkey required",
            code: "PASSKEY_REQUIRED",
            details: { challengeId: "c1", webauthnOptions: { challenge: "abc" } },
          },
          428
        ),
    });

    const err = await client.request("/orders").catch((e: unknown) => e);

    expect((err as KassaApiError).passkeyChallenge?.challengeId).toBe("c1");
  });

  it("rejects with ContractError when the response does not match the schema", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { client } = makeClient({ tokens: FRESH, handler: () => json({ a: "no" }) });

      await expect(
        client.request("/thing", { schema: z.object({ a: z.number() }) })
      ).rejects.toBeInstanceOf(ContractError);
    } finally {
      warn.mockRestore();
    }
  });

  it("a network failure rejects with NetworkError and keeps the tokens", async () => {
    const { client, store } = makeClient({
      tokens: FRESH,
      handler: () => {
        throw new TypeError("Network request failed");
      },
    });

    await expect(client.request("/me")).rejects.toBeInstanceOf(NetworkError);

    expect(store.clear).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });
});
