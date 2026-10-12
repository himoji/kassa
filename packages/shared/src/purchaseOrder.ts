import { z } from "zod";

import { Region } from "./enums.ts";
import { jcsHash } from "./jcs.ts";

/*
 * (added 2026-10-14, Business M0) Supplier purchase orders and merchant order items.
 *
 * A purchase order (PO) is drafted by the agent or the forecast scheduler and moves no money. The owner signs its
 * core with the payments passkey: `poHash = base64url(sha256(JCS(core)))` is the WebAuthn challenge (same pattern as
 * `mandateHash`). The supplier's invoice is matched against the signed core (supplier, account, total), and the
 * payment that settles it carries `purchaseOrderId` in its CanonicalOrder so payments re-verifies the signature.
 */

const PO_STATUS_VALUES = [
  "DRAFT",
  "SIGNED",
  "SENT",
  "CONFIRMED",
  "DELIVERED",
  "INVOICED",
  "PAYING",
  "PAID",
  "REJECTED",
  "CANCELED",
] as const;
export const PurchaseOrderStatus = z.enum(PO_STATUS_VALUES);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatus>;

export const StockMovementKind = z.enum(["SEED", "SALE", "RECEIPT", "ADJUSTMENT", "WASTE"]);
export type StockMovementKind = z.infer<typeof StockMovementKind>;

export const AccountType = z.enum(["PERSONAL", "BUSINESS"]);
export type AccountType = z.infer<typeof AccountType>;

export const ShopOrderChannel = z.enum(["DELIVERY", "TILL"]);
export type ShopOrderChannel = z.infer<typeof ShopOrderChannel>;

/** One PO line: whole packs of a supplier SKU. `lineTotalMinor = packs × packPriceMinor` (checked). */
export const PurchaseOrderLine = z
  .object({
    /** Supplier catalog SKU, e.g. "BOX-33CM-100". */
    supplierSku: z.string().min(1).max(64),
    /** The merchant's inventory SKU it restocks, e.g. "BOX-33CM". */
    inventorySku: z.string().min(1).max(64),
    packSize: z.number().int().positive(),
    packs: z.number().int().positive(),
    packPriceMinor: z.number().int().positive(),
    lineTotalMinor: z.number().int().positive(),
  })
  .superRefine((l, ctx) => {
    if (l.lineTotalMinor !== l.packs * l.packPriceMinor) {
      ctx.addIssue({ code: "custom", path: ["lineTotalMinor"], message: "must equal packs × packPriceMinor" });
    }
  });
export type PurchaseOrderLine = z.infer<typeof PurchaseOrderLine>;

/**
 * The passkey-signed part of a purchase order. Lines are sorted by `supplierSku` (unique) so a PO has exactly one
 * canonical encoding; build it with `normalizePurchaseOrderCore`. Changing a field changes every poHash: bump `v`.
 */
export const PurchaseOrderCore = z
  .object({
    v: z.literal(1),
    purchaseOrderId: z.string().uuid(),
    merchantId: z.string().uuid(),
    /** The owner who signs (users.id). */
    ownerUserId: z.string().uuid(),
    region: Region,
    supplierPayeeId: z.string().uuid(),
    supplierName: z.string().min(1).max(140),
    /** The verified supplier payee's account hash at signing: the invoice must name the same account. */
    supplierAccountHash: z.string().min(1),
    currency: z.string().length(3),
    lines: z.array(PurchaseOrderLine).min(1).max(50),
    totalMinor: z.number().int().positive(),
    /** Delivery requested by this calendar date (merchant timezone, ISO 8601). */
    deliverBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** base64url(sha256(JCS(forecast snapshot))) the PO was drafted from; null for a manual PO. */
    forecastHash: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
  })
  .superRefine((po, ctx) => {
    for (let i = 1; i < po.lines.length; i++) {
      if (!(po.lines[i - 1]!.supplierSku < po.lines[i]!.supplierSku)) {
        ctx.addIssue({ code: "custom", path: ["lines"], message: "must be sorted by supplierSku and unique" });
        break;
      }
    }
    const sum = po.lines.reduce((s, l) => s + l.lineTotalMinor, 0);
    if (sum !== po.totalMinor) {
      ctx.addIssue({ code: "custom", path: ["totalMinor"], message: "must equal the sum of lineTotalMinor" });
    }
  });
export type PurchaseOrderCore = z.infer<typeof PurchaseOrderCore>;

/** Sort lines by supplierSku, then validate (duplicates still fail). */
export function normalizePurchaseOrderCore(input: PurchaseOrderCore): PurchaseOrderCore {
  return PurchaseOrderCore.parse({
    ...input,
    lines: [...input.lines].sort((a, b) => (a.supplierSku < b.supplierSku ? -1 : a.supplierSku > b.supplierSku ? 1 : 0)),
  });
}

/** poHash = base64url(sha256(utf8(JCS(purchaseOrderCore)))). Parses first, like `mandateHash`. */
export function poHash(core: PurchaseOrderCore): string {
  return jcsHash(PurchaseOrderCore.parse(core));
}

/** One line of a consumer shop order or till bill (menu SKU × quantity at the shop's price). */
export const FulfillmentItem = z.object({
  sku: z.string().min(1).max(64),
  qty: z.number().int().positive().max(1000),
  unitPriceMinor: z.number().int().nonnegative(),
  name: z.string().max(140).optional(),
});
export type FulfillmentItem = z.infer<typeof FulfillmentItem>;

/**
 * What a merchant order delivers (ProposalDraftJson.fulfillment). `merchant` is the merchant slug (= mock-world
 * storeId); DELIVERY orders carry an address, TILL orders the bill id the counter created.
 */
export const Fulfillment = z.object({
  merchant: z.string().min(1).max(64),
  channel: ShopOrderChannel,
  items: z.array(FulfillmentItem).min(1).max(50),
  billId: z.string().min(1).max(128).optional(),
  deliveryAddress: z.string().max(280).optional(),
});
export type Fulfillment = z.infer<typeof Fulfillment>;

/**
 * itemsHash = base64url(sha256(JCS(items))) over {sku, qty, unitPriceMinor} sorted by sku (names are display only,
 * so they are not signed). Signed in CanonicalOrder.itemsHash.
 */
export function itemsHash(items: readonly FulfillmentItem[]): string {
  const canon = items
    .map((i) => FulfillmentItem.parse(i))
    .map((i) => ({ sku: i.sku, qty: i.qty, unitPriceMinor: i.unitPriceMinor }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.unitPriceMinor - b.unitPriceMinor));
  return jcsHash(canon);
}
