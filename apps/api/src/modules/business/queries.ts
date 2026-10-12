/*
 * (added 2026-10-14, Business M0) Read-only queries over the Kassa Business tables (db/schema.ts "Kassa Business").
 * On-hand stock is never stored: it is the sum of the append-only stock_movements. Writes (recordSale, receipts,
 * purchase orders) come with M4/M5 in this module.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";

import { type DbOrTx, getDb } from "../../db/client.ts";
import { inventoryItems, merchants, stockMovements } from "../../db/schema.ts";

export type MerchantRow = typeof merchants.$inferSelect;

/** The merchant a BUSINESS user owns (one per owner in this version), or null. */
export async function merchantOfOwner(ownerUserId: string, db: DbOrTx = getDb()): Promise<MerchantRow | null> {
  return (await db.select().from(merchants).where(eq(merchants.ownerUserId, ownerUserId)).orderBy(asc(merchants.createdAt)).limit(1))[0] ?? null;
}

/** A merchant by slug (= mock-world storeId), or null. */
export async function merchantBySlug(slug: string, db: DbOrTx = getDb()): Promise<MerchantRow | null> {
  return (await db.select().from(merchants).where(eq(merchants.slug, slug)))[0] ?? null;
}

/**
 * On-hand quantity per inventory SKU (Σ stock_movements.qty), optionally as of an instant. Every inventory item is
 * present (0 when it has no movements); movements for SKUs that are not inventory items are ignored.
 */
export async function onHand(merchantId: string, opts: { asOf?: Date; db?: DbOrTx } = {}): Promise<Record<string, number>> {
  const db = opts.db ?? getDb();
  const items = await db.select({ sku: inventoryItems.sku }).from(inventoryItems).where(eq(inventoryItems.merchantId, merchantId));
  const where = opts.asOf
    ? and(eq(stockMovements.merchantId, merchantId), lte(stockMovements.occurredAt, opts.asOf))
    : eq(stockMovements.merchantId, merchantId);
  const sums = await db
    .select({ sku: stockMovements.sku, qty: sql<string>`coalesce(sum(${stockMovements.qty}), 0)` })
    .from(stockMovements)
    .where(where)
    .groupBy(stockMovements.sku);
  const bySku = new Map(sums.map((r) => [r.sku, Number(r.qty)]));
  return Object.fromEntries(items.map((i) => [i.sku, bySku.get(i.sku) ?? 0]));
}
