/*
 * Business M4: GET /business/forecast, /inventory, /sales/today, /purchase-orders are owner-only (BUSINESS account,
 * its own merchant). A PERSONAL user gets 403; no session gets 401.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_IDS, IDS, SEED_NOW, SHA_BOX_SHORTAGE } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { recordSale } from "../../src/modules/business/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();
const URLS = ["/api/business/forecast", "/api/business/inventory", "/api/business/sales/today", "/api/business/purchase-orders"];

describe("Business routes (M4)", () => {
  beforeEach(async () => {
    await t.reset();
    clock.freezeForTests(new Date(SEED_NOW));
    await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
  });
  afterEach(() => clock.freezeForTests(null));

  it("the Shanghai owner sees 400 boxes short; Budapest sees none", async () => {
    const sha = await app().inject({ method: "GET", url: "/api/business/forecast", headers: await bearer(BUSINESS_IDS.sha.user) });
    expect(sha.statusCode, sha.body).toBe(200);
    expect(sha.json().merchant.slug).toBe("sha");
    expect(sha.json().shortages.map((l: { sku: string; shortage: number }) => [l.sku, l.shortage])).toEqual([["BOX-33CM", SHA_BOX_SHORTAGE]]);
    const bud = await app().inject({ method: "GET", url: "/api/business/forecast", headers: await bearer(BUSINESS_IDS.bud.user) });
    expect(bud.json().shortages).toEqual([]);
    const inv = await app().inject({ method: "GET", url: "/api/business/inventory", headers: await bearer(BUSINESS_IDS.sha.user) });
    expect(inv.json().items.find((i: { sku: string }) => i.sku === "BOX-33CM").shortage).toBe(SHA_BOX_SHORTAGE);
  });

  it("sales today: the merchant-local day's units and revenue", async () => {
    await recordSale({ merchantSlug: "sha", items: [{ sku: "PZ-MARG", qty: 2, unitPriceMinor: 6800 }], at: new Date(SEED_NOW), refType: "SHOP_ORDER", refId: "o-1" });
    const res = await app().inject({ method: "GET", url: "/api/business/sales/today", headers: await bearer(BUSINESS_IDS.sha.user) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ day: "2026-10-27", totalUnits: 2, revenueMinor: 13600 });
  });

  it("a PERSONAL user gets 403 BUSINESS_ACCOUNT_REQUIRED; no session gets 401; /me carries accountType", async () => {
    for (const url of URLS) {
      const res = await app().inject({ method: "GET", url, headers: await bearer(IDS.user) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code ?? res.json().title, url).toMatch(/BUSINESS_ACCOUNT_REQUIRED/);
      expect((await app().inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    const me = async (id: string) => (await app().inject({ method: "GET", url: "/api/me", headers: await bearer(id) })).json().accountType;
    expect(await me(IDS.user)).toBe("PERSONAL");
    expect(await me(BUSINESS_IDS.sha.user)).toBe("BUSINESS");
  });
});
