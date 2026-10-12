import { z } from "zod";

import { Decision } from "./enums.ts";
import { ReasonCode } from "./reasonCodes.ts";
import { FulfillmentItem, ShopOrderChannel } from "./purchaseOrder.ts";

/*
 * (added 2026-10-14, Business M2/M3) Consumer shop orders (delivery) and counter-till bills paid through Kassa.
 * The status is the shop's own (mock-world order book), mirrored from its signed "shop" webhooks:
 * DELIVERY: SUBMITTED → (AWAITING_PAYMENT) → RECEIVED → ACCEPTED → COOKING → OUT_FOR_DELIVERY → DELIVERED | DECLINED | FAILED
 * TILL:     SUBMITTED → (AWAITING_PAYMENT) → PAID | DECLINED | FAILED
 */

export const SHOP_DELIVERY_FLOW = ["SUBMITTED", "AWAITING_PAYMENT", "RECEIVED", "ACCEPTED", "COOKING", "OUT_FOR_DELIVERY", "DELIVERED"] as const;
export const SHOP_TILL_FLOW = ["SUBMITTED", "AWAITING_PAYMENT", "PAID"] as const;
/** End states: nothing changes after these. */
export const SHOP_FINAL_STATUSES = ["DELIVERED", "PAID", "DECLINED", "FAILED"] as const;

export const ShopOrderStatus = z.enum(["SUBMITTED", "AWAITING_PAYMENT", "RECEIVED", "ACCEPTED", "COOKING", "OUT_FOR_DELIVERY", "DELIVERED", "PAID", "DECLINED", "FAILED"]);
export type ShopOrderStatus = z.infer<typeof ShopOrderStatus>;

export const ShopOrderTimelineEntry = z.object({ status: z.string(), at: z.string(), note: z.string().optional() });

export const ShopOrderView = z.object({
  id: z.string().uuid(),
  merchantSlug: z.string(),
  merchantName: z.string(),
  channel: ShopOrderChannel,
  externalOrderId: z.string().nullable(),
  billId: z.string().nullable(),
  items: z.array(FulfillmentItem),
  totalMinor: z.number().int(),
  currency: z.string(),
  status: z.string(),
  /** The shop's or Kassa's reason for DECLINED / FAILED. */
  reasonCode: z.string().nullable(),
  /** True once the status is final (the app stops polling). */
  final: z.boolean(),
  timeline: z.array(ShopOrderTimelineEntry),
  proposalId: z.string().uuid().nullable(),
  paymentId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ShopOrderView = z.infer<typeof ShopOrderView>;

export const ShopOrdersResponse = z.object({ shopOrders: z.array(ShopOrderView) });
export type ShopOrdersResponse = z.infer<typeof ShopOrdersResponse>;

/** A counter-till bill as the merchant's system reports it (amount and merchant never come from the client). */
export const MerchantBillView = z.object({
  billId: z.string(),
  merchantSlug: z.string(),
  merchantName: z.string(),
  items: z.array(FulfillmentItem),
  totalMinor: z.number().int(),
  currency: z.string(),
  status: z.string(),
});
export type MerchantBillView = z.infer<typeof MerchantBillView>;

export const MerchantBillProposeResponse = z.object({
  proposalId: z.string().uuid(),
  decision: Decision,
  reasonCodes: z.array(ReasonCode),
  summary: z.string(),
  bill: MerchantBillView,
});
export type MerchantBillProposeResponse = z.infer<typeof MerchantBillProposeResponse>;
