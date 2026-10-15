import { describe, expect, it, jest } from "@jest/globals";

import {
  checkShortcutConnection,
  clearSetupProgress,
  loadSetupProgress,
  movedSince,
  saveSetupProgress,
  shortcutRunUrl,
} from "../shortcut-check";

const SERVER = "https://kassa.example.com";

function fetchReturning(status: number, body: unknown) {
  return jest.fn(async (_url: unknown, _init: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  })) as unknown as typeof fetch & jest.Mock;
}

describe("checkShortcutConnection", () => {
  it("posts {test: true} with the Shortcut's own key to the Shortcut endpoint", async () => {
    const f = fetchReturning(200, { status: "TEST" });
    expect(await checkShortcutConnection(SERVER, "ksc_abc", f)).toBe("ok");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://kassa.example.com/api/capture/shortcut");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ksc_abc");
    expect(JSON.parse(init.body as string)).toEqual({ test: true });
  });

  it("401 → revoked; other answers → failed; network error → unreachable", async () => {
    expect(await checkShortcutConnection(SERVER, "k", fetchReturning(401, {}))).toBe("revoked");
    expect(await checkShortcutConnection(SERVER, "k", fetchReturning(500, {}))).toBe("failed");
    // An older server logs nothing for an empty body but answers a different shape.
    expect(
      await checkShortcutConnection(SERVER, "k", fetchReturning(200, { status: "LOGGED" }))
    ).toBe("failed");
    const down = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    expect(await checkShortcutConnection(SERVER, "k", down)).toBe("unreachable");
  });
});

describe("shortcutRunUrl", () => {
  it("runs the Kassa Shortcut and returns to KassaLite on success, cancel and error", () => {
    const url = new URL(shortcutRunUrl());
    expect(url.protocol).toBe("shortcuts:");
    expect(url.pathname.endsWith("/run-shortcut")).toBe(true);
    expect(url.searchParams.get("name")).toBe("Kassa");
    for (const k of ["x-success", "x-cancel", "x-error"]) {
      expect(url.searchParams.get(k)).toBe("kassalite://settings");
    }
  });
});

describe("movedSince", () => {
  it("is true only for a later instant", () => {
    expect(movedSince(null, null)).toBe(false);
    expect(movedSince("2026-10-15T10:00:00.000Z", null)).toBe(true);
    expect(movedSince("2026-10-15T10:00:00.000Z", "2026-10-15T10:00:00.000Z")).toBe(false);
    expect(movedSince("2026-10-15T10:00:01.000Z", "2026-10-15T10:00:00.000Z")).toBe(true);
  });
});

describe("setup progress", () => {
  it("round-trips and clears", async () => {
    await saveSetupProgress({ copied: true, added: false, automated: true, manual: true });
    expect(await loadSetupProgress()).toEqual({
      copied: true,
      added: false,
      automated: true,
      manual: true,
    });
    await clearSetupProgress();
    expect(await loadSetupProgress()).toEqual({
      copied: false,
      added: false,
      automated: false,
      manual: false,
    });
  });
});
