/*
 * Business M4: business/forecast.ts is pure and implements the fixtures' forecast contract exactly, so the seed's
 * own rows reproduce seedForecastShortage: Shanghai is 400 boxes short by the end of tomorrow, Budapest is covered.
 */
import { describe, expect, it } from "vitest";

import { BUSINESS_IDS, pizzeriaBud, pizzeriaSha, SEED_NOW, SHA_BOX_SHORTAGE, seedForecastShortage } from "../../../../fixtures/seed-data.ts";
import { addDays, forecastStock, localDay, type ForecastInput, type ForecastSupplierOption } from "../../src/modules/business/forecast.ts";

type Biz = typeof pizzeriaSha.business;

function inputOf(b: Biz, verified: Set<string>, now = SEED_NOW): ForecastInput {
  const onHand: Record<string, number> = {};
  for (const m of b.stockMovements) if (Date.parse(m.occurredAt) <= Date.parse(now)) onHand[m.sku] = (onHand[m.sku] ?? 0) + m.qty;
  return {
    now: new Date(now),
    timezone: b.merchant.timezone,
    inventory: b.inventory,
    recipes: b.recipes,
    sales: b.salesDaily,
    onHand,
    suppliers: b.supplierItems.map((s) => ({ ...s, supplierName: s.supplierPayeeId, verified: verified.has(s.supplierPayeeId) })),
  };
}

const shaVerified = new Set<string>([BUSINESS_IDS.sha.payees.supplierC]);
const budVerified = new Set<string>([BUSINESS_IDS.bud.payees.supplierA]);

describe("forecastStock (pure)", () => {
  it("Shanghai: exactly 400 boxes short by the end of tomorrow; 4 packs from the VERIFIED supplier", () => {
    const f = forecastStock(inputOf(pizzeriaSha.business, shaVerified));
    expect(f.today).toBe(localDay(SEED_NOW, "Asia/Shanghai"));
    expect(f.tomorrow).toBe(addDays(f.today, 1));
    expect(f.shortages.map((l) => l.sku)).toEqual(["BOX-33CM"]);
    const box = f.shortages[0]!;
    expect(box.shortage).toBe(SHA_BOX_SHORTAGE);
    expect(box.suggestion).toMatchObject({ supplierPayeeId: BUSINESS_IDS.sha.payees.supplierC, verified: true, supplierSku: "BOX-33CM-100", packs: 4, late: false });
    expect(box.suggestion!.lineTotalMinor).toBe(4 * box.suggestion!.packPriceMinor);
  });

  it("matches the fixture contract line by line for both shops; Budapest has no shortage", () => {
    for (const [b, v] of [[pizzeriaSha.business, shaVerified], [pizzeriaBud.business, budVerified]] as const) {
      const f = forecastStock(inputOf(b, v));
      const expected = seedForecastShortage(b);
      for (const l of f.lines) {
        expect({ need: l.need, safety: l.safety, onHand: l.onHand, shortage: l.shortage }, `${b.merchant.slug} ${l.sku}`).toEqual(expected[l.sku]);
      }
    }
    expect(forecastStock(inputOf(pizzeriaBud.business, budVerified)).shortages).toEqual([]);
  });

  it("confirmed incoming stock that arrives by tomorrow covers the shortage; a later arrival does not", () => {
    const base = inputOf(pizzeriaSha.business, shaVerified);
    const today = localDay(SEED_NOW, "Asia/Shanghai");
    const covered = forecastStock({ ...base, incoming: [{ inventorySku: "BOX-33CM", qty: 300, arrivesBy: addDays(today, 1), purchaseOrderId: "po" }] });
    expect(covered.shortages[0]).toMatchObject({ sku: "BOX-33CM", incoming: 300, shortage: 100 });
    const late = forecastStock({ ...base, incoming: [{ inventorySku: "BOX-33CM", qty: 300, arrivesBy: addDays(today, 2), purchaseOrderId: "po" }] });
    expect(late.shortages[0]).toMatchObject({ incoming: 0, shortage: SHA_BOX_SHORTAGE });
  });

  it("packs round up to packSize and minOrderPacks; lead time past tomorrow is flagged late; COOLING only as fallback", () => {
    const base = inputOf(pizzeriaSha.business, new Set());
    const opt = (o: Partial<ForecastSupplierOption>): ForecastSupplierOption => ({
      supplierPayeeId: "00000000-0000-4000-8000-000000000001",
      supplierName: "S",
      verified: true,
      supplierSku: "BOX-X",
      inventorySku: "BOX-33CM",
      packSize: 150,
      packPriceMinor: 1000,
      currency: "CNY",
      minOrderPacks: 1,
      leadTimeDays: 1,
      ...o,
    });
    const box = (suppliers: ForecastSupplierOption[]) => forecastStock({ ...base, suppliers }).shortages[0]!.suggestion;
    expect(box([opt({})])).toMatchObject({ packs: 3, lineTotalMinor: 3000 }); // ceil(400 / 150)
    expect(box([opt({ minOrderPacks: 5 })])).toMatchObject({ packs: 5 });
    expect(box([opt({ leadTimeDays: 3 })])).toMatchObject({ late: true });
    expect(box([opt({ verified: false, supplierSku: "CHEAP", packPriceMinor: 1 }), opt({})])).toMatchObject({ supplierSku: "BOX-X", verified: true });
    expect(box([opt({ verified: false })])).toMatchObject({ verified: false });
    expect(box([])).toBeNull();
  });

  it("today is the merchant's calendar day (timezone), not UTC's", () => {
    // 16:30Z is already the next day in Shanghai (UTC+8) but not in Budapest.
    const at = "2026-10-27T16:30:00.000Z";
    expect(forecastStock({ ...inputOf(pizzeriaSha.business, shaVerified), now: new Date(at) }).today).toBe("2026-10-28");
    expect(forecastStock({ ...inputOf(pizzeriaBud.business, budVerified), now: new Date(at) }).today).toBe("2026-10-27");
  });
});
