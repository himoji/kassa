/*
 * (added 2026-10-15, Business M5) The supplier side of a signed purchase order (simulated suppliers in mock-world):
 *  - sendToSupplier: POST /mock/supplier/purchase-orders, HMAC-signed by Kassa (MOCK_HMAC_SECRET) → SIGNED → SENT.
 *  - onSupplierWebhook: signed "supplier" webhooks (webhooks/routes.ts already checked HMAC, window and replay):
 *      po.confirmed  SENT → CONFIRMED
 *      po.delivered  → DELIVERED + one RECEIPT stock movement per line (packs × packSize), once per PO
 *      po.invoiced   → three-way match (business/invoices.ts)
 *    Forward-only: a repeated or out-of-order event changes nothing. A webhook is only a claim by the supplier: it
 *    never signs, approves or pays anything (I6).
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { merchants, purchaseOrders, stockMovements } from "../../db/schema.ts";
import { conflict } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { notify } from "../notifications/service.ts";
import { mockWorldSigned } from "../rails/http.ts";
import { normalizeName } from "../screening/normalize.ts";
import { handleInvoice, SupplierInvoice } from "./invoices.ts";

export async function sendToSupplier(purchaseOrderId: string): Promise<boolean> {
  const db = getDb();
  const row = (await db.select({ po: purchaseOrders, m: merchants }).from(purchaseOrders).innerJoin(merchants, eq(merchants.id, purchaseOrders.merchantId)).where(eq(purchaseOrders.id, purchaseOrderId)))[0];
  if (!row?.po.core || row.po.status !== "SIGNED") return false;
  const { po, m } = row;
  const core = po.core!;
  try {
    await mockWorldSigned("POST", "/supplier/purchase-orders", {
      purchaseOrderId: po.id,
      poHash: po.poHash,
      supplierName: core.supplierName,
      merchant: { slug: m.slug, name: m.name },
      currency: core.currency,
      lines: core.lines.map((l) => ({ supplierSku: l.supplierSku, packs: l.packs, packSize: l.packSize, packPriceMinor: l.packPriceMinor, lineTotalMinor: l.lineTotalMinor })),
      totalMinor: core.totalMinor,
      deliverBy: core.deliverBy,
    });
  } catch (err) {
    await ledger.append("PO_SEND_FAILED", { userId: m.ownerUserId, purchaseOrderId: po.id, error: (err as Error).message });
    return false;
  }
  const now = clock.now();
  await db.transaction(async (tx) => {
    const moved = await tx
      .update(purchaseOrders)
      .set({ status: "SENT", timeline: sql`${purchaseOrders.timeline} || ${JSON.stringify([{ status: "SENT", at: now.toISOString() }])}::jsonb`, updatedAt: now })
      .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.status, "SIGNED")))
      .returning({ id: purchaseOrders.id });
    if (moved.length > 0) await ledger.append("PO_SENT", { userId: m.ownerUserId, merchantId: m.id, purchaseOrderId: po.id, poHash: po.poHash }, tx);
  });
  return true;
}

const Base = z.object({ eventId: z.string().min(1).max(80), purchaseOrderId: z.string().uuid(), supplierName: z.string().min(1).max(140) });
export const SupplierEvent = z.discriminatedUnion("type", [
  Base.extend({ type: z.literal("po.confirmed") }),
  Base.extend({ type: z.literal("po.delivered") }),
  Base.extend({ type: z.literal("po.invoiced"), invoice: SupplierInvoice }),
]);
export type SupplierEvent = z.infer<typeof SupplierEvent>;

export const sameSupplier = (a: string, b: string) => normalizeName(a, { stripLegal: true }) === normalizeName(b, { stripLegal: true });

/** Statuses a delivery may arrive in (sent onwards, not yet paid or ended). */
const DELIVERABLE = ["SENT", "CONFIRMED", "INVOICED", "PAYING", "PAID"];

export async function onSupplierWebhook(body: unknown): Promise<Record<string, unknown>> {
  const parsed = SupplierEvent.safeParse(body);
  if (!parsed.success) throw conflict("WEBHOOK_REJECTED", "Malformed supplier event");
  const ev = parsed.data;
  const db = getDb();
  const row = (await db.select({ po: purchaseOrders, m: merchants }).from(purchaseOrders).innerJoin(merchants, eq(merchants.id, purchaseOrders.merchantId)).where(eq(purchaseOrders.id, ev.purchaseOrderId)))[0];
  if (!row?.po.core) {
    await ledger.append("WEBHOOK_UNMATCHED", { kind: "supplier", type: ev.type, purchaseOrderId: ev.purchaseOrderId });
    return { ok: true, matched: false };
  }
  const { po, m } = row;
  if (ev.type === "po.invoiced") return { ok: true, matched: true, ...(await handleInvoice(po.id, ev.invoice)) };

  // Confirm / deliver come from the PO's own supplier only.
  if (!sameSupplier(ev.supplierName, po.core!.supplierName)) {
    await ledger.append("WEBHOOK_REJECTED", { kind: "supplier", type: ev.type, userId: m.ownerUserId, purchaseOrderId: po.id, reason: "SUPPLIER_MISMATCH" });
    throw conflict("WEBHOOK_REJECTED", "The event is not from this purchase order's supplier");
  }
  const now = clock.now();
  if (ev.type === "po.confirmed") {
    const moved = await db.transaction(async (tx) => {
      const r = await tx
        .update(purchaseOrders)
        .set({ status: "CONFIRMED", timeline: sql`${purchaseOrders.timeline} || ${JSON.stringify([{ status: "CONFIRMED", at: now.toISOString() }])}::jsonb`, updatedAt: now })
        .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.status, "SENT")))
        .returning({ id: purchaseOrders.id });
      if (r.length > 0) await ledger.append("PO_CONFIRMED", { userId: m.ownerUserId, merchantId: m.id, purchaseOrderId: po.id }, tx);
      return r.length > 0;
    });
    return { ok: true, matched: true, changed: moved };
  }

  // po.delivered: RECEIPT movements once per PO (advisory lock + existence check, like recordSale).
  const ref = `PURCHASE_ORDER:${po.id}`;
  const changed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stock:${m.id}:${ref}`}))`);
    const cur = (await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id)))[0]!;
    if (!DELIVERABLE.includes(cur.status)) return false;
    const seen = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(and(eq(stockMovements.merchantId, m.id), eq(stockMovements.kind, "RECEIPT"), eq(stockMovements.ref, ref)))
      .limit(1);
    if (seen.length > 0) return false;
    // The signed lines are what was ordered; the supplier only claims they arrived.
    await tx.insert(stockMovements).values(cur.core!.lines.map((l) => ({ merchantId: m.id, sku: l.inventorySku, kind: "RECEIPT" as const, qty: l.packs * l.packSize, occurredAt: now, ref })));
    const status = cur.status === "SENT" || cur.status === "CONFIRMED" ? "DELIVERED" : cur.status;
    await tx
      .update(purchaseOrders)
      .set({ status, timeline: sql`${purchaseOrders.timeline} || ${JSON.stringify([{ status: "DELIVERED", at: now.toISOString() }])}::jsonb`, updatedAt: now })
      .where(eq(purchaseOrders.id, po.id));
    await ledger.append("PO_DELIVERED", { userId: m.ownerUserId, merchantId: m.id, purchaseOrderId: po.id, receipts: cur.core!.lines.map((l) => ({ sku: l.inventorySku, qty: l.packs * l.packSize })) }, tx);
    await notify(
      m.ownerUserId,
      {
        kind: "BUSINESS_PO_DELIVERED",
        title: "Delivery received",
        body: `${cur.core!.supplierName} delivered your purchase order; stock is updated.`,
        data: { key: "business.poDelivered", params: { supplier: cur.core!.supplierName }, purchaseOrderId: po.id },
      },
      tx,
    );
    return true;
  });
  return { ok: true, matched: true, changed };
}
