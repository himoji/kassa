import { z } from "zod";

import { CurrencyCode, IsoDate, IsoDateTime, Uuid } from "./primitives.ts";
import { PurchaseOrderCore, PurchaseOrderLine, PurchaseOrderStatus } from "./purchaseOrder.ts";
import { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "./webauthn.ts";
import { ReasonCode } from "./reasonCodes.ts";

/*
 * (added 2026-10-14, Business M4) Kassa Business read API: GET /business/inventory, /business/forecast,
 * /business/sales/today, /business/purchase-orders. Owner-only (a BUSINESS account's own merchant).
 * Quantities are integers in the item's unit; money is minor units + ISO 4217.
 */

export const BusinessMerchant = z.object({
  id: Uuid,
  slug: z.string(),
  name: z.string(),
  currency: CurrencyCode,
  timezone: z.string(),
});
export type BusinessMerchant = z.infer<typeof BusinessMerchant>;

export const ForecastSuggestionDto = z.object({
  supplierPayeeId: Uuid,
  supplierName: z.string(),
  verified: z.boolean(),
  supplierSku: z.string(),
  packSize: z.number().int(),
  packs: z.number().int(),
  packPriceMinor: z.number().int(),
  lineTotalMinor: z.number().int(),
  currency: CurrencyCode,
  leadTimeDays: z.number().int(),
  arrivesBy: IsoDate,
  late: z.boolean(),
});
export type ForecastSuggestionDto = z.infer<typeof ForecastSuggestionDto>;

export const ForecastLineDto = z.object({
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  demandToday: z.number().int(),
  demandTomorrow: z.number().int(),
  need: z.number().int(),
  safety: z.number().int(),
  onHand: z.number().int(),
  incoming: z.number().int(),
  shortage: z.number().int(),
  suggestion: ForecastSuggestionDto.nullable(),
});
export type ForecastLineDto = z.infer<typeof ForecastLineDto>;

export const BusinessForecastResponse = z.object({
  merchant: BusinessMerchant,
  today: IsoDate,
  tomorrow: IsoDate,
  generatedAt: IsoDateTime,
  lines: z.array(ForecastLineDto),
  shortages: z.array(ForecastLineDto),
});
export type BusinessForecastResponse = z.infer<typeof BusinessForecastResponse>;

export const BusinessInventoryResponse = z.object({
  merchant: BusinessMerchant,
  items: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      unit: z.string(),
      onHand: z.number().int(),
      need: z.number().int(),
      safety: z.number().int(),
      incoming: z.number().int(),
      shortage: z.number().int(),
    }),
  ),
});
export type BusinessInventoryResponse = z.infer<typeof BusinessInventoryResponse>;

export const BusinessSalesTodayResponse = z.object({
  merchant: BusinessMerchant,
  day: IsoDate,
  totalUnits: z.number().int(),
  revenueMinor: z.number().int(),
  items: z.array(z.object({ menuSku: z.string(), qty: z.number().int(), revenueMinor: z.number().int() })),
});
export type BusinessSalesTodayResponse = z.infer<typeof BusinessSalesTodayResponse>;

export const PurchaseOrderDto = z.object({
  id: Uuid,
  status: PurchaseOrderStatus,
  createdBy: z.string(),
  supplierPayeeId: Uuid,
  supplierName: z.string(),
  currency: CurrencyCode,
  lines: z.array(PurchaseOrderLine),
  totalMinor: z.number().int(),
  reasonCodes: z.array(ReasonCode),
  createdAt: IsoDateTime,
  signedAt: IsoDateTime.nullable(),
  // (added 2026-10-15, Business M5) signing, supplier progress and the invoice payment.
  poHash: z.string().nullable().optional(),
  timeline: z.array(z.object({ status: z.string(), at: IsoDateTime, note: z.string().optional() })).optional(),
  /** The matched supplier invoice (amount, id), once accepted by the three-way match. */
  invoice: z.object({ invoiceId: z.string(), amountMinor: z.number().int(), currency: CurrencyCode, issuedAt: z.string() }).nullable().optional(),
  /** The payment proposal that settles the invoice (open it in the order sheet). */
  proposalId: Uuid.nullable().optional(),
});
export type PurchaseOrderDto = z.infer<typeof PurchaseOrderDto>;

export const BusinessPurchaseOrdersResponse = z.object({ merchant: BusinessMerchant, items: z.array(PurchaseOrderDto) });
export type BusinessPurchaseOrdersResponse = z.infer<typeof BusinessPurchaseOrdersResponse>;

/**
 * (added 2026-10-15, Business M5) POST /business/purchase-orders/:id/sign/options: the exact core the owner signs and
 * WebAuthn options whose challenge is poHash(core). POST /business/purchase-orders/:id/sign {core, assertion}.
 */
export const PurchaseOrderSignOptionsResponse = z.object({
  core: PurchaseOrderCore,
  poHash: z.string(),
  webauthnOptions: PublicKeyCredentialRequestOptionsJSON,
});
export type PurchaseOrderSignOptionsResponse = z.infer<typeof PurchaseOrderSignOptionsResponse>;

export const PurchaseOrderSignRequest = z.object({ core: PurchaseOrderCore, assertion: AuthenticationResponseJSON });
export type PurchaseOrderSignRequest = z.infer<typeof PurchaseOrderSignRequest>;
