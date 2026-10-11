import { describe, expect, it } from "@jest/globals";

import { createLocalStorage, KEY_PREFIX } from "../storage.web";

/** Minimal Web Storage (HTML §12.2.1) over a Map. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("web storage adapter (localStorage)", () => {
  it("round-trips values under the app prefix, async only (no sync API on web)", async () => {
    const backing = fakeStorage();
    const s = createLocalStorage(() => backing);
    expect(s.getItemSync).toBeUndefined();
    await s.setItem("readynative:language", "en");
    expect(backing.getItem(`${KEY_PREFIX}readynative:language`)).toBe("en");
    expect(await s.getItem("readynative:language")).toBe("en");
    await s.removeItem("readynative:language");
    expect(await s.getItem("readynative:language")).toBeNull();
  });

  it("keys() and clear() only touch this app's entries", async () => {
    const backing = fakeStorage({
      other: "keep",
      [`${KEY_PREFIX}a`]: "1",
      [`${KEY_PREFIX}b`]: "2",
    });
    const s = createLocalStorage(() => backing);
    expect((await s.keys!()).sort()).toEqual(["a", "b"]);
    await s.clear!();
    expect(await s.keys!()).toEqual([]);
    expect(backing.getItem("other")).toBe("keep");
  });

  it("without localStorage (static rendering in Node, blocked storage) reads null and writes nothing", async () => {
    const s = createLocalStorage(() => null);
    await expect(s.setItem("k", "v")).resolves.toBeUndefined();
    expect(await s.getItem("k")).toBeNull();
    expect(await s.keys!()).toEqual([]);
  });

  it("a full quota rejects, so callers' catch paths run", async () => {
    const backing = fakeStorage();
    backing.setItem = () => {
      throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    };
    await expect(createLocalStorage(() => backing).setItem("k", "v")).rejects.toThrow("quota");
  });
});
