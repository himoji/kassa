/* The per-turn context block (agent/context.ts): the user's date and time, language and home currency. */
import { describe, expect, it } from "vitest";

import { contextPrompt, validTimeZone } from "../../src/modules/agent/context.ts";

const NOW = new Date("2026-10-20T19:30:00Z");

describe("contextPrompt", () => {
  it("states the date, weekday and time in the device's zone", () => {
    const p = contextPrompt({ timeZone: "Asia/Almaty", locale: "ru", homeCurrency: "KZT", region: "KZ" }, NOW);
    expect(p).toContain("Wednesday, 21 October 2026, 00:30 (2026-10-21), time zone Asia/Almaty (UTC+05:00)");
    expect(p).toContain("The app is set to Russian");
    expect(p).toContain("Home currency: KZT; region: KZ.");
  });

  it("falls back to the server's zone for a missing or bogus zone", () => {
    expect(validTimeZone("Mars/Olympus")).toBeNull();
    expect(contextPrompt({ timeZone: "Mars/Olympus" }, NOW)).toMatch(/time zone Europe\/Budapest \(UTC\+02:00\)/);
    expect(contextPrompt({}, NOW)).toContain("Reply in the language of the user's message.");
  });
});
