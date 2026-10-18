/*
 * GET /obligations: each bank-payable bill due within 45 days carries the cheapest funding route the rules would bind
 * (rules/funding.ts, spec §12 optimizer) and a coverage status. Coverage never fails open: unknown balances or a
 * failed check are UNKNOWN, not COVERED. The wallet is read once for the whole list.
 */
import { ObligationsResponse } from "@kassa/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { clock, DAY_MS, isoDate } from "../../src/modules/clock/index.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { addObligation, addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

const dueIn = (days: number) => isoDate(new Date(clock.now().getTime() + days * DAY_MS));

async function setup() {
  const { userId } = await createUserWithPasskey();
  const landlord = await addPayee(userId, { name: "Landlord", currency: "HUF" });
  const university = await addPayee(userId, { name: "University", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" });
  const rent = await addObligation(userId, landlord.id, { amountMinor: 18_000_000, currency: "HUF", dueDate: dueIn(5) });
  const tuition = await addObligation(userId, university.id, { amountMinor: 240_000, currency: "EUR", category: "tuition", dueDate: dueIn(10) });
  return { userId, h: await bearer(userId), rent, tuition };
}

async function list(h: { authorization: string }) {
  const res = await app().inject({ method: "GET", url: "/api/obligations", headers: h });
  expect(res.statusCode, res.body).toBe(200);
  return ObligationsResponse.parse(res.json()).obligations;
}

describe("GET /obligations: best route and coverage", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("returns the cheapest bank route for each covered bill, reading the wallet once", async () => {
    const { h, rent, tuition } = await setup();
    let reads = 0;
    setBalanceProviderForTests(async () => {
      reads++;
      return [
        { currency: "HUF", amountMinor: 50_000_000 },
        { currency: "KZT", amountMinor: 500_000_000 },
      ];
    });
    const obs = await list(h);
    expect(reads).toBe(1);

    const r = obs.find((o) => o.id === rent.id)!;
    expect(r.coverage).toBe("COVERED");
    // HUF bill from the HUF balance: direct, no conversion (huf-mock-bank: fee 0, no markup).
    expect(r.bestRoute).toMatchObject({ routeId: "huf-mock-bank:HUF", fundingCurrency: "HUF", rail: "BANK_TRANSFER", costHomeMinor: 0, noConversion: true });

    // EUR bill, no EUR balance: funded by conversion from HUF or KZT, whichever is cheapest in the home currency.
    const tu = obs.find((o) => o.id === tuition.id)!;
    expect(tu.coverage).toBe("COVERED");
    expect(tu.bestRoute?.rail).toBe("BANK_TRANSFER");
    expect(["HUF", "KZT"]).toContain(tu.bestRoute?.fundingCurrency);
    expect(tu.bestRoute?.markupBps).toBeGreaterThan(0);
    expect(tu.bestRoute?.costHomeMinor).toBeGreaterThan(0);
    expect(tu.bestRoute?.noConversion).toBeUndefined();
  });

  it("SHORTFALL with no route when no single balance pays the bill", async () => {
    const { h, rent } = await setup();
    setBalanceProviderForTests(async () => [{ currency: "HUF", amountMinor: 1_000 }]);
    const r = (await list(h)).find((o) => o.id === rent.id)!;
    expect(r.coverage).toBe("SHORTFALL");
    expect(r.bestRoute).toBeNull();
  });

  it("UNKNOWN, not COVERED, when the balances are unknown", async () => {
    const { h } = await setup();
    setBalanceProviderForTests(async () => null);
    const obs = await list(h);
    expect(obs.map((o) => o.coverage)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(obs.every((o) => o.bestRoute === null)).toBe(true);
  });

  it("UNKNOWN, not COVERED, when the funding check throws", async () => {
    const { h } = await setup();
    setBalanceProviderForTests(async () => {
      throw new Error("bank down");
    });
    const obs = await list(h);
    expect(obs.map((o) => o.coverage)).toEqual(["UNKNOWN", "UNKNOWN"]);
  });
});
