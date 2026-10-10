import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";
import { Appearance } from "react-native";

import { storage } from "@/lib/storage";

import {
  hydrateThemeMode,
  setThemeMode,
  themeModeStore,
  useResolvedMode,
  useThemeMode,
} from "../theme-mode";

const KEY = "readynative:theme-mode";

describe("theme-mode store", () => {
  let setColorScheme: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    setColorScheme = jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {});
    themeModeStore.reset();
  });

  afterEach(() => {
    setColorScheme.mockRestore();
  });

  // First: `hydrate()` is idempotent and, on async-only adapters, a store that
  // was already written to (`setThemeMode` below) keeps its in-memory state.
  it("hydrateThemeMode applies the persisted mode", async () => {
    await storage.setItem(KEY, JSON.stringify({ mode: "light" }));
    await hydrateThemeMode();
    expect(themeModeStore.getState().mode).toBe("light");
    expect(setColorScheme).toHaveBeenCalledWith("light");
  });

  it("defaults to system", async () => {
    const { result } = await renderHook(() => useThemeMode());
    expect(result.current).toBe("system");
  });

  it("setThemeMode('dark') updates the hook, Appearance and storage", async () => {
    const { result } = await renderHook(() => useThemeMode());

    await act(() => {
      setThemeMode("dark");
    });

    expect(result.current).toBe("dark");
    expect(setColorScheme).toHaveBeenCalledWith("dark");
    await expect(storage.getItem(KEY)).resolves.toBe(JSON.stringify({ mode: "dark" }));
  });

  it("setThemeMode('system') maps to 'unspecified'", async () => {
    setThemeMode("system");
    expect(setColorScheme).toHaveBeenCalledWith("unspecified");
    await expect(storage.getItem(KEY)).resolves.toBe(JSON.stringify({ mode: "system" }));
  });

  it("useResolvedMode reflects a forced mode without waiting on Appearance", async () => {
    const { result } = await renderHook(() => useResolvedMode());
    expect(result.current).toBe("light"); // jest Appearance mock reports no scheme

    await act(() => {
      setThemeMode("dark");
    });
    expect(result.current).toBe("dark");

    await act(() => {
      setThemeMode("system");
    });
    expect(result.current).toBe("light");
  });
});
