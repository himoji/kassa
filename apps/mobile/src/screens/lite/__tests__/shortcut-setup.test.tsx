import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";

import { ThemeProvider } from "@/components/ui";
import { ShortcutSetup } from "../shortcut-setup";

type Devices = { devices: unknown[]; lastCaptureAt: string | null; lastUsedAt?: string | null };
let mockDevices: Devices = { devices: [], lastCaptureAt: null, lastUsedAt: null };
const mockPoll = jest.fn((_: unknown) => {});
jest.mock("@/api/hooks/shortcut", () => ({
  useShortcutDevices: (pollMs: unknown) => {
    mockPoll(pollMs);
    return { data: mockDevices };
  },
}));

const mockSuccess = jest.fn();
jest.mock("@/lib/haptics", () => ({
  haptics: { success: () => mockSuccess(), error: jest.fn(), selection: jest.fn() },
}));

let mockTemplate = "";
jest.mock("@/lite/variant", () => ({ shortcutTemplateUrl: () => mockTemplate }));
jest.mock("@/lite/shortcut-token", () => ({ loadShortcutToken: async () => "ksc_test" }));
jest.mock("@/lite/server-url", () => ({
  loadServerUrl: async () => "https://kassa.example.com",
  shortcutEndpointFor: (s: string) => `${s}/api/capture/shortcut`,
}));

const mockSync = jest.fn(async () => {});
jest.mock("@/lite/intent-config", () => ({ syncIntentConfig: () => mockSync() }));

const mockCheck = jest.fn(async (..._: unknown[]) => "ok");
/** `manual: true`: the Shortcut that posts by itself; false: the "Log Payment in Kassa" action (the default). */
let mockManual = true;
jest.mock("@/lite/shortcut-check", () => {
  const actual =
    jest.requireActual<typeof import("@/lite/shortcut-check")>("@/lite/shortcut-check");
  return {
    ...actual,
    checkShortcutConnection: (...a: unknown[]) => mockCheck(...a),
    loadSetupProgress: async () => ({ ...actual.EMPTY_PROGRESS, manual: mockManual }),
    saveSetupProgress: async () => {},
  };
});

async function renderSetup() {
  await render(
    <ThemeProvider>
      <ShortcutSetup />
    </ThemeProvider>
  );
}

describe("ShortcutSetup", () => {
  beforeEach(() => {
    mockDevices = { devices: [], lastCaptureAt: null, lastUsedAt: null };
    mockTemplate = "";
    mockManual = true;
    mockSync.mockClear();
    mockCheck.mockClear();
    mockPoll.mockClear();
    mockSuccess.mockClear();
  });

  it("action (default): one automation step, nothing to copy, and a way back to the hand-built Shortcut", async () => {
    mockManual = false;
    mockTemplate = "https://www.icloud.com/shortcuts/abc";
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderSetup();
    await waitFor(() =>
      expect(screen.getByText("Add the Kassa action to a Wallet automation")).toBeTruthy()
    );
    expect(screen.getByText("0 of 2 steps done")).toBeTruthy();
    expect(screen.queryByText("Copy setup")).toBeNull();
    expect(screen.queryByText("Get the Shortcut")).toBeNull();

    fireEvent.press(screen.getByText("Check connection"));
    await waitFor(() =>
      expect(screen.getByText("Waiting for your first Apple Pay purchase…")).toBeTruthy()
    );
    expect(mockSync).toHaveBeenCalled();
    // The action is checked from the app: Shortcuts is not opened to run a template.
    expect(open).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText("Set it up by hand instead"));
    await waitFor(() => expect(screen.getByText("Get the Shortcut")).toBeTruthy());
    expect(screen.getByText("Use the Kassa action instead")).toBeTruthy();
    open.mockRestore();
  });

  it("not set up: shows progress and the manual build steps with separate URL / key copy", async () => {
    await renderSetup();
    expect(screen.getByText("Not set up yet")).toBeTruthy();
    expect(screen.getByText("0 of 3 steps done")).toBeTruthy();
    expect(screen.getByText("Copy URL")).toBeTruthy();
    expect(screen.getByText("Copy key")).toBeTruthy();
    expect(screen.getByText("Check connection")).toBeTruthy();
  });

  it("connected: green status with the last purchase time", async () => {
    mockDevices = {
      devices: [],
      lastCaptureAt: "2026-10-15T09:00:00.000Z",
      lastUsedAt: "2026-10-15T09:00:00.000Z",
    };
    await renderSetup();
    expect(screen.getByText("Shortcut is working")).toBeTruthy();
    expect(screen.getByText(/Last purchase logged/)).toBeTruthy();
    // An already working setup is not celebrated on every visit.
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it("manual: a passing connection check waits for the first purchase and polls", async () => {
    await renderSetup();
    fireEvent.press(screen.getByText("Check connection"));
    await waitFor(() =>
      expect(screen.getByText("Waiting for your first Apple Pay purchase…")).toBeTruthy()
    );
    expect(mockCheck).toHaveBeenCalledWith("https://kassa.example.com", "ksc_test");
    expect(mockPoll).toHaveBeenLastCalledWith(5000);
  });

  it("a revoked key says so and does not open Shortcuts", async () => {
    mockTemplate = "https://www.icloud.com/shortcuts/abc";
    mockCheck.mockResolvedValueOnce("revoked");
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderSetup();
    fireEvent.press(screen.getByText("Run test"));
    await waitFor(() => expect(screen.getByText(/The server refused the key/)).toBeTruthy());
    expect(open).not.toHaveBeenCalled();
  });

  it("template: Run test opens the Shortcut and turns green once the server hears from it", async () => {
    mockTemplate = "https://www.icloud.com/shortcuts/abc";
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderSetup();
    expect(screen.getByText("Get the Shortcut")).toBeTruthy();
    fireEvent.press(screen.getByText("Run test"));
    await waitFor(() => expect(screen.getByText("Waiting for the Shortcut…")).toBeTruthy());
    expect(String(open.mock.calls[0]?.[0])).toMatch(
      /^shortcuts:\/\/x-callback-url\/run-shortcut\?name=Kassa/
    );
    expect(mockPoll).toHaveBeenLastCalledWith(2000);

    mockDevices = { devices: [], lastCaptureAt: null, lastUsedAt: "2026-10-15T10:00:00.000Z" };
    await screen.rerender(
      <ThemeProvider>
        <ShortcutSetup />
      </ThemeProvider>
    );
    await waitFor(() => expect(screen.getByText("Shortcut is working")).toBeTruthy());
    expect(screen.getByText(/Last heard from it/)).toBeTruthy();
    expect(mockSuccess).toHaveBeenCalledTimes(1);
  });
});
