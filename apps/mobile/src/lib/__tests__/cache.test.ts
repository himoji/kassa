import { describe, expect, it } from "@jest/globals";

import { createOfflineCache } from "@/lib/cache";
import { createMemoryStorage } from "@/lib/storage-adapter";

describe("offline cache", () => {
  it("round-trips a value with the time it was saved", () => {
    const storage = createMemoryStorage();
    const cache = createOfflineCache(storage);
    const before = Date.now();

    cache.write("forecast:1", { temp: 21 });
    const hit = cache.read<{ temp: number }>("forecast:1");

    expect(hit?.value).toEqual({ temp: 21 });
    expect(hit?.savedAt).toBeGreaterThanOrEqual(before);
    expect(Object.keys(storage.dump())).toEqual(["readynative:cache:forecast:1"]);
  });

  it("reads asynchronously too", async () => {
    const cache = createOfflineCache(createMemoryStorage());
    cache.write("k", [1, 2]);
    await expect(cache.readAsync<number[]>("k")).resolves.toMatchObject({ value: [1, 2] });
  });

  it("treats missing and corrupt entries as a miss", () => {
    const storage = createMemoryStorage({ "readynative:cache:bad": "{not json" });
    const cache = createOfflineCache(storage);
    expect(cache.read("missing")).toBeNull();
    expect(cache.read("bad")).toBeNull();
  });

  it("returns null synchronously on an async-only adapter", () => {
    const { getItemSync: _get, setItemSync: _set, ...asyncOnly } = createMemoryStorage();
    const cache = createOfflineCache(asyncOnly);
    cache.write("k", 1);
    expect(cache.read("k")).toBeNull();
  });
});
