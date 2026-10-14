import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { RecentCapture, RecentCapturesResponse } from "@kassa/shared";

import { storage } from "@/lib/storage";
import { capturesSince, LAST_SEEN_KEY, notificationRoute, notifyNewCaptures } from "../notifier";

const mockSchedule = jest.fn((_: unknown) => Promise.resolve("id"));
let mockGranted = true;
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: () => Promise.resolve({ granted: mockGranted, canAskAgain: false }),
  requestPermissionsAsync: () => Promise.resolve({ granted: mockGranted }),
  scheduleNotificationAsync: (arg: unknown) => mockSchedule(arg),
}));

let n = 0;
function capture(createdAt: string, merchant = "Cafe Frei"): RecentCapture {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    source: "shortcut",
    merchant,
    amountMinor: 129000,
    currency: "HUF",
    homeAmountMinor: null,
    category: null,
    occurredAt: createdAt,
    createdAt,
  };
}
function response(serverTime: string, captures: RecentCapture[]): RecentCapturesResponse {
  return { serverTime, captures, nudges: [] };
}

describe("notifyNewCaptures", () => {
  beforeEach(async () => {
    mockSchedule.mockClear();
    mockGranted = true;
    await storage.removeItem(LAST_SEEN_KEY);
  });

  it("first run only records the watermark: old purchases never notify", async () => {
    const count = await notifyNewCaptures(
      response("2026-10-27T10:00:00.000Z", [capture("2026-10-27T09:00:00.000Z")])
    );
    expect(count).toBe(0);
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(await storage.getItem(LAST_SEEN_KEY)).toBe("2026-10-27T10:00:00.000Z");
  });

  it("notifies only for captures newer than the last seen serverTime", async () => {
    await storage.setItem(LAST_SEEN_KEY, "2026-10-27T10:00:00.000Z");
    const count = await notifyNewCaptures(
      response("2026-10-27T10:05:00.000Z", [
        capture("2026-10-27T09:59:00.000Z", "Old shop"),
        capture("2026-10-27T10:02:00.000Z", "New shop"),
      ])
    );
    expect(count).toBe(1);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const arg = mockSchedule.mock.calls[0]?.[0] as {
      content: { body: string };
      trigger: unknown;
    };
    expect(arg.trigger).toBeNull();
    expect(arg.content.body).toContain("New shop");
    expect(arg.content.body).not.toContain("Old shop");
    // A tap opens that purchase.
    expect((arg.content as { data?: { url?: string } }).data?.url).toMatch(/^\/purchase\/0{8}-/);
    expect(await storage.getItem(LAST_SEEN_KEY)).toBe("2026-10-27T10:05:00.000Z");
  });

  it("does not notify twice for the same purchase", async () => {
    await storage.setItem(LAST_SEEN_KEY, "2026-10-27T10:00:00.000Z");
    const same = response("2026-10-27T10:05:00.000Z", [capture("2026-10-27T10:02:00.000Z")]);
    await notifyNewCaptures(same);
    await notifyNewCaptures({ ...same, serverTime: "2026-10-27T10:06:00.000Z" });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst into one summary notification", async () => {
    await storage.setItem(LAST_SEEN_KEY, "2026-10-27T10:00:00.000Z");
    const burst = [1, 2, 3, 4].map((i) => capture(`2026-10-27T10:0${i}:00.000Z`));
    expect(await notifyNewCaptures(response("2026-10-27T10:10:00.000Z", burst))).toBe(4);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it("still advances the watermark when notifications are not permitted", async () => {
    mockGranted = false;
    await storage.setItem(LAST_SEEN_KEY, "2026-10-27T10:00:00.000Z");
    await notifyNewCaptures(
      response("2026-10-27T10:05:00.000Z", [capture("2026-10-27T10:02:00.000Z")])
    );
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(await storage.getItem(LAST_SEEN_KEY)).toBe("2026-10-27T10:05:00.000Z");
  });
});

describe("capturesSince", () => {
  it("is strict and returns oldest first", () => {
    const a = capture("2026-10-27T10:01:00.000Z");
    const b = capture("2026-10-27T10:03:00.000Z");
    const edge = capture("2026-10-27T10:00:00.000Z");
    expect(capturesSince([b, edge, a], "2026-10-27T10:00:00.000Z")).toEqual([a, b]);
  });
});

describe("notificationRoute", () => {
  const res = (url: unknown) =>
    ({ notification: { request: { content: { data: { url } } } } }) as unknown as Parameters<
      typeof notificationRoute
    >[0];
  it("follows in-app routes only", () => {
    expect(notificationRoute(res("/purchase/abc"))).toBe("/purchase/abc");
    expect(notificationRoute(res("https://evil.example"))).toBeNull();
    expect(notificationRoute(res("//evil.example/x"))).toBeNull();
    expect(notificationRoute(res(42))).toBeNull();
  });
});
