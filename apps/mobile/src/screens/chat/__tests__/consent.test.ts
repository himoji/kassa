import { describe, expect, it } from "@jest/globals";

import { KassaApiError } from "@/api/errors";

import { consentNeeded } from "../consent";

const body = (o: unknown) => new Error(JSON.stringify(o));

describe("consentNeeded (Y3)", () => {
  it("reads PIPL_CONSENT_REQUIRED with the notice text", () => {
    const r = consentNeeded(
      body({
        status: 403,
        code: "PIPL_CONSENT_REQUIRED",
        details: { aiNotice: { text: "Region CN (PIPL): …" } },
      })
    );
    expect(r).toEqual({
      code: "PIPL_CONSENT_REQUIRED",
      noticeText: "Region CN (PIPL): …",
      endpoint: "/privacy/pipl-consent",
    });
  });

  it("reads AI_CONSENT_REQUIRED", () => {
    expect(consentNeeded(body({ code: "AI_CONSENT_REQUIRED" }))).toEqual({
      code: "AI_CONSENT_REQUIRED",
      noticeText: null,
      endpoint: "/privacy/ai-consent",
    });
  });

  it("ignores other errors and non-JSON messages", () => {
    expect(consentNeeded(body({ code: "RATE_LIMITED" }))).toBeNull();
    expect(consentNeeded(new Error("Network request failed"))).toBeNull();
    expect(consentNeeded("x")).toBeNull();
  });

  it("reads a parsed api.request() refusal (POST /onboarding/message)", () => {
    const err = new KassaApiError(403, {
      error: "Agree to AI processing first",
      code: "AI_CONSENT_REQUIRED",
      reasonCodes: ["AI_CONSENT_REQUIRED"],
      details: { aiNotice: { text: "You are talking to an AI." } },
    });
    expect(consentNeeded(err)).toEqual({
      code: "AI_CONSENT_REQUIRED",
      noticeText: "You are talking to an AI.",
      endpoint: "/privacy/ai-consent",
    });
    expect(consentNeeded(new KassaApiError(409, { error: "x", code: "CONFLICT" }))).toBeNull();
  });
});
