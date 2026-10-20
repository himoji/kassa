import { describe, expect, it } from "@jest/globals";
import type { NotificationDto } from "@kassa/shared";

import { BANNER_KINDS, freshNotifications } from "../use-live-feed";

const n = (id: string, kind = "MONEY_RECEIVED"): NotificationDto => ({
  id,
  kind,
  title: "t",
  body: "b",
  data: null,
  readAt: null,
  createdAt: "2026-10-20T10:00:00.000Z",
});

describe("freshNotifications", () => {
  it("returns only ids it has not seen, and remembers them", () => {
    const seen = new Set<string>();
    expect(freshNotifications(seen, [n("a"), n("b")]).map((x) => x.id)).toEqual(["a", "b"]);
    expect(freshNotifications(seen, [n("c"), n("a"), n("b")]).map((x) => x.id)).toEqual(["c"]);
    expect(freshNotifications(seen, [n("c")])).toEqual([]);
  });

  it("banners only money from someone else", () => {
    expect(BANNER_KINDS.has("MONEY_RECEIVED")).toBe(true);
    expect(BANNER_KINDS.has("BUDGET_WARNING")).toBe(false);
  });
});
