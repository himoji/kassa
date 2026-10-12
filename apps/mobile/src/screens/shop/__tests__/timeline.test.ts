import { describe, expect, it } from "@jest/globals";

import { shopPollInterval } from "../../../api/hooks/shop";
import { timelineSteps } from "../shop-order-timeline";

const at = "2026-10-27T18:00:00.000Z";

describe("shop order timeline", () => {
  it("delivery: done steps, the current one, then the next ones; AWAITING_PAYMENT only when it happened", () => {
    const steps = timelineSteps({
      channel: "DELIVERY",
      status: "COOKING",
      timeline: ["SUBMITTED", "RECEIVED", "ACCEPTED", "COOKING"].map((status) => ({ status, at })),
    });
    expect(steps.map((s) => [s.status, s.state])).toEqual([
      ["SUBMITTED", "done"],
      ["RECEIVED", "done"],
      ["ACCEPTED", "done"],
      ["COOKING", "current"],
      ["OUT_FOR_DELIVERY", "next"],
      ["DELIVERED", "next"],
    ]);
  });

  it("a declined till bill ends with the failed step", () => {
    const steps = timelineSteps({
      channel: "TILL",
      status: "DECLINED",
      timeline: [
        { status: "SUBMITTED", at },
        { status: "DECLINED", at, note: "CARD_ALREADY_USED" },
      ],
    });
    expect(steps.map((s) => [s.status, s.state])).toEqual([
      ["SUBMITTED", "done"],
      ["DECLINED", "failed"],
    ]);
  });

  it("polls every 2 s while any order is open, never when all are final", () => {
    expect(shopPollInterval([{ final: false }, { final: true }] as never)).toBe(2000);
    expect(shopPollInterval([{ final: true }] as never)).toBe(false);
    expect(shopPollInterval(undefined)).toBe(false);
  });
});
