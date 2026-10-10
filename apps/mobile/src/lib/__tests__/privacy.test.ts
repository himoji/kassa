import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { analytics } from "@/lib/analytics";
import { storage } from "@/lib/storage";

import {
  WIPE_KEEP_KEYS,
  exportFileName,
  exportLocalData,
  onWipeLocalData,
  shareDataExport,
  wipeLocalData,
} from "../privacy";

// The export file goes through expo-file-system + expo-sharing; an in-memory cache directory
// records what is written, shared and deleted.
const mockWritten: { uri?: string; content?: string } = {};
jest.mock("expo-file-system", () => {
  const files = new Map<string, string>();
  class File {
    uri: string;
    name: string;
    constructor(dir: { uri: string }, name: string) {
      this.name = name;
      this.uri = `${dir.uri}${name}`;
    }
    get exists() {
      return files.has(this.name);
    }
    create() {
      files.set(this.name, "");
    }
    write(content: string) {
      files.set(this.name, content);
    }
    delete() {
      files.delete(this.name);
    }
  }
  const cache = {
    uri: "file:///cache/",
    list: () => [...files.keys()].map((n) => new File(cache, n)),
  };
  return { File, Paths: { cache }, files };
});
const mockCacheFiles = (jest.requireMock("expo-file-system") as { files: Map<string, string> })
  .files;
const mockShareAsync = jest.fn((_uri: string, _opts?: object) => Promise.resolve());
jest.mock("expo-sharing", () => ({
  isAvailableAsync: () => Promise.resolve(true),
  shareAsync: (uri: string, opts?: object) => mockShareAsync(uri, opts),
}));

describe("privacy (local data)", () => {
  beforeEach(async () => {
    await storage.clear?.();
    await storage.setItem("readynative:theme-mode", JSON.stringify({ mode: "dark" }));
    await storage.setItem("readynative:consent", JSON.stringify({ analytics: true }));
    await storage.setItem("posthog:distinct_id", "abc");
    await storage.setItem("notes", JSON.stringify([{ id: 1 }]));
  });

  it("exports every key, parsing JSON where it can", async () => {
    const json = JSON.parse(await exportLocalData()) as { exportedAt: string; data: unknown };
    expect(typeof json.exportedAt).toBe("string");
    expect(json.data).toEqual({
      notes: [{ id: 1 }],
      "posthog:distinct_id": "abc",
      "readynative:consent": { analytics: true },
      "readynative:theme-mode": { mode: "dark" },
    });
  });

  it("never exports credentials: token keys are skipped, token fields redacted", async () => {
    const session = { access_token: "jwt.a.b", refresh_token: "r1", user: { id: "u1" } };
    await storage.setItem("sb-abcd-auth-token", JSON.stringify(session));
    await storage.setItem("profile", JSON.stringify({ name: "Ada", nested: { password: "pw" } }));
    const out = await exportLocalData();
    expect(out).not.toContain("jwt.a.b");
    expect(out).not.toContain("r1");
    expect(out).not.toContain('"pw"');
    const json = JSON.parse(out) as { data: Record<string, unknown> };
    expect(json.data["sb-abcd-auth-token"]).toBeUndefined();
    expect(json.data.profile).toEqual({ name: "Ada", nested: { password: "[redacted]" } });
  });

  it("adds the signed-in user's profile as `account`", async () => {
    const json = JSON.parse(
      await exportLocalData({ user: { id: "u1", email: "ada@example.com", name: "Ada" } })
    ) as { account?: unknown };
    expect(json.account).toEqual({ id: "u1", email: "ada@example.com", name: "Ada" });
  });

  it("shares the export as my-data-<date>.json", async () => {
    const now = new Date("2026-09-24T12:00:00Z");
    expect(exportFileName(now)).toBe("my-data-2026-09-24.json");
    mockShareAsync.mockImplementationOnce((uri: string) => {
      mockWritten.uri = uri;
      mockWritten.content = mockCacheFiles.get("my-data-2026-09-24.json");
      return Promise.resolve();
    });
    await expect(shareDataExport('{"a":1}', { title: "My data", now })).resolves.toBe(true);
    expect(mockWritten).toEqual({
      uri: "file:///cache/my-data-2026-09-24.json",
      content: '{"a":1}',
    });
    // Nothing stays in the cache once the sheet is done.
    expect(mockCacheFiles.size).toBe(0);
    expect(mockShareAsync).toHaveBeenCalledWith(
      "file:///cache/my-data-2026-09-24.json",
      expect.objectContaining({ mimeType: "application/json", UTI: "public.json" })
    );
  });

  it("wipes everything except the kept preferences, resets analytics, runs wipe hooks", async () => {
    const reset = jest.spyOn(analytics, "reset");
    const hook = jest.fn<() => void>();
    const off = onWipeLocalData(hook);
    mockCacheFiles.set("my-data-2026-01-01.json", "{}");
    mockCacheFiles.set("other.bin", "x");
    const removed = await wipeLocalData();
    expect(removed.sort()).toEqual(["notes", "posthog:distinct_id"]);
    expect((await storage.keys?.())?.sort()).toEqual([
      "readynative:consent",
      "readynative:theme-mode",
    ]);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(1);
    // An export left behind by an interrupted share goes too; other cache files stay.
    expect([...mockCacheFiles.keys()]).toEqual(["other.bin"]);
    expect(WIPE_KEEP_KEYS).toContain("readynative:consent");
    off();
    reset.mockRestore();
  });

  it("honours a custom keep list", async () => {
    await wipeLocalData({ keep: ["notes"] });
    expect(await storage.keys?.()).toEqual(["notes"]);
  });
});
