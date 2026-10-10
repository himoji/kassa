import { describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";

import { createMemoryStorage, type StorageAdapter } from "@/lib/storage-adapter";

import { createPersistedStore } from "../create-store";

interface State {
  count: number;
  name: string;
}

const KEY = "test:store";
const initial: State = { count: 0, name: "a" };

function make(seed?: Record<string, string>) {
  const storage = createMemoryStorage(seed);
  const store = createPersistedStore<State>({ key: KEY, initial, storage });
  return { storage, store };
}

describe("createPersistedStore", () => {
  it("starts with the initial state and is not hydrated", () => {
    const { store } = make();
    expect(store.getState()).toEqual(initial);
    expect(store.isHydrated()).toBe(false);
  });

  it("setState with a partial notifies subscribers and persists", async () => {
    const { store, storage } = make();
    const listener = jest.fn();
    store.subscribe(listener);

    store.setState({ count: 5 });

    expect(store.getState()).toEqual({ count: 5, name: "a" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storage.dump()).toEqual({ [KEY]: JSON.stringify({ count: 5, name: "a" }) });
    expect(await storage.getItem(KEY)).toBe(JSON.stringify({ count: 5, name: "a" }));
  });

  it("setState with an updater receives the previous state", () => {
    const { store, storage } = make();
    store.setState({ count: 2 });
    store.setState((prev) => ({ count: prev.count + 1 }));
    expect(store.getState().count).toBe(3);
    expect(JSON.parse(storage.dump()[KEY]!)).toEqual({ count: 3, name: "a" });
  });

  it("unsubscribe stops notifications", () => {
    const { store } = make();
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.setState({ count: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("hydrate restores persisted state merged over initial", async () => {
    const { store } = make({ [KEY]: JSON.stringify({ count: 9 }) });
    await store.hydrate();
    expect(store.getState()).toEqual({ count: 9, name: "a" });
    expect(store.isHydrated()).toBe(true);
  });

  it("hydrate with nothing stored keeps initial and marks hydrated", async () => {
    const { store } = make();
    await store.hydrate();
    expect(store.getState()).toEqual(initial);
    expect(store.isHydrated()).toBe(true);
  });

  it("hydrate ignores corrupt JSON", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { store } = make({ [KEY]: "{not json" });
    await store.hydrate();
    expect(store.getState()).toEqual(initial);
    expect(store.isHydrated()).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("hydrate is idempotent", async () => {
    const { store } = make({ [KEY]: JSON.stringify({ count: 1 }) });
    const first = store.hydrate();
    const second = store.hydrate();
    expect(second).toBe(first);
    await first;
    store.setState({ count: 7 });
    await store.hydrate();
    expect(store.getState().count).toBe(7);
  });

  it("async hydrate does not clobber a setState that landed while getItem was pending", async () => {
    // Web-style adapter: no sync methods, and a getItem we resolve by hand.
    const map = new Map<string, string>([[KEY, JSON.stringify({ count: 9, name: "stored" })]]);
    let resolveGet: (value: string | null) => void = () => {};
    const storage: StorageAdapter = {
      getItem: () => new Promise((resolve) => (resolveGet = resolve)),
      setItem: async (key, value) => {
        map.set(key, value);
      },
      removeItem: async (key) => {
        map.delete(key);
      },
    };
    const store = createPersistedStore<State>({ key: KEY, initial, storage });

    const hydration = store.hydrate();
    store.setState({ count: 42 });
    resolveGet(map.get(KEY) ?? null);
    await hydration;

    expect(store.isHydrated()).toBe(true);
    expect(store.getState()).toEqual({ count: 42, name: "a" });
    expect(JSON.parse(map.get(KEY)!)).toEqual({ count: 42, name: "a" });
  });

  it("async hydrate applies the stored value when nothing changed meanwhile", async () => {
    const storage: StorageAdapter = {
      getItem: async () => JSON.stringify({ count: 9 }),
      setItem: async () => {},
      removeItem: async () => {},
    };
    const store = createPersistedStore<State>({ key: KEY, initial, storage });
    await store.hydrate();
    expect(store.getState()).toEqual({ count: 9, name: "a" });
  });

  it("a failed read is reported, not mistaken for 'nothing stored'", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const storage: StorageAdapter = {
      getItem: () => Promise.reject(new Error("disk I/O")),
      setItem: async () => {},
      removeItem: async () => {},
    };
    const store = createPersistedStore<State>({ key: KEY, initial, storage });
    await store.hydrate();
    expect(store.isHydrated()).toBe(true);
    expect(store.hydrationFailed()).toBe(true);
    expect(store.getState()).toEqual(initial);
    // A fresh answer from the user replaces the unknown one.
    store.setState({ count: 1 });
    expect(store.hydrationFailed()).toBe(false);
    expect(make().store.hydrationFailed()).toBe(false);
    warn.mockRestore();
  });

  it("reset restores initial and clears storage", () => {
    const { store, storage } = make();
    const listener = jest.fn();
    store.subscribe(listener);
    store.setState({ count: 4, name: "z" });
    store.reset();
    expect(store.getState()).toEqual(initial);
    expect(storage.dump()).toEqual({});
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("useStore re-renders with the whole state and with a selector", async () => {
    const { store } = make();
    const whole = await renderHook(() => store.useStore());
    const selected = await renderHook(() => store.useStore((s) => s.count));

    expect(whole.result.current).toEqual(initial);
    expect(selected.result.current).toBe(0);

    await act(() => {
      store.setState({ count: 3 });
    });

    expect(whole.result.current).toEqual({ count: 3, name: "a" });
    expect(selected.result.current).toBe(3);
  });

  it("useHydrated flips after hydrate", async () => {
    const { store } = make();
    const { result } = await renderHook(() => store.useHydrated());
    expect(result.current).toBe(false);
    await act(async () => {
      await store.hydrate();
    });
    expect(result.current).toBe(true);
  });
});
