import { describe, expect, it } from "@jest/globals";

import { waitingOnModel } from "../progress";

describe("waitingOnModel", () => {
  it("is true before the reply has parts and between steps", () => {
    expect(waitingOnModel(undefined)).toBe(true);
    expect(waitingOnModel({ role: "user", parts: [{ type: "text", state: "done" }] })).toBe(true);
    expect(waitingOnModel({ role: "assistant", parts: [{ type: "step-start" }] })).toBe(true);
    expect(
      waitingOnModel({
        role: "assistant",
        parts: [{ type: "tool-get_balances", state: "output-available" }, { type: "step-start" }],
      })
    ).toBe(true);
    expect(waitingOnModel({ role: "assistant", parts: [{ type: "text", state: "done" }] })).toBe(
      true
    );
  });

  it("is false while text streams, a tool runs, or a card is pending", () => {
    expect(
      waitingOnModel({ role: "assistant", parts: [{ type: "text", state: "streaming" }] })
    ).toBe(false);
    expect(
      waitingOnModel({
        role: "assistant",
        parts: [{ type: "tool-get_routes", state: "input-available" }],
      })
    ).toBe(false);
    expect(waitingOnModel({ role: "assistant", parts: [{ type: "data-routes" }] })).toBe(false);
  });
});
