import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { ApiError, fetchJson, resolveUrl } from "../client";

type FetchFn = typeof globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api client", () => {
  let fetchMock: jest.Mock<FetchFn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = jest.fn<FetchFn>();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolveUrl joins a relative path onto the base without double slashes", () => {
    expect(resolveUrl("/todos/1", "https://api.test/")).toBe("https://api.test/todos/1");
    expect(resolveUrl("todos/1", "https://api.test")).toBe("https://api.test/todos/1");
  });

  it("resolveUrl passes absolute URLs through and rejects relative ones without a base", () => {
    expect(resolveUrl("https://other.test/x", undefined)).toBe("https://other.test/x");
    expect(() => resolveUrl("/x", undefined)).toThrow(/EXPO_PUBLIC_API_URL/);
  });

  it("returns parsed JSON and sends JSON bodies", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 1 }));

    const result = await fetchJson<{ id: number }>("https://api.test/items", {
      method: "POST",
      json: { name: "x" },
    });

    expect(result).toEqual({ id: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test/items");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ name: "x" }));
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("rejects with ApiError carrying status and body on non-2xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "nope" }));

    const promise = fetchJson("https://api.test/missing");
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 404, body: { message: "nope" } });
  });

  it("resolves undefined for an empty body", async () => {
    fetchMock.mockResolvedValue(jsonResponse(204, undefined));
    await expect(fetchJson("https://api.test/empty")).resolves.toBeUndefined();
  });
});
