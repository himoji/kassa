/*
 * Risk features (spec §10). Pure functions here; data gathering lives in rules/facts.ts.
 */
import { RISK_WEIGHTS, type RiskFeatures } from "./riskWeights.ts";

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export type RiskInputs = {
  priorPaymentsToPayee: number;
  /** Unit prices of this order's items, and historical unit prices per item key. */
  items: { key: string; unitPriceMinor: number; quantity: number }[];
  priceHistory: Record<string, number[]>;
  qtyHistory: Record<string, number[]>;
  amountHomeMinor: number;
  /** null = no budget for the category. */
  categoryRemainingHomeMinor: number | null;
  localHour: number;
  triggerOrigin: boolean;
  readerUnverifiedNonCritical: boolean;
};

export function riskFeatures(i: RiskInputs): RiskFeatures {
  // priceAboveMedian / quantityVsHistory: worst item wins.
  let price = 0;
  let qty = 0;
  for (const it of i.items) {
    const pm = median(i.priceHistory[it.key] ?? []);
    if (pm !== null && pm > 0) price = Math.max(price, clamp01((it.unitPriceMinor / pm - 1) / 0.5));
    const qm = median(i.qtyHistory[it.key] ?? []);
    if (qm !== null && qm > 0) qty = Math.max(qty, clamp01(Math.abs(it.quantity - qm) / qm));
  }
  let budgetShare = 0;
  if (i.categoryRemainingHomeMinor !== null) {
    budgetShare = i.categoryRemainingHomeMinor <= 0 ? 1 : clamp01(i.amountHomeMinor / i.categoryRemainingHomeMinor);
  }
  return {
    newMerchant: i.priorPaymentsToPayee === 0 ? 1 : 0,
    priceAboveMedian: price,
    budgetShare,
    quantityVsHistory: qty,
    unusualHour: i.localHour >= 0 && i.localHour < 6 ? 1 : 0,
    triggerOrigin: i.triggerOrigin ? 1 : 0,
    readerUnverifiedNonCritical: i.readerUnverifiedNonCritical ? 1 : 0,
  };
}

export function riskScore(f: RiskFeatures): number {
  let r = 0;
  for (const k of Object.keys(RISK_WEIGHTS) as (keyof typeof RISK_WEIGHTS)[]) r += RISK_WEIGHTS[k] * clamp01(f[k]);
  // Round to 4 dp so the stored/compared value is stable (IEEE 754 sums like 0.1+0.2).
  return Math.round(clamp01(r) * 10_000) / 10_000;
}
