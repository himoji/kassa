/*
 * Identity check (KYC), simulated: deterministic outcomes and reason codes for fictitious documents, no network,
 * and the answer never carries the full document number, the name or the date of birth.
 */
import { afterAll, describe, expect, it } from "vitest";

import { buildMockWorld, type MockWorld } from "../src/app.ts";
import { StaticRates } from "../src/bank/rates.ts";
import { ManualClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { ageOn, checkIdentity, compareNames, type KycCheckBody } from "../src/kyc/kyc.ts";
import { RecordingSink } from "../src/webhooks.ts";

const NOW = new Date("2026-10-16T10:00:00Z");
const clock = new ManualClock(NOW.getTime());
const worlds: MockWorld[] = [];

async function world() {
  const w = await buildMockWorld({
    config: loadConfig({ NODE_ENV: "test", MOCK_HMAC_SECRET: "s3cret" } as NodeJS.ProcessEnv),
    clock,
    webhooks: new RecordingSink(),
    rates: new StaticRates(),
    logger: false,
    startTicker: false,
  });
  worlds.push(w);
  return w;
}
afterAll(async () => {
  for (const w of worlds) await w.app.close();
});

/** A fictitious passport for a fictitious person. */
const body = (over: { document?: Partial<KycCheckBody["document"]>; liveness?: KycCheckBody["liveness"]["result"]; accountName?: string } = {}): KycCheckBody => ({
  accountName: over.accountName ?? "Test Person",
  document: { type: "PASSPORT", number: "TX1234567", country: "KZ", fullName: "Test Person", dateOfBirth: "2000-04-17", expiresOn: "2030-01-31", ...over.document },
  liveness: { result: over.liveness ?? "PASS" },
});

describe("identity check (simulated KYC)", () => {
  it("verifies a matching, valid document with a passed liveness step", () => {
    const r = checkIdentity(body(), NOW);
    expect(r).toMatchObject({ outcome: "VERIFIED", reasonCodes: [], document: { type: "PASSPORT", country: "KZ", last4: "4567" }, simulated: true, provider: "mock-kyc" });
  });

  it("is deterministic: same input, same day → same checkId and outcome", () => {
    expect(checkIdentity(body(), NOW)).toEqual(checkIdentity(body(), new Date(NOW)));
    expect(checkIdentity(body(), NOW).checkId).not.toBe(checkIdentity(body({ document: { number: "TX7654321" } }), NOW).checkId);
  });

  it.each([
    ["liveness failed", body({ liveness: "FAIL" }), "REJECTED", ["LIVENESS_FAILED"]],
    ["liveness inconclusive", body({ liveness: "INCONCLUSIVE" }), "REVIEW", ["LIVENESS_INCONCLUSIVE"]],
    ["document expired yesterday", body({ document: { expiresOn: "2026-10-15" } }), "REJECTED", ["DOCUMENT_EXPIRED"]],
    ["expires today is still valid", body({ document: { expiresOn: "2026-10-16" } }), "VERIFIED", []],
    ["under 18 (turns 18 tomorrow)", body({ document: { dateOfBirth: "2008-10-17" } }), "REJECTED", ["UNDER_18"]],
    ["18 today", body({ document: { dateOfBirth: "2008-10-16" } }), "VERIFIED", []],
    ["date of birth in the future", body({ document: { dateOfBirth: "2027-01-01" } }), "REJECTED", ["DATE_OF_BIRTH_INVALID"]],
    ["not a real date", body({ document: { dateOfBirth: "2000-02-30" } }), "REJECTED", ["DATE_OF_BIRTH_INVALID"]],
    ["name mismatch", body({ document: { fullName: "Other Someone" } }), "REJECTED", ["NAME_MISMATCH"]],
    ["middle name left out", body({ document: { fullName: "Test Middle Person" } }), "REVIEW", ["NAME_PARTIAL_MATCH"]],
    ["number too short", body({ document: { number: "AB12" } }), "REJECTED", ["DOCUMENT_NUMBER_INVALID"]],
    ["test number for manual review", body({ document: { number: "TX1234000" } }), "REVIEW", ["MANUAL_REVIEW"]],
    ["several reasons at once", body({ liveness: "FAIL", document: { expiresOn: "2020-01-01", fullName: "Other Someone" } }), "REJECTED", ["LIVENESS_FAILED", "DOCUMENT_EXPIRED", "NAME_MISMATCH"]],
  ] as const)("%s", (_label, b, outcome, reasons) => {
    const r = checkIdentity(b, NOW);
    expect(r.outcome).toBe(outcome);
    expect(r.reasonCodes).toEqual(reasons);
  });

  it("compares names by their letters in any order, case and accents ignored, in any script", () => {
    expect(compareNames("PERSON, Test", "test person")).toBe("MATCH");
    expect(compareNames("Tést Persón", "Test Person")).toBe("MATCH");
    expect(compareNames("Тест Персонов", "персонов тест")).toBe("MATCH");
    expect(compareNames("Test Person", "Test Persons")).toBe("MISMATCH");
    expect(compareNames("", "Test")).toBe("MISMATCH");
    expect(ageOn("2000-02-29", "2018-02-28")).toBe(17);
    expect(ageOn("2000-02-29", "2018-03-01")).toBe(18);
  });

  it("POST /mock/kyc/checks answers the outcome without the full number, name or date of birth; GET returns the outcome", async () => {
    const w = await world();
    const res = await w.app.inject({ method: "POST", url: "/mock/kyc/checks", payload: body({ document: { expiresOn: "2026-01-01" } }) });
    expect(res.statusCode).toBe(200);
    const r = res.json() as { checkId: string; outcome: string; reasonCodes: string[] };
    expect(r).toMatchObject({ outcome: "REJECTED", reasonCodes: ["DOCUMENT_EXPIRED"], simulated: true });
    for (const secret of ["TX1234567", "Test Person", "2000-04-17"]) expect(res.body).not.toContain(secret);
    const got = await w.app.inject({ url: `/mock/kyc/checks/${r.checkId}` });
    expect(got.json()).toMatchObject({ checkId: r.checkId, outcome: "REJECTED", simulated: true });
    expect((await w.app.inject({ url: "/mock/kyc/checks/kyc_nope" })).statusCode).toBe(404);
    await w.app.inject({ method: "POST", url: "/mock/reset" });
    expect((await w.app.inject({ url: `/mock/kyc/checks/${r.checkId}` })).statusCode).toBe(404);
  });

  it("refuses a malformed request with 400", async () => {
    const w = await world();
    const bad = await w.app.inject({ method: "POST", url: "/mock/kyc/checks", payload: { ...body(), document: { ...body().document, country: "Kazakhstan" } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "BAD_REQUEST" });
  });
});
