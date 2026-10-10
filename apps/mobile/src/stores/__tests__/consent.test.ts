import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { storage } from "@/lib/storage";

import {
  CONSENT_VERSION,
  consentStore,
  markConsentPrompted,
  parseConsent,
  setConsent,
  setDoNotSell,
} from "../consent";

const KEY = "readynative:consent";

const UNDECIDED = {
  analytics: null,
  crash: null,
  doNotSell: false,
  version: null,
  decidedAt: null,
  updatedAt: null,
  source: null,
};

describe("consent store", () => {
  beforeEach(() => {
    consentStore.reset();
  });

  it("starts undecided", () => {
    expect(consentStore.getState()).toEqual(UNDECIDED);
  });

  it("setConsent records the choice with a versioned record and persists", async () => {
    const first = new Date("2026-09-21T10:00:00Z");
    const second = new Date("2026-09-22T10:00:00Z");
    setConsent({ analytics: true }, "sheet", first);
    setConsent({ crash: false }, "settings", second);
    expect(consentStore.getState()).toEqual({
      analytics: true,
      crash: false,
      doNotSell: false,
      version: CONSENT_VERSION,
      decidedAt: first.toISOString(),
      updatedAt: second.toISOString(),
      source: "settings",
    });
    await expect(storage.getItem(KEY)).resolves.toBe(JSON.stringify(consentStore.getState()));
  });

  it("markConsentPrompted stamps the record without deciding", () => {
    markConsentPrompted("sheet", new Date("2026-09-21T10:00:00Z"));
    expect(consentStore.getState()).toMatchObject({
      analytics: null,
      crash: null,
      version: CONSENT_VERSION,
      decidedAt: "2026-09-21T10:00:00.000Z",
      source: "sheet",
    });
  });

  it("'Do not sell' is persisted, and turning analytics on lifts it", () => {
    setDoNotSell(true);
    expect(consentStore.getState()).toMatchObject({ doNotSell: true, source: "do-not-sell" });
    setConsent({ analytics: true });
    expect(consentStore.getState().doNotSell).toBe(false);
  });

  it("reads the record written before it had a version", () => {
    const legacy = JSON.stringify({ analytics: true, crash: false, promptedAt: "2026-01-01" });
    expect(parseConsent(legacy)).toEqual({
      analytics: true,
      crash: false,
      doNotSell: false,
      version: 1,
      decidedAt: "2026-01-01",
      updatedAt: "2026-01-01",
      source: "legacy",
    });
    const never = JSON.stringify({ analytics: null, crash: null, promptedAt: null });
    expect(parseConsent(never)).toEqual(UNDECIDED);
  });

  it("hydrate ignores a malformed persisted value", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await storage.setItem(KEY, JSON.stringify({ analytics: "yes", crash: null, promptedAt: null }));
    await consentStore.hydrate();
    expect(consentStore.getState()).toEqual(UNDECIDED);
    warn.mockRestore();
  });
});
