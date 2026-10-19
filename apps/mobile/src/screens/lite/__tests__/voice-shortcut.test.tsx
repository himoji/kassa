import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";

import { ThemeProvider } from "@/components/ui";
import { VoiceShortcut } from "../voice-shortcut";

jest.mock("@/lib/haptics", () => ({
  haptics: { success: jest.fn(), warning: jest.fn(), error: jest.fn(), selection: jest.fn() },
}));

const mockCopy = jest.fn(async (..._: unknown[]): Promise<boolean> => true);
jest.mock("@/lib/clipboard", () => ({ copyToClipboard: (...a: unknown[]) => mockCopy(...a) }));

let mockToken: string | null = "ksc_test";
jest.mock("@/lite/shortcut-token", () => ({ loadShortcutToken: async () => mockToken }));
jest.mock("@/lite/server-url", () => ({
  loadServerUrl: async () => "https://kassa.example.com",
  shortcutEndpointFor: (s: string) => `${s}/api/capture/shortcut`,
  voiceEndpointFor: (s: string) => `${s}/api/capture/voice`,
}));

let mockReady: string | null = null;
jest.mock("@/lite/shortcut-check", () => {
  const actual =
    jest.requireActual<typeof import("@/lite/shortcut-check")>("@/lite/shortcut-check");
  return { ...actual, readyVoiceShortcutLink: () => mockReady };
});

const READY = "https://www.icloud.com/shortcuts/fedcba9876543210fedcba9876543210";
const VOICE_LINK = "https://kassa.example.com/api/capture/voice?key=ksc_test";

const ui = () => (
  <ThemeProvider>
    <VoiceShortcut />
  </ThemeProvider>
);

describe("VoiceShortcut", () => {
  beforeEach(() => {
    mockReady = null;
    mockToken = "ksc_test";
    mockCopy.mockClear();
  });

  it("without a published Shortcut: copies the voice link and shows the hand-built steps", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await render(ui());
    expect(screen.getByText(/Name it “Ask Kassa”/)).toBeTruthy();
    fireEvent.press(screen.getByText("Copy voice link"));
    await waitFor(() => expect(mockCopy.mock.calls[0]?.[0]).toBe(VOICE_LINK));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("with a published Shortcut: one button copies the voice link, then opens the iCloud link", async () => {
    mockReady = READY;
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await render(ui());
    expect(screen.queryByText(/Name it “Ask Kassa”/)).toBeNull();
    fireEvent.press(screen.getByText("Add the “Ask Kassa” Shortcut"));
    await waitFor(() => expect(open).toHaveBeenCalledWith(READY));
    expect(mockCopy.mock.calls[0]?.[0]).toBe(VOICE_LINK);
    // The key is only on the clipboard, never in the URL opened.
    expect(String(open.mock.calls[0]?.[0])).not.toContain("ksc_test");
    open.mockRestore();
  });

  it("with no paired key: opens nothing", async () => {
    mockReady = READY;
    mockToken = null;
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await render(ui());
    fireEvent.press(screen.getByText("Add the “Ask Kassa” Shortcut"));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockCopy).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
