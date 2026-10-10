import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { Linking, Platform, Share } from "react-native";

import { openExternal, openUrl } from "@/lib/browser";
import { copyToClipboard, readClipboard } from "@/lib/clipboard";
import { shareText, shareUrl } from "@/lib/share";
import { toast } from "@/components/ui";

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
  getStringAsync: jest.fn(async () => "from clipboard"),
}));

jest.mock("expo-web-browser", () => ({
  openBrowserAsync: jest.fn(async () => ({ type: "opened" as const })),
}));

const setStringAsync = Clipboard.setStringAsync as jest.Mock<typeof Clipboard.setStringAsync>;
const openBrowserAsync = WebBrowser.openBrowserAsync as jest.Mock<
  typeof WebBrowser.openBrowserAsync
>;

let openURL: jest.SpiedFunction<typeof Linking.openURL>;

beforeEach(() => {
  openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  openURL.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  setStringAsync.mockClear();
  setStringAsync.mockImplementation(async () => true);
  openBrowserAsync.mockClear();
  openBrowserAsync.mockResolvedValue({ type: "opened" as WebBrowser.WebBrowserResultType });
});

describe("@/lib/browser", () => {
  it("opens http(s) links in the in-app browser", async () => {
    await openUrl("https://example.com");
    expect(openBrowserAsync).toHaveBeenCalledWith("https://example.com");
    expect(openURL).not.toHaveBeenCalled();
  });

  it("falls back to Linking when the in-app browser fails", async () => {
    openBrowserAsync.mockImplementation(async () => {
      throw new Error("no browser");
    });
    await openUrl("https://example.com");
    expect(openURL).toHaveBeenCalledWith("https://example.com");
  });

  it("hands non-web schemes to Linking", async () => {
    await openUrl("mailto:hi@example.com");
    expect(openBrowserAsync).not.toHaveBeenCalled();
    expect(openURL).toHaveBeenCalledWith("mailto:hi@example.com");
  });

  it("openExternal always uses Linking and swallows errors", async () => {
    openURL.mockRejectedValue(new Error("unsupported"));
    await expect(openExternal("https://example.com")).resolves.toBeUndefined();
    expect(openURL).toHaveBeenCalledWith("https://example.com");
  });
});

describe("@/lib/clipboard", () => {
  it("copies and shows the default toast", async () => {
    const show = jest.spyOn(toast, "show").mockImplementation(() => {});
    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(setStringAsync).toHaveBeenCalledWith("hello");
    expect(show).toHaveBeenCalledWith({ title: "Copied" });
  });

  it("supports a custom toast title and silence", async () => {
    const show = jest.spyOn(toast, "show").mockImplementation(() => {});
    await copyToClipboard("a", { toast: "Link copied" });
    expect(show).toHaveBeenCalledWith({ title: "Link copied" });
    show.mockClear();
    await copyToClipboard("b", { toast: false });
    expect(show).not.toHaveBeenCalled();
  });

  it("returns false and skips the toast when the clipboard fails", async () => {
    const show = jest.spyOn(toast, "show").mockImplementation(() => {});
    setStringAsync.mockImplementation(async () => {
      throw new Error("denied");
    });
    await expect(copyToClipboard("x")).resolves.toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it("reads the clipboard", async () => {
    await expect(readClipboard()).resolves.toBe("from clipboard");
  });
});

describe("@/lib/share", () => {
  it("passes url separately on iOS", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const share = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: Share.sharedAction, activityType: null });
    await expect(shareText({ message: "Hi", url: "https://x.y", title: "T" })).resolves.toBe(true);
    expect(share).toHaveBeenCalledWith(
      { message: "Hi", url: "https://x.y", title: "T" },
      { dialogTitle: "T", subject: "T" }
    );
  });

  it("folds url into message on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const share = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: Share.sharedAction, activityType: null });
    await shareText({ message: "Hi", url: "https://x.y" });
    expect(share.mock.calls[0]?.[0]).toEqual({ message: "Hi\nhttps://x.y", title: undefined });
    await shareUrl("https://x.y");
    expect(share.mock.calls[1]?.[0]).toEqual({ message: "https://x.y", title: undefined });
  });

  it("returns false when dismissed or when sharing throws", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const share = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: Share.dismissedAction, activityType: null });
    await expect(shareUrl("https://x.y")).resolves.toBe(false);
    share.mockRejectedValue(new Error("nope"));
    await expect(shareUrl("https://x.y")).resolves.toBe(false);
  });
});
