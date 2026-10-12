/*
 * (added 2026-10-14, Business M4) Stock writes. A sale is recorded once per cause (refType, refId): it bumps
 * sales_daily (units per menu SKU per merchant-local day) and appends one SALE stock movement per inventory SKU
 * (−Σ recipe qtyPerUnit × units). Movements are append-only; idempotency is a per-(merchant, ref) advisory lock plus
 * an existence check on the ref inside the same transaction, so concurrent deliveries of the same order record once.
 */
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { recipes, salesDaily, stockMovements } from "../../db/schema.ts";
import { localDay } from "./forecast.ts";
import { merchantBySlug, onHand } from "./queries.ts";

export { onHand };

export type RecordSaleInput = {
  merchantSlug: string;
  /** Menu SKUs and units sold; unknown SKUs (no recipe) still count in sales_daily but move no stock. */
  items: { sku: string; qty: number; unitPriceMinor?: number }[];
  at: Date;
  /** What caused the sale ("SHOP_ORDER", "TILL_BILL", ...) and its id: the idempotency key. */
  refType: string;
  refId: string;
};

export type RecordSaleResult =
  | { recorded: true; merchantId: string; day: string; movements: { sku: string; qty: number }[] }
  | { recorded: false; reason: "UNKNOWN_MERCHANT" | "ALREADY_RECORDED" | "EMPTY" };

export async function recordSale(input: RecordSaleInput): Promise<RecordSaleResult> {
  const db = getDb();
  const merchant = await merchantBySlug(input.merchantSlug, db);
  if (!merchant) return { recorded: false, reason: "UNKNOWN_MERCHANT" };
  const units = new Map<string, { qty: number; revenueMinor: number }>();
  for (const i of input.items) {
    if (!Number.isInteger(i.qty) || i.qty <= 0) continue;
    const u = units.get(i.sku) ?? { qty: 0, revenueMinor: 0 };
    u.qty += i.qty;
    u.revenueMinor += i.qty * (i.unitPriceMinor ?? 0);
    units.set(i.sku, u);
  }
  if (units.size === 0) return { recorded: false, reason: "EMPTY" };
  const ref = `${input.refType}:${input.refId}`;
  const day = localDay(input.at.getTime(), merchant.timezone);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stock:${merchant.id}:${ref}`}))`);
    const seen = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(and(eq(stockMovements.merchantId, merchant.id), eq(stockMovements.kind, "SALE"), eq(stockMovements.ref, ref)))
      .limit(1);
    if (seen.length > 0) return { recorded: false, reason: "ALREADY_RECORDED" } as const;

    const bom = await tx.select().from(recipes).where(eq(recipes.merchantId, merchant.id));
    const consumption = new Map<string, number>();
    for (const [menuSku, u] of units) {
      for (const r of bom.filter((b) => b.menuSku === menuSku)) consumption.set(r.inventorySku, (consumption.get(r.inventorySku) ?? 0) + r.qtyPerUnit * u.qty);
    }
    // A sale with no recipe-backed SKU still needs a marker row so a retry is recognised: a zero-qty SALE movement.
    const movements = consumption.size > 0 ? [...consumption].map(([sku, qty]) => ({ sku, qty })) : [{ sku: [...units.keys()][0]!, qty: 0 }];
    await tx.insert(stockMovements).values(movements.map((m) => ({ merchantId: merchant.id, sku: m.sku, kind: "SALE" as const, qty: -m.qty, occurredAt: input.at, ref })));
    for (const [menuSku, u] of units) {
      await tx
        .insert(salesDaily)
        .values({ merchantId: merchant.id, day, menuSku, qty: u.qty, revenueMinor: u.revenueMinor })
        .onConflictDoUpdate({
          target: [salesDaily.merchantId, salesDaily.day, salesDaily.menuSku],
          set: { qty: sql`${salesDaily.qty} + ${u.qty}`, revenueMinor: sql`${salesDaily.revenueMinor} + ${u.revenueMinor}` },
        });
    }
    return { recorded: true, merchantId: merchant.id, day, movements: movements.filter((m) => m.qty !== 0) } as const;
  });
}
