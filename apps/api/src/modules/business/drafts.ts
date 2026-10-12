/*
 * (added 2026-10-15, Business M5) Manual / agent purchase-order drafts (the agent's propose_purchase_order tool).
 * A draft moves no money: it writes one DRAFT purchase_orders row (+ ledger PO_DRAFTED, owner notified) and nothing
 * else — no proposal, approval or payment (I1/I6). The owner signs it with the payments passkey (business/sign.ts).
 *
 * Checks: the supplier is the owner's VERIFIED SUPPLIER payee; every line is a pack SKU that supplier sells this
 * merchant (supplier_items), in whole packs ≥ minOrderPacks, at the price the caller read from the supplier's
 * STRUCTURED catalog (free-text notes never reach here); the currency is the merchant's; the total is ≤ poCapMinor
 * (else refused, PO_ABOVE_CAP); no other open PO already covers a SKU. A line more than 2× the forecast suggestion
 * (or ordered when the forecast suggests nothing) flags the PO with PO_ABOVE_FORECAST.
 */
import type { PurchaseOrderLine, ReasonCode } from "@kassa/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { payees, purchaseOrders, supplierItems } from "../../db/schema.ts";
import { ledger } from "../ledger/index.ts";
import { notify } from "../notifications/service.ts";
import { addDays } from "./forecast.ts";
import { loadForecast } from "./forecastData.ts";
import type { MerchantRow } from "./queries.ts";

/** Statuses in which a PO still covers its SKUs (a new draft for them would double-order). */
export const OPEN_PO_STATUSES = ["DRAFT", "SIGNED", "SENT", "CONFIRMED"] as const;

/** A line is "above forecast" when it orders more than this multiple of the suggested units. */
export const ABOVE_FORECAST_MULTIPLE = 2;

export type DraftLineInput = { supplierSku: string; packs: number; packPriceMinor: number };

export type DraftResult =
  | { ok: true; purchaseOrderId: string; status: "DRAFT"; currency: string; lines: PurchaseOrderLine[]; totalMinor: number; reasonCodes: ReasonCode[]; deliverBy: string }
  | { ok: false; error: string; message: string; purchaseOrderId?: string; capMinor?: number };

export async function draftPurchaseOrder(
  merchant: MerchantRow,
  input: { supplierPayeeId: string; lines: DraftLineInput[]; createdBy: "AGENT" | "USER"; currency: string; now: Date },
): Promise<DraftResult> {
  const db = getDb();
  const supplier = (await db.select().from(payees).where(and(eq(payees.id, input.supplierPayeeId), eq(payees.userId, merchant.ownerUserId))))[0];
  if (!supplier || supplier.kind !== "SUPPLIER") return { ok: false, error: "UNKNOWN_SUPPLIER", message: "Not one of your suppliers" };
  if (supplier.status !== "VERIFIED" || !supplier.accountHash) return { ok: false, error: "SUPPLIER_NOT_VERIFIED", message: `This supplier is ${supplier.status}; only a verified supplier can get a purchase order` };
  if (input.currency !== merchant.currency) return { ok: false, error: "CURRENCY_MISMATCH", message: `The shop buys in ${merchant.currency}` };
  const skus = input.lines.map((l) => l.supplierSku);
  if (new Set(skus).size !== skus.length) return { ok: false, error: "DUPLICATE_LINE", message: "Each supplier SKU once" };

  const items = await db.select().from(supplierItems).where(and(eq(supplierItems.merchantId, merchant.id), eq(supplierItems.supplierPayeeId, supplier.id), inArray(supplierItems.supplierSku, skus)));
  const lines: PurchaseOrderLine[] = [];
  for (const l of input.lines) {
    const it = items.find((i) => i.supplierSku === l.supplierSku);
    if (!it) return { ok: false, error: "UNKNOWN_ITEM", message: `${l.supplierSku} is not sold to this shop by this supplier` };
    if (it.currency !== merchant.currency) return { ok: false, error: "CURRENCY_MISMATCH", message: `${l.supplierSku} is priced in ${it.currency}` };
    if (!Number.isInteger(l.packs) || l.packs < Math.max(1, it.minOrderPacks)) return { ok: false, error: "BELOW_MIN_ORDER", message: `${l.supplierSku}: at least ${it.minOrderPacks} packs` };
    if (!Number.isSafeInteger(l.packPriceMinor) || l.packPriceMinor <= 0) return { ok: false, error: "NO_CATALOG_PRICE", message: `${l.supplierSku} has no catalog price` };
    lines.push({ supplierSku: it.supplierSku, inventorySku: it.inventorySku, packSize: it.packSize, packs: l.packs, packPriceMinor: l.packPriceMinor, lineTotalMinor: l.packs * l.packPriceMinor });
  }
  lines.sort((a, b) => (a.supplierSku < b.supplierSku ? -1 : a.supplierSku > b.supplierSku ? 1 : 0));
  const totalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  if (!Number.isSafeInteger(totalMinor)) return { ok: false, error: "BAD_AMOUNT", message: "Total too large" };
  if (totalMinor > merchant.poCapMinor) {
    await ledger.append("PO_REFUSED", { userId: merchant.ownerUserId, merchantId: merchant.id, supplierPayeeId: supplier.id, createdBy: input.createdBy, totalMinor, capMinor: merchant.poCapMinor, currency: merchant.currency, reasonCodes: ["PO_ABOVE_CAP"] });
    return { ok: false, error: "PO_ABOVE_CAP", message: `The total is above this shop's purchase-order cap`, capMinor: merchant.poCapMinor };
  }

  const forecast = await loadForecast(merchant, input.now, db);
  const reasonCodes: ReasonCode[] = [];
  for (const l of lines) {
    const s = forecast.lines.find((f) => f.sku === l.inventorySku)?.suggestion;
    const suggested = s ? s.packs * s.packSize : 0;
    if (l.packs * l.packSize > ABOVE_FORECAST_MULTIPLE * suggested) {
      reasonCodes.push("PO_ABOVE_FORECAST");
      break;
    }
  }
  const leadMax = Math.max(...lines.map((l) => items.find((i) => i.supplierSku === l.supplierSku)!.leadTimeDays));
  const deliverBy = addDays(forecast.today, Math.max(1, leadMax));
  const inventorySkus = lines.map((l) => l.inventorySku);

  return db.transaction(async (tx): Promise<DraftResult> => {
    // Same lock as the forecast scheduler's drafts: the open-PO check and the insert are atomic per merchant.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`business:po-draft:${merchant.id}`}))`);
    const open = await tx
      .select({ id: purchaseOrders.id, lines: purchaseOrders.lines })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.merchantId, merchant.id), inArray(purchaseOrders.status, [...OPEN_PO_STATUSES])));
    const clash = open.find((po) => po.lines.some((l) => inventorySkus.includes(l.inventorySku)));
    if (clash) return { ok: false, error: "PO_ALREADY_OPEN", message: "An open purchase order already covers this item; review that one", purchaseOrderId: clash.id };
    const [row] = await tx
      .insert(purchaseOrders)
      .values({
        merchantId: merchant.id,
        supplierPayeeId: supplier.id,
        status: "DRAFT",
        createdBy: input.createdBy,
        currency: merchant.currency,
        lines,
        totalMinor,
        reasonCodes,
        forecastSnapshot: {
          day: forecast.today,
          tomorrow: forecast.tomorrow,
          generatedAt: forecast.generatedAt,
          deliverBy,
          skus: inventorySkus,
          lines: forecast.lines.filter((f) => inventorySkus.includes(f.sku)),
        },
        timeline: [{ status: "DRAFT", at: input.now.toISOString(), note: input.createdBy === "AGENT" ? "drafted by the assistant" : "drafted" }],
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: purchaseOrders.id });
    await ledger.append("PO_DRAFTED", { userId: merchant.ownerUserId, merchantId: merchant.id, purchaseOrderId: row!.id, createdBy: input.createdBy, skus: inventorySkus, totalMinor, currency: merchant.currency, reasonCodes }, tx);
    await notify(
      merchant.ownerUserId,
      {
        kind: "BUSINESS_PO_DRAFTED",
        title: "Purchase order ready to sign",
        body: `A purchase order to ${supplier.name} is drafted for you to review and sign. Nothing is paid until you approve the supplier's invoice.`,
        data: { key: "business.poDrafted", params: { supplier: supplier.name, total: { amountMinor: totalMinor, currency: merchant.currency } }, purchaseOrderId: row!.id, reasonCodes },
      },
      tx,
    );
    return { ok: true, purchaseOrderId: row!.id, status: "DRAFT", currency: merchant.currency, lines, totalMinor, reasonCodes, deliverBy };
  });
}
