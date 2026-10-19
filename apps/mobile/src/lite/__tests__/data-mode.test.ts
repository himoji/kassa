import { describe, expect, it } from "@jest/globals";
import type { RecentCapture, RecentCapturesResponse } from "@kassa/shared";

import { readyShortcutLink, readyVoiceShortcutLink } from "../shortcut-check";
import {
  dataModeStore,
  isSimulatedCapture,
  setDataMode,
  visibleCaptures,
  visibleResponse,
} from "../data-mode";

function capture(id: string, over: Partial<RecentCapture>): RecentCapture {
  return {
    id,
    source: "SHORTCUT",
    merchant: id,
    amountMinor: 100,
    currency: "HUF",
    homeAmountMinor: null,
    category: null,
    occurredAt: "2026-10-27T08:00:00.000Z",
    createdAt: "2026-10-27T08:00:01.234Z",
    ...over,
  };
}

const TAP = capture("tap", {});
const SIM = capture("sim", { source: "NOTIF_SIM" });
// The demo seed writes createdAt = occurredAt.
const SEEDED = capture("seeded", { createdAt: "2026-10-27T08:00:00.000Z" });

describe("data mode", () => {
  it("defaults to real and persists the choice", async () => {
    await dataModeStore.hydrate();
    expect(dataModeStore.getState().mode).toBe("real");
    setDataMode("simulated");
    expect(dataModeStore.getState().mode).toBe("simulated");
    dataModeStore.reset();
    expect(dataModeStore.getState().mode).toBe("real");
  });

  it("simulated: the notification simulator and the demo seed; a real tap is not", () => {
    expect(isSimulatedCapture(SIM)).toBe(true);
    expect(isSimulatedCapture(SEEDED)).toBe(true);
    expect(isSimulatedCapture(TAP)).toBe(false);
    expect(isSimulatedCapture(capture("text", { source: "TEXT" }))).toBe(false);
  });

  it("real hides simulated purchases; simulated shows everything", () => {
    expect(visibleCaptures([TAP, SIM, SEEDED], "real").map((c) => c.id)).toEqual(["tap"]);
    expect(visibleCaptures([TAP, SIM, SEEDED], "simulated").map((c) => c.id)).toEqual([
      "tap",
      "sim",
      "seeded",
    ]);
  });

  it("keeps the response object when nothing is hidden", () => {
    const res: RecentCapturesResponse = {
      captures: [TAP],
      nudges: [],
      serverTime: "2026-10-27T09:00:00.000Z",
    };
    expect(visibleResponse(res, "real")).toBe(res);
    const mixed = { ...res, captures: [TAP, SIM] };
    expect(visibleResponse(mixed, "real")).toEqual({ ...res, captures: [TAP] });
  });
});

describe("readyShortcutLink", () => {
  it("accepts only an iCloud Shortcuts link", () => {
    const link = "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef";
    expect(readyShortcutLink(link)).toBe(link);
    expect(readyShortcutLink(` ${link} `)).toBe(link);
    expect(readyShortcutLink(undefined)).toBeNull();
    expect(readyShortcutLink("")).toBeNull();
    expect(readyShortcutLink("http://www.icloud.com/shortcuts/abc")).toBeNull();
    expect(readyShortcutLink("https://evil.example/shortcuts/abc")).toBeNull();
    expect(readyShortcutLink("https://www.icloud.com/shortcuts/abc?key=x")).toBeNull();
  });
});

describe("readyVoiceShortcutLink", () => {
  it("accepts only an iCloud Shortcuts link, like the tap Shortcut's", () => {
    const link = "https://www.icloud.com/shortcuts/fedcba9876543210fedcba9876543210";
    expect(readyVoiceShortcutLink(link)).toBe(link);
    expect(readyVoiceShortcutLink(undefined)).toBeNull();
    expect(readyVoiceShortcutLink("https://www.icloud.com/shortcuts/abc#key=x")).toBeNull();
  });
});
