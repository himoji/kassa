import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";

import { ThemeProvider } from "@/components/ui";
import { clearSetupProgress } from "@/lite/shortcut-check";
import { ShortcutSetup } from "../shortcut-setup";

type Devices = {
  devices: unknown[];
  lastCaptureAt: string | null;
  lastUsedAt?: string | null;
  lastCheck?: unknown;
};
let mockDevices: Devices = { devices: [], lastCaptureAt: null, lastUsedAt: null, lastCheck: null };
const mockPoll = jest.fn((_: unknown) => {});
jest.mock("@/api/hooks/shortcut", () => ({
  useShortcutDevices: (pollMs: unknown) => {
    mockPoll(pollMs);
    return { data: mockDevices };
  },
}));

const mockSuccess = jest.fn();
const mockWarning = jest.fn();
jest.mock("@/lib/haptics", () => ({
  haptics: {
    success: () => mockSuccess(),
    warning: () => mockWarning(),
    error: jest.fn(),
    selection: jest.fn(),
  },
}));

const mockCopy = jest.fn(async (..._: unknown[]): Promise<boolean> => true);
jest.mock("@/lib/clipboard", () => ({ copyToClipboard: (...a: unknown[]) => mockCopy(...a) }));

let mockHasAction = false;
const mockSync = jest.fn(async () => {});
jest.mock("@/lite/intent-config", () => ({
  hasLogPaymentAction: async () => mockHasAction,
  syncIntentConfig: () => mockSync(),
}));
jest.mock("@/lite/shortcut-token", () => ({ loadShortcutToken: async () => "ksc_test" }));
jest.mock("@/lite/server-url", () => ({
  loadServerUrl: async () => "https://kassa.example.com",
  shortcutEndpointFor: (s: string) => `${s}/api/capture/shortcut`,
}));
jest.mock("@/lite/use-recent-captures", () => ({
  RECENT_KEY: ["lite", "recent"],
  fetchRecent: async () => ({
    captures: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        merchant: "Blue Bottle",
        amountMinor: 210000,
        currency: "HUF",
      },
    ],
    nudges: [],
    serverTime: "2026-10-15T10:00:00.000Z",
  }),
}));

const mockCheck = jest.fn(async (..._: unknown[]) => "ok");
let mockReady: string | null = null;
jest.mock("@/lite/shortcut-check", () => {
  const actual =
    jest.requireActual<typeof import("@/lite/shortcut-check")>("@/lite/shortcut-check");
  return {
    ...actual,
    checkShortcutConnection: (...a: unknown[]) => mockCheck(...a),
    readyShortcutLink: () => mockReady,
  };
});

const mockToast = jest.fn((_: unknown) => {});
jest.mock("@/components/ui", () => {
  const actual = jest.requireActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { ...actual.toast, show: (o: unknown) => mockToast(o) } };
});

const READY = "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef";

const PAYMENT = {
  at: "2026-10-15T10:00:00.000Z",
  kind: "PAYMENT",
  via: "shortcut",
  fields: { merchant: true, amount: true, card: true, place: false },
  status: "LOGGED",
  transactionId: "00000000-0000-4000-8000-000000000001",
};

function ui() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <ShortcutSetup />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

describe("ShortcutSetup", () => {
  beforeEach(async () => {
    // "Set up" is remembered on the phone (KV store, shared across tests here).
    await clearSetupProgress();
    mockDevices = { devices: [], lastCaptureAt: null, lastUsedAt: null, lastCheck: null };
    mockHasAction = false;
    mockReady = null;
    mockCopy.mockImplementation(async () => true);
    for (const m of [
      mockCheck,
      mockPoll,
      mockSuccess,
      mockWarning,
      mockCopy,
      mockSync,
      mockToast,
    ]) {
      m.mockClear();
    }
  });

  it("not set up: one button; it checks the server, copies the link with the key and opens Shortcuts", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await render(ui());
    expect(screen.getByText("Log every Apple Pay purchase")).toBeTruthy();
    // The manual steps stay out of the main path.
    expect(screen.queryByTestId("setup-steps")).toBeNull();
    fireEvent.press(screen.getByText("Set up Apple Pay logging"));
    await waitFor(() => expect(open).toHaveBeenCalledWith("shortcuts://"));
    expect(mockCheck).toHaveBeenCalledWith("https://kassa.example.com", "ksc_test");
    expect(mockCopy.mock.calls[0]?.[0]).toBe(
      "https://kassa.example.com/api/capture/shortcut?key=ksc_test"
    );
    await waitFor(() =>
      expect(screen.getByText("Waiting for your first Apple Pay tap")).toBeTruthy()
    );
    expect(screen.getByText(/Get Contents of URL → paste/)).toBeTruthy();
    expect(screen.queryByTestId("setup-steps")).toBeNull();
    expect(mockPoll).toHaveBeenLastCalledWith(5000);
    await fireEvent.press(screen.getByText("Manual setup"));
    expect(screen.getByTestId("setup-steps")).toBeTruthy();
  });

  it("with a ready-made Shortcut: the key goes on the clipboard, the iCloud link opens, one line says what is left", async () => {
    mockReady = READY;
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    open.mockClear();
    await render(ui());
    fireEvent.press(screen.getByText("Set up Apple Pay logging"));
    await waitFor(() => expect(open).toHaveBeenCalledWith(READY));
    expect(mockCopy.mock.calls[0]?.[0]).toBe(
      "https://kassa.example.com/api/capture/shortcut?key=ksc_test"
    );
    expect(mockCopy.mock.calls[0]?.[1]).toEqual({
      toast: "Link copied: paste it in the Shortcut when asked",
    });
    // The key is never in a URL the app opens.
    for (const [url] of open.mock.calls) expect(String(url)).not.toContain("ksc_test");
    await waitFor(() => expect(screen.getByText(/paste when asked/)).toBeTruthy());
    expect(screen.getByText("Copy link and add the Shortcut")).toBeTruthy();
  });

  it("a ready-made Shortcut is not added again to fix a tap: Fix opens Shortcuts", async () => {
    mockReady = READY;
    mockDevices = {
      ...mockDevices,
      lastCheck: { ...PAYMENT, fields: { ...PAYMENT.fields, merchant: false } },
    };
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    open.mockClear();
    await render(ui());
    fireEvent.press(screen.getByText("Fix in Shortcuts"));
    await waitFor(() => expect(open).toHaveBeenCalledWith("shortcuts://"));
    expect(open).not.toHaveBeenCalledWith(READY);
  });

  it("a failed copy says so and does not open Shortcuts", async () => {
    mockCopy.mockImplementation(async () => false);
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    open.mockClear();
    await render(ui());
    fireEvent.press(screen.getByText("Set up Apple Pay logging"));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not copy the link. Try again." })
      )
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("with the action in the build: no link is copied, the action's Keychain copy is written", async () => {
    mockHasAction = true;
    jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await render(ui());
    await waitFor(() => expect(mockCopy).not.toHaveBeenCalled());
    fireEvent.press(screen.getByText("Set up Apple Pay logging"));
    await waitFor(() => expect(mockSync).toHaveBeenCalled());
    expect(mockCopy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/Log Payment in Kassa/)).toBeTruthy());
  });

  it("a revoked key says so and does not open Shortcuts", async () => {
    mockCheck.mockResolvedValueOnce("revoked");
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    open.mockClear(); // the jest preset's Linking.openURL is a shared jest.fn
    await render(ui());
    fireEvent.press(screen.getByText("Set up Apple Pay logging"));
    await waitFor(() => expect(screen.getByText(/refused this iPhone's key/)).toBeTruthy());
    expect(open).not.toHaveBeenCalled();
  });

  it("a complete tap: every line checked, with the merchant and amount Kassa logged", async () => {
    mockDevices = { ...mockDevices, lastUsedAt: PAYMENT.at, lastCheck: PAYMENT };
    await render(ui());
    expect(screen.getByText("Everything works")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Merchant: Blue Bottle")).toBeTruthy());
    expect(screen.getByText(/Amount: .*2,100/)).toBeTruthy();
    expect(screen.getByTestId("check-place-tip")).toBeTruthy();
    expect(screen.getByTestId("check-logged-ok")).toBeTruthy();
    expect(screen.queryByText("Fix in Shortcuts")).toBeNull();
    // Already there when the card opened: no celebration.
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it("a tap without an amount: says what to fix, keeps checking, and warns when it arrives", async () => {
    await render(ui());
    mockDevices = {
      ...mockDevices,
      lastCheck: {
        ...PAYMENT,
        kind: "INCOMPLETE",
        status: null,
        transactionId: null,
        fields: { merchant: true, amount: false, card: true, place: false },
      },
    };
    await screen.rerender(ui());
    await waitFor(() =>
      expect(screen.getByText("Kassa got your tap: 2 things to fix")).toBeTruthy()
    );
    expect(screen.getByText(/Amount was empty/)).toBeTruthy();
    expect(screen.getByText("Fix in Shortcuts")).toBeTruthy();
    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockPoll).toHaveBeenLastCalledWith(5000);
  });

  it("copies steps for an AI assistant without the key", async () => {
    mockDevices = { ...mockDevices, lastCheck: { ...PAYMENT, kind: "TEST", status: null } };
    await render(ui());
    await fireEvent.press(screen.getByText("Manual setup"));
    fireEvent.press(screen.getByText("Copy steps for AI"));
    await waitFor(() => expect(mockCopy).toHaveBeenCalled());
    expect(String(mockCopy.mock.calls[0]?.[0])).toContain("Get Contents of URL");
    expect(String(mockCopy.mock.calls[0]?.[0])).not.toContain("ksc_test");
  });
});
