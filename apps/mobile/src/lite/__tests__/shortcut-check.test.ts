import { describe, expect, it, jest } from "@jest/globals";

import {
  aiSetupPrompt,
  checkShortcutConnection,
  clearSetupProgress,
  loadSetupStarted,
  saveSetupStarted,
  shortcutUrlWithKey,
  tapCheckLines,
  tapCheckPassed,
  type TapCheck,
} from "../shortcut-check";

const SERVER = "https://kassa.example.com";

function fetchReturning(status: number, body: unknown) {
  return jest.fn(async (_url: unknown, _init: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  })) as unknown as typeof fetch & jest.Mock;
}

const check = (over: Partial<TapCheck> = {}): TapCheck => ({
  at: "2026-10-15T10:00:00.000Z",
  kind: "PAYMENT",
  via: "shortcut",
  fields: { merchant: true, amount: true, card: true, place: false },
  status: "LOGGED",
  transactionId: "00000000-0000-4000-8000-000000000001",
  ...over,
});

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
    expect(
      await checkShortcutConnection(SERVER, "k", fetchReturning(200, { status: "LOGGED" }))
    ).toBe("failed");
    const down = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    expect(await checkShortcutConnection(SERVER, "k", down)).toBe("unreachable");
  });
});

describe("shortcutUrlWithKey", () => {
  it("is the endpoint with the key as a query parameter", () => {
    expect(shortcutUrlWithKey(SERVER, "ksc_a+b")).toBe(
      "https://kassa.example.com/api/capture/shortcut?key=ksc_a%2Bb"
    );
  });
});

describe("tap check", () => {
  it("a complete tap passes; card and place are only tips", () => {
    const c = check({ fields: { merchant: true, amount: true, card: false, place: false } });
    expect(tapCheckPassed(c)).toBe(true);
    expect(tapCheckLines(c).map((l) => `${l.key}:${l.state}`)).toEqual([
      "reached:ok",
      "merchant:ok",
      "amount:ok",
      "card:tip",
      "place:tip",
      "logged:ok",
    ]);
  });

  it("no amount (INCOMPLETE) or an unreadable one (UNPARSED) needs a fix", () => {
    const incomplete = check({
      kind: "INCOMPLETE",
      status: null,
      transactionId: null,
      fields: { merchant: true, amount: false, card: true, place: false },
    });
    expect(tapCheckPassed(incomplete)).toBe(false);
    expect(
      tapCheckLines(incomplete)
        .filter((l) => l.state === "fix")
        .map((l) => l.key)
    ).toEqual(["amount", "logged"]);
    const unparsed = check({ status: "UNPARSED", transactionId: null });
    expect(tapCheckLines(unparsed).find((l) => l.key === "amount")?.state).toBe("fix");
  });

  it("a duplicate or a refund still counts as working; a test run never passes", () => {
    expect(tapCheckPassed(check({ status: "MERGED" }))).toBe(true);
    expect(tapCheckPassed(check({ status: "IGNORED_INCOMING" }))).toBe(true);
    expect(tapCheckPassed(check({ kind: "TEST", status: null }))).toBe(false);
  });

  it("a forwarded SMS has no card or place lines", () => {
    expect(tapCheckLines(check({ kind: "FORWARDED" })).map((l) => l.key)).toEqual([
      "reached",
      "merchant",
      "amount",
      "logged",
    ]);
  });
});

describe("aiSetupPrompt", () => {
  it("names the action when the build has it, the URL steps otherwise, and never a key", () => {
    expect(aiSetupPrompt(true)).toContain("Log Payment in Kassa");
    expect(aiSetupPrompt(true)).not.toContain("Get Contents of URL");
    expect(aiSetupPrompt(false)).toContain("Get Contents of URL");
    expect(aiSetupPrompt(false)).not.toMatch(/ksc_|key=/);
  });
});

describe("setup started flag", () => {
  it("round-trips and clears", async () => {
    expect(await loadSetupStarted()).toBe(false);
    await saveSetupStarted();
    expect(await loadSetupStarted()).toBe(true);
    await clearSetupProgress();
    expect(await loadSetupStarted()).toBe(false);
  });
});
