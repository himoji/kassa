/*
 * (added 2026-10-14, Business M4) Loads the forecast's inputs for one merchant and runs the pure forecast.
 * Incoming = CONFIRMED purchase orders (not yet DELIVERED: delivery appends RECEIPT movements, which are on-hand);
 * a confirmed PO arrives on its confirmation day (merchant timezone) + the supplier item's lead time.
 */
import { and, eq, gte, lt } from "drizzle-orm";

import { type DbOrTx, getDb } from "../../db/client.ts";
import { inventoryItems, payees, purchaseOrders, recipes, salesDaily, supplierItems } from "../../db/schema.ts";
import { addDays, FORECAST_WEEKS, type Forecast, type ForecastIncoming, forecastStock, localDay } from "./forecast.ts";
import { type MerchantRow, onHand } from "./queries.ts";

export async function loadForecast(merchant: MerchantRow, now: Date, db: DbOrTx = getDb()): Promise<Forecast> {
  const today = localDay(now, merchant.timezone);
  const [inventory, bom, sales, stock, packs, confirmed] = await Promise.all([
    db.select().from(inventoryItems).where(eq(inventoryItems.merchantId, merchant.id)),
    db.select().from(recipes).where(eq(recipes.merchantId, merchant.id)),
    db
      .select({ day: salesDaily.day, menuSku: salesDaily.menuSku, qty: salesDaily.qty })
      .from(salesDaily)
      .where(and(eq(salesDaily.merchantId, merchant.id), gte(salesDaily.day, addDays(today, -7 * FORECAST_WEEKS)), lt(salesDaily.day, today))),
    onHand(merchant.id, { asOf: now, db }),
    db
      .select({ item: supplierItems, supplierName: payees.name, status: payees.status })
      .from(supplierItems)
      .innerJoin(payees, eq(payees.id, supplierItems.supplierPayeeId))
      .where(eq(supplierItems.merchantId, merchant.id)),
    db.select().from(purchaseOrders).where(and(eq(purchaseOrders.merchantId, merchant.id), eq(purchaseOrders.status, "CONFIRMED"))),
  ]);
  const incoming: ForecastIncoming[] = [];
  for (const po of confirmed) {
    const at = [...po.timeline].reverse().find((t) => t.status === "CONFIRMED")?.at ?? po.updatedAt.toISOString();
    for (const l of po.lines) {
      const lead = packs.find((p) => p.item.supplierPayeeId === po.supplierPayeeId && p.item.supplierSku === l.supplierSku)?.item.leadTimeDays ?? 0;
      incoming.push({ inventorySku: l.inventorySku, qty: l.packs * l.packSize, arrivesBy: addDays(localDay(at, merchant.timezone), lead), purchaseOrderId: po.id });
    }
  }
  return forecastStock({
    now,
    timezone: merchant.timezone,
    inventory,
    recipes: bom,
    sales,
    onHand: stock,
    incoming,
    // A BLOCKED supplier is never suggested; COOLING ones are, but only when no VERIFIED supplier sells the SKU.
    suppliers: packs
      .filter((p) => p.status !== "BLOCKED")
      .map((p) => ({ ...p.item, supplierName: p.supplierName, verified: p.status === "VERIFIED" })),
  });
}
