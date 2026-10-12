/**
 * Business M4 display helpers (pure): inventory quantities with their unit, and the purchase-order status tone.
 * Quantities are integers in the item's unit (pcs, g, ml); unknown units fall back to "<qty> <unit>".
 */
import type { PurchaseOrderStatus } from "@kassa/shared";

import type { TFn } from "@/lib/i18n";
import type { StatusTone } from "@/theme/status";

const UNITS = new Set(["pcs", "g", "ml"]);

export function qtyText(qty: number, unit: string, t: TFn, locale?: string): string {
  const n = new Intl.NumberFormat(locale).format(qty);
  return UNITS.has(unit) ? t(`business:unit.${unit}`, { qty: n }) : `${n} ${unit}`;
}

export function poStatusTone(status: PurchaseOrderStatus): StatusTone {
  switch (status) {
    case "PAID":
    case "DELIVERED":
      return "positive";
    case "REJECTED":
    case "CANCELED":
      return "neutral";
    case "DRAFT":
      return "warning";
    default:
      return "info";
  }
}
