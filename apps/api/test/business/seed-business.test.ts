/*
 * Business M0: the demo seed (personas) inserts the two pizzerias as BUSINESS users with their merchant, inventory,
 * recipes, supplier packs, sales history and stock ledger; on-hand stock read from the DB equals the fixture's.
 * The pos-low-dough demo trigger sends a body mock-world's POS emitter accepts (it used to send a lowercase SKU and a
 * string level, which mock-world rejects with 400).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_IDS, pizzeriaBud, pizzeriaSha, seedForecastShortage } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { merchants, payees, salesDaily, supplierItems, users } from "../../src/db/schema.ts";
import { merchantBySlug, merchantOfOwner, onHand } from "../../src/modules/business/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";

const t = useTestDb();
const app = useTestApp();

describe("Business seed (M0)", () => {
  beforeEach(async () => {
    await t.reset();
    await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
  });

  it("seeds both pizzerias as BUSINESS owners; everyone else stays PERSONAL", async () => {
    const rows = await getDb().select({ id: users.id, accountType: users.accountType }).from(users);
    const business = rows.filter((r) => r.accountType === "BUSINESS").map((r) => r.id).sort();
    expect(business).toEqual([BUSINESS_IDS.bud.user, BUSINESS_IDS.sha.user].sort());
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect((await getDb().select().from(merchants)).map((m) => m.slug).sort()).toEqual(["bud", "sha"]);
  });

  it("merchant lookups, supplier packs on the owner's own payees, and 28 days of sales", async () => {
    const sha = (await merchantOfOwner(BUSINESS_IDS.sha.user))!;
    expect(sha).toMatchObject({ slug: "sha", currency: "CNY", region: "CN", timezone: "Asia/Shanghai" });
    expect((await merchantBySlug("bud"))!.ownerUserId).toBe(BUSINESS_IDS.bud.user);
    const items = await getDb().select().from(supplierItems).where(eq(supplierItems.merchantId, sha.id));
    const own = new Set((await getDb().select({ id: payees.id }).from(payees).where(eq(payees.userId, BUSINESS_IDS.sha.user))).map((p) => p.id));
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(own.has(i.supplierPayeeId)).toBe(true);
    expect(await getDb().select().from(salesDaily).where(eq(salesDaily.merchantId, sha.id))).toHaveLength(28 * 6);
  });

  it("on-hand stock from stock_movements equals the fixture's; Shanghai is 400 boxes short by tomorrow", async () => {
    for (const p of [pizzeriaBud, pizzeriaSha]) {
      const db = await onHand(p.business.merchant.id);
      const expected = seedForecastShortage(p.business);
      for (const [sku, f] of Object.entries(expected)) expect(db[sku], `${p.persona} ${sku}`).toBe(f.onHand);
    }
    expect(seedForecastShortage(pizzeriaSha.business)["BOX-33CM"]!.shortage).toBe(400);
  });

  it("the business personas can be claimed with demoClaim", async () => {
    for (const persona of ["pizzeria-bud", "pizzeria-sha", "li-wei-cn"]) {
      const res = await app().inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "Owner", demoClaim: persona } });
      expect(res.statusCode, `${persona}: ${res.body}`).toBe(200);
    }
  });
});

describe("demo trigger pos-low-dough", () => {
  let mw: TestMockWorld;
  beforeAll(async () => {
    mw = await startMockWorld();
  });
  afterAll(async () => {
    await mw.close();
  });

  it("is accepted by mock-world's POS emitter (202) and the signed webhook is logged by the API", async () => {
    await t.reset();
    await seedDatabase(getDb(), await loadSeedData(), { reset: true });
    const res = await app().inject({ method: "POST", url: "/api/demo/trigger/pos-low-dough" });
    expect(res.statusCode).toBe(200);
    const mock = res.json().result.mock as Record<string, unknown>;
    expect(mock.error).toBeUndefined();
    expect(mock.event).toMatchObject({ type: "stock.level", storeId: "bud", sku: "DOUGH-BALL", level: 12, unit: "pcs" });
    const delivered = await deliverWebhooks(mw, app());
    expect(delivered.find((d) => d.kind === "pos")?.statusCode).toBe(200);
  });
});
