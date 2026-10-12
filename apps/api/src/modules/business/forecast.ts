/*
 * (added 2026-10-14, Business M4) Stock forecast: pure and deterministic (no DB, no Date.now). The caller passes
 * `now` (the Clock) and the merchant's IANA timezone; "today"/"tomorrow" are calendar days there.
 *
 * Contract (fixtures/seed-data.ts "Forecast contract", which the seed is tuned to):
 *   demand(day) = Σ_menu round(avg units sold on the same weekday in the last 4 weeks) × recipe qtyPerUnit
 *                 (the average is over the weeks that have a sales row for that menu SKU)
 *   need        = demand(today) + demand(tomorrow)
 *   safety      = ceil(need × safetyStockPct / 100)
 *   shortage    = max(0, need + safety − onHand − incoming)
 * where incoming = confirmed purchase-order units that arrive by the end of tomorrow. The suggestion restocks the
 * shortage in whole packs (≥ minOrderPacks) from a VERIFIED supplier when one sells the SKU; if the chosen supplier's
 * lead time lands after tomorrow it is flagged `late` (the order cannot prevent this shortage).
 */
import { DAY_MS } from "../clock/index.ts";

/** The calendar date at an instant in an IANA zone, e.g. "2026-10-27". */
export function localDay(at: string | number | Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** ISO date + n calendar days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export type ForecastInventoryItem = { sku: string; name: string; unit: string; safetyStockPct: number };
export type ForecastRecipe = { menuSku: string; inventorySku: string; qtyPerUnit: number };
export type ForecastSalesRow = { day: string; menuSku: string; qty: number };
export type ForecastIncoming = { inventorySku: string; qty: number; arrivesBy: string; purchaseOrderId: string };
export type ForecastSupplierOption = {
  supplierPayeeId: string;
  supplierName: string;
  verified: boolean;
  supplierSku: string;
  inventorySku: string;
  packSize: number;
  packPriceMinor: number;
  currency: string;
  minOrderPacks: number;
  leadTimeDays: number;
};

export type ForecastInput = {
  now: Date;
  timezone: string;
  inventory: ForecastInventoryItem[];
  recipes: ForecastRecipe[];
  sales: ForecastSalesRow[];
  onHand: Record<string, number>;
  incoming?: ForecastIncoming[];
  suppliers?: ForecastSupplierOption[];
};

export type ForecastSuggestion = {
  supplierPayeeId: string;
  supplierName: string;
  verified: boolean;
  supplierSku: string;
  packSize: number;
  packs: number;
  packPriceMinor: number;
  lineTotalMinor: number;
  currency: string;
  leadTimeDays: number;
  arrivesBy: string;
  late: boolean;
};

export type ForecastLine = {
  sku: string;
  name: string;
  unit: string;
  demandToday: number;
  demandTomorrow: number;
  need: number;
  safety: number;
  onHand: number;
  incoming: number;
  shortage: number;
  suggestion: ForecastSuggestion | null;
};

export type Forecast = { today: string; tomorrow: string; timezone: string; generatedAt: string; lines: ForecastLine[]; shortages: ForecastLine[] };

export const FORECAST_WEEKS = 4;

/** demand(day) per inventory SKU. */
export function demandFor(day: string, sales: ForecastSalesRow[], recipes: ForecastRecipe[]): Record<string, number> {
  const weeks = new Set(Array.from({ length: FORECAST_WEEKS }, (_, i) => addDays(day, -7 * (i + 1))));
  const byMenu = new Map<string, number[]>();
  for (const s of sales) {
    if (!weeks.has(s.day)) continue;
    const list = byMenu.get(s.menuSku) ?? [];
    list.push(s.qty);
    byMenu.set(s.menuSku, list);
  }
  const out: Record<string, number> = {};
  for (const [menuSku, qtys] of byMenu) {
    const avg = Math.round(qtys.reduce((a, b) => a + b, 0) / qtys.length);
    for (const r of recipes) if (r.menuSku === menuSku) out[r.inventorySku] = (out[r.inventorySku] ?? 0) + avg * r.qtyPerUnit;
  }
  return out;
}

/** Verified first, then the shortest lead time, then the cheapest unit price, then supplierSku (stable). */
function pickSupplier(options: ForecastSupplierOption[]): ForecastSupplierOption | null {
  const sorted = [...options].sort(
    (a, b) =>
      Number(b.verified) - Number(a.verified) ||
      a.leadTimeDays - b.leadTimeDays ||
      a.packPriceMinor / a.packSize - b.packPriceMinor / b.packSize ||
      a.supplierSku.localeCompare(b.supplierSku) ||
      a.supplierPayeeId.localeCompare(b.supplierPayeeId),
  );
  return sorted[0] ?? null;
}

export function suggestPacks(shortage: number, option: ForecastSupplierOption, today: string, tomorrow: string): ForecastSuggestion {
  const packs = Math.max(option.minOrderPacks, Math.ceil(shortage / option.packSize));
  const arrivesBy = addDays(today, option.leadTimeDays);
  return {
    supplierPayeeId: option.supplierPayeeId,
    supplierName: option.supplierName,
    verified: option.verified,
    supplierSku: option.supplierSku,
    packSize: option.packSize,
    packs,
    packPriceMinor: option.packPriceMinor,
    lineTotalMinor: packs * option.packPriceMinor,
    currency: option.currency,
    leadTimeDays: option.leadTimeDays,
    arrivesBy,
    late: arrivesBy > tomorrow,
  };
}

export function forecastStock(input: ForecastInput): Forecast {
  const today = localDay(input.now, input.timezone);
  const tomorrow = addDays(today, 1);
  const dToday = demandFor(today, input.sales, input.recipes);
  const dTomorrow = demandFor(tomorrow, input.sales, input.recipes);
  const lines = input.inventory.map((item): ForecastLine => {
    const demandToday = dToday[item.sku] ?? 0;
    const demandTomorrow = dTomorrow[item.sku] ?? 0;
    const need = demandToday + demandTomorrow;
    const safety = Math.ceil((need * item.safetyStockPct) / 100);
    const onHand = input.onHand[item.sku] ?? 0;
    const incoming = (input.incoming ?? []).filter((i) => i.inventorySku === item.sku && i.arrivesBy <= tomorrow).reduce((s, i) => s + i.qty, 0);
    const shortage = Math.max(0, need + safety - onHand - incoming);
    const option = shortage > 0 ? pickSupplier((input.suppliers ?? []).filter((s) => s.inventorySku === item.sku)) : null;
    return {
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      demandToday,
      demandTomorrow,
      need,
      safety,
      onHand,
      incoming,
      shortage,
      suggestion: option ? suggestPacks(shortage, option, today, tomorrow) : null,
    };
  });
  return { today, tomorrow, timezone: input.timezone, generatedAt: input.now.toISOString(), lines, shortages: lines.filter((l) => l.shortage > 0) };
}
