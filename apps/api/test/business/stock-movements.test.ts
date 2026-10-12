/*
 * Business M4: recordSale turns menu units into SALE stock movements by recipe and bumps sales_daily once per
 * (refType, refId), on the merchant's calendar day.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_IDS, SEED_NOW } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { salesDaily, stockMovements } from "../../src/db/schema.ts";
import { onHand, recordSale } from "../../src/modules/business/index.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const SHA = BUSINESS_IDS.sha.merchant;
// 18:00Z = 02:00 the next day in Shanghai.
const AT = new Date("2026-10-27T18:00:00.000Z");

describe("recordSale (M4)", () => {
  beforeEach(async () => {
    await t.reset();
    clock.freezeForTests(new Date(SEED_NOW));
    await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
  });
  afterEach(() => clock.freezeForTests(null));

  it("moves stock by recipe and bumps sales_daily on the merchant's local day", async () => {
    const before = await onHand(SHA);
    const res = await recordSale({ merchantSlug: "sha", items: [{ sku: "PZ-MARG", qty: 2, unitPriceMinor: 6800 }, { sku: "PZ-PEPP", qty: 1 }, { sku: "DR-COLA", qty: 3 }], at: AT, refType: "SHOP_ORDER", refId: "o-1" });
    expect(res).toMatchObject({ recorded: true, merchantId: SHA, day: "2026-10-28" });
    const after = await onHand(SHA);
    const delta = (sku: string) => after[sku]! - before[sku]!;
    expect(delta("BOX-33CM")).toBe(-3);
    expect(delta("DOUGH-BALL")).toBe(-3);
    expect(delta("MOZZ-G")).toBe(-(2 * 125 + 110));
    expect(delta("TOMATO-G")).toBe(-(3 * 80));
    expect(delta("SALAMI-G")).toBe(-60);
    expect(delta("COLA-BTL")).toBe(-3);
    expect(delta("VEG-G")).toBe(0);
    const day = await getDb().select().from(salesDaily).where(and(eq(salesDaily.merchantId, SHA), eq(salesDaily.day, "2026-10-28")));
    expect(Object.fromEntries(day.map((r) => [r.menuSku, [r.qty, r.revenueMinor]]))).toEqual({ "PZ-MARG": [2, 13600], "PZ-PEPP": [1, 0], "DR-COLA": [3, 0] });
  });

  it("is idempotent on (refType, refId), also under concurrent delivery", async () => {
    const sale = { merchantSlug: "sha", items: [{ sku: "PZ-MARG", qty: 1 }], at: AT, refType: "TILL_BILL", refId: "b-7" };
    const results = await Promise.all([recordSale(sale), recordSale(sale), recordSale(sale)]);
    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    expect(await recordSale(sale)).toEqual({ recorded: false, reason: "ALREADY_RECORDED" });
    const rows = await getDb().select().from(stockMovements).where(and(eq(stockMovements.merchantId, SHA), eq(stockMovements.ref, "TILL_BILL:b-7")));
    expect(rows.every((r) => r.kind === "SALE")).toBe(true);
    expect(rows.find((r) => r.sku === "BOX-33CM")!.qty).toBe(-1);
    const day = await getDb().select().from(salesDaily).where(and(eq(salesDaily.merchantId, SHA), eq(salesDaily.day, "2026-10-28"), eq(salesDaily.menuSku, "PZ-MARG")));
    expect(day[0]!.qty).toBe(1);
    // Same refId under another refType is a different sale.
    expect((await recordSale({ ...sale, refType: "SHOP_ORDER" })).recorded).toBe(true);
  });

  it("refuses unknown merchants and empty sales without writing", async () => {
    expect(await recordSale({ merchantSlug: "nope", items: [{ sku: "PZ-MARG", qty: 1 }], at: AT, refType: "X", refId: "1" })).toEqual({ recorded: false, reason: "UNKNOWN_MERCHANT" });
    expect(await recordSale({ merchantSlug: "sha", items: [{ sku: "PZ-MARG", qty: 0 }], at: AT, refType: "X", refId: "1" })).toEqual({ recorded: false, reason: "EMPTY" });
    expect(await getDb().select().from(stockMovements).where(eq(stockMovements.ref, "X:1"))).toHaveLength(0);
  });
});
