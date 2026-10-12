/*
 * Business M4: business.forecastTick drafts one DRAFT purchase order per supplier for a new shortage (VERIFIED
 * supplier, whole packs), notifies the owner, dedupes per (merchant, SKU, day), and never signs anything (I6).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_IDS, SEED_NOW } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { notifications, purchaseOrders } from "../../src/db/schema.ts";
import { forecastTick } from "../../src/modules/business/scheduler.ts";
import { clock, DAY_MS } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { tick } from "../../src/modules/scheduler/index.ts";
import { useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();

describe("business.forecastTick (M4)", () => {
  beforeEach(async () => {
    await t.reset();
    clock.freezeForTests(new Date(SEED_NOW));
    await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
  });
  afterEach(() => clock.freezeForTests(null));

  it("drafts 4 packs of boxes from supplier C for Shanghai, nothing for Budapest, and notifies the owner once", async () => {
    const [d, again] = [await forecastTick(), await forecastTick()];
    expect(again).toEqual([]);
    expect(d).toHaveLength(1);
    const pos = await getDb().select().from(purchaseOrders);
    expect(pos).toHaveLength(1);
    const po = pos[0]!;
    expect(po).toMatchObject({ merchantId: BUSINESS_IDS.sha.merchant, supplierPayeeId: BUSINESS_IDS.sha.payees.supplierC, status: "DRAFT", createdBy: "SCHEDULER", currency: "CNY", signedAt: null, poHash: null, core: null });
    expect(po.lines).toEqual([{ supplierSku: "BOX-33CM-100", inventorySku: "BOX-33CM", packSize: 100, packs: 4, packPriceMinor: 18000, lineTotalMinor: 72000 }]);
    expect(po.totalMinor).toBe(72000);
    const notes = await getDb().select().from(notifications).where(eq(notifications.userId, BUSINESS_IDS.sha.user));
    expect(notes.filter((n) => n.kind === "BUSINESS_SHORTAGE")).toHaveLength(1);
    expect(await getDb().select().from(notifications).where(eq(notifications.userId, BUSINESS_IDS.bud.user))).toHaveLength(0);
  });

  it("runs as a scheduler job; an open PO for the SKU blocks a new draft on a later day too", async () => {
    await tick();
    expect(await getDb().select().from(purchaseOrders)).toHaveLength(1);
    clock.freezeForTests(new Date(Date.parse(SEED_NOW) + DAY_MS));
    await forecastTick();
    expect(await getDb().select().from(purchaseOrders)).toHaveLength(1);
    // Once the draft is canceled, the next day's shortage drafts again (one per merchant/SKU/day).
    await getDb().update(purchaseOrders).set({ status: "CANCELED" });
    expect(await forecastTick()).toHaveLength(1);
    expect(await forecastTick()).toHaveLength(0);
  });

  it("the business-forecast demo trigger (Demo Stage) runs the same tick and dedupes", async () => {
    const first = await app().inject({ method: "POST", url: "/api/demo/trigger/business-forecast" });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().result.drafted).toHaveLength(1);
    const again = await app().inject({ method: "POST", url: "/api/demo/trigger/business-forecast" });
    expect(again.json().result.drafted).toEqual([]);
    expect(await getDb().select().from(purchaseOrders)).toHaveLength(1);
  });
});
