import { describe, expect, it } from "@jest/globals";

import type { ShortcutAttempt } from "@/api/hooks/shortcut";

import { attemptsSince, attemptVerdict, testState, type Answers } from "../shortcut-test";

const ALL = { merchant: true, amount: true, card: true, place: false };
const NONE = { merchant: false, amount: false, card: false, place: false };

function attempt(over: Partial<ShortcutAttempt>): ShortcutAttempt {
  return {
    at: "2026-10-18T10:00:10.000Z",
    deviceId: "d1",
    kind: "PAYMENT",
    via: "shortcut",
    client: "BackgroundShortcutRunner",
    fields: ALL,
    status: "LOGGED",
    problem: null,
    replyTitle: "Logged HUF 2,100.00 at Blue Bottle",
    payment: { merchant: "Blue Bottle", amountMinor: 210000, currency: "HUF" },
    ...over,
  };
}

const START = "2026-10-18T10:00:00.000Z";
const NO: Answers = { amountMatches: null, notificationShown: null };

describe("live Shortcut test", () => {
  it("waits until something arrives after the start; older requests do not count", () => {
    const old = attempt({ at: "2026-10-18T09:00:00.000Z" });
    expect(testState(attemptsSince([old], START), NO).kind).toBe("waiting");
  });

  it("a run by hand proves the link and key, not the Apple Pay trigger", () => {
    const run = attempt({ kind: "TEST", fields: NONE, status: null, payment: null });
    expect(attemptVerdict(run).tone).toBe("info");
    expect(testState([run], NO).kind).toBe("manualOnly");
  });

  it("names the problem of a refused request", () => {
    for (const [a, key] of [
      [attempt({ kind: "REVOKED_KEY", fields: NONE, status: null, payment: null }), "revokedKey"],
      [
        attempt({
          kind: "BAD_BODY",
          problem: "The request body is not JSON",
          status: null,
          payment: null,
        }),
        "badBody",
      ],
      [
        attempt({
          kind: "INCOMPLETE",
          fields: { ...NONE, merchant: true },
          status: null,
          payment: null,
        }),
        "noAmount",
      ],
      [attempt({ status: "UNPARSED", payment: null }), "amountUnreadable"],
      [attempt({ fields: { ...ALL, merchant: false } }), "noMerchant"],
    ] as const) {
      const s = testState([a], NO);
      expect(s.kind).toBe("fix");
      if (s.kind === "fix") expect(s.verdict.key).toBe(key);
    }
  });

  it("never passes without the person's two confirmations", () => {
    const ok = attempt({});
    expect(testState([ok], NO).kind).toBe("confirm");
    expect(testState([ok], { amountMatches: true, notificationShown: null }).kind).toBe("confirm");
    expect(testState([ok], { amountMatches: false, notificationShown: true }).kind).toBe(
      "wrongAmount"
    );
    expect(testState([ok], { amountMatches: true, notificationShown: false }).kind).toBe(
      "noNotification"
    );
    expect(testState([ok], { amountMatches: true, notificationShown: true }).kind).toBe("passed");
  });

  it("a purchase sent by a browser or script does not prove the automation", () => {
    expect(
      testState([attempt({ client: "curl" })], { amountMatches: true, notificationShown: true })
        .kind
    ).toBe("notShortcuts");
    expect(testState([attempt({ client: "Mozilla" })], NO).kind).toBe("notShortcuts");
    // The KassaLite action runs inside Shortcuts; its client is the app itself.
    expect(testState([attempt({ via: "action", client: "KassaLite" })], NO).kind).toBe("confirm");
  });

  it("a refusal after a good purchase is the current problem", () => {
    const good = attempt({ at: "2026-10-18T10:00:10.000Z" });
    const revoked = attempt({
      at: "2026-10-18T10:00:20.000Z",
      kind: "REVOKED_KEY",
      fields: NONE,
      status: null,
      payment: null,
    });
    expect(testState(attemptsSince([good, revoked], START), NO).kind).toBe("fix");
    // A good purchase after a refusal: fixed.
    const later = attempt({ at: "2026-10-18T10:00:30.000Z" });
    expect(testState(attemptsSince([good, revoked, later], START), NO).kind).toBe("confirm");
  });
});
