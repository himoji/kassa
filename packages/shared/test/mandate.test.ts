import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { jcs, mandateHash, MandateCore, normalizeMandateCore } from "../src/index.ts";

const CORE: MandateCore = {
  v: 1,
  mandateId: "5b0e4c1a-8f2d-4a6b-9c3e-7d1f2a3b4c5d",
  userId: "3f1b3c9e-5d2a-4e8f-9b7c-1a2b3c4d5e6f",
  payeeIds: ["0a0b0c0d-1111-4222-8333-444455556666"],
  categories: ["rent"],
  currency: "HUF",
  maxPerPaymentMinor: 20000000,
  maxPerPeriodMinor: 20000000,
  period: "MONTH",
  validFrom: "2026-10-01T00:00:00.000Z",
  validUntil: null,
};

const CORE_JCS =
  '{"categories":["rent"],"currency":"HUF","mandateId":"5b0e4c1a-8f2d-4a6b-9c3e-7d1f2a3b4c5d",' +
  '"maxPerPaymentMinor":20000000,"maxPerPeriodMinor":20000000,"payeeIds":["0a0b0c0d-1111-4222-8333-444455556666"],' +
  '"period":"MONTH","userId":"3f1b3c9e-5d2a-4e8f-9b7c-1a2b3c4d5e6f","v":1,"validFrom":"2026-10-01T00:00:00.000Z",' +
  '"validUntil":null}';

const MANDATE_HASH = "LfIEO0JliddJ4fhAgb7yYSrJLcLtswOd7BTIBBhGi80";

describe("mandateHash", () => {
  it("canonicalises to the expected JCS text", () => {
    expect(jcs(CORE)).toBe(CORE_JCS);
  });

  it("matches the committed golden vector and node:crypto", () => {
    expect(mandateHash(CORE)).toBe(MANDATE_HASH);
    expect(mandateHash(CORE)).toBe(createHash("sha256").update(jcs(CORE)).digest("base64url"));
  });

  it("requires sorted unique arrays; normalizeMandateCore fixes them", () => {
    const messy = { ...CORE, categories: ["utilities", "rent", "rent"] };
    expect(() => mandateHash(messy)).toThrow();
    expect(normalizeMandateCore(messy).categories).toEqual(["rent", "utilities"]);
  });

  it("rejects per-payment cap above the period cap and inverted validity", () => {
    expect(MandateCore.safeParse({ ...CORE, maxPerPaymentMinor: CORE.maxPerPeriodMinor + 1 }).success).toBe(false);
    expect(MandateCore.safeParse({ ...CORE, validUntil: "2026-09-01T00:00:00.000Z" }).success).toBe(false);
  });
});
