/*
 * (added 2026-10-14, Business M4) Scheduler job `business.forecastTick`: for each merchant, run the forecast; for
 * every SKU short by the end of tomorrow that has a supplier suggestion, auto-draft a purchase order (status DRAFT,
 * createdBy SCHEDULER, one PO per supplier) and notify the owner. It only drafts: it never signs, approves, sends or
 * pays (I6); the owner signs with the payments passkey (M5).
 *
 * Dedupe: one scheduler draft per (merchant, inventory SKU, merchant-local day) — recorded in
 * `forecastSnapshot.day/skus` — and no draft for a SKU already on an open PO (DRAFT / SIGNED / SENT) by anyone.
 * A per-merchant advisory lock makes check + insert atomic across processes.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { merchants, purchaseOrders, users } from "../../db/schema.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { notify } from "../notifications/service.ts";
import type { ForecastLine, ForecastSuggestion } from "./forecast.ts";
import { loadForecast } from "./forecastData.ts";
import type { MerchantRow } from "./queries.ts";

const OPEN_STATUSES = ["DRAFT", "SIGNED", "SENT"] as const;

export type DraftedPo = { purchaseOrderId: string; merchantId: string; supplierPayeeId: string; skus: string[]; totalMinor: number; currency: string };

export async function draftForMerchant(merchant: MerchantRow, now: Date = clock.now()): Promise<DraftedPo[]> {
  const db = getDb();
  const forecast = await loadForecast(merchant, now, db);
  const candidates = forecast.shortages.filter((l): l is ForecastLine & { suggestion: ForecastSuggestion } => l.suggestion !== null);
  if (candidates.length === 0) return [];

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`business:po-draft:${merchant.id}`}))`);
    const existing = await tx
      .select({ status: purchaseOrders.status, createdBy: purchaseOrders.createdBy, lines: purchaseOrders.lines, snapshot: purchaseOrders.forecastSnapshot })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.merchantId, merchant.id));
    const covered = new Set<string>();
    for (const po of existing) {
      if ((OPEN_STATUSES as readonly string[]).includes(po.status)) for (const l of po.lines) covered.add(l.inventorySku);
      const snap = po.snapshot as { day?: unknown; skus?: unknown } | null;
      if (po.createdBy === "SCHEDULER" && snap?.day === forecast.today && Array.isArray(snap.skus)) for (const s of snap.skus) covered.add(String(s));
    }
    const bySupplier = new Map<string, (ForecastLine & { suggestion: ForecastSuggestion })[]>();
    for (const l of candidates) {
      if (covered.has(l.sku)) continue;
      const key = `${l.suggestion.supplierPayeeId}|${l.suggestion.currency}`;
      bySupplier.set(key, [...(bySupplier.get(key) ?? []), l]);
    }
    const out: DraftedPo[] = [];
    for (const group of bySupplier.values()) {
      const s0 = group[0]!.suggestion;
      const lines = group
        .map((l) => ({
          supplierSku: l.suggestion.supplierSku,
          inventorySku: l.sku,
          packSize: l.suggestion.packSize,
          packs: l.suggestion.packs,
          packPriceMinor: l.suggestion.packPriceMinor,
          lineTotalMinor: l.suggestion.lineTotalMinor,
        }))
        .sort((a, b) => a.supplierSku.localeCompare(b.supplierSku));
      const totalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
      const skus = group.map((l) => l.sku);
      const [row] = await tx
        .insert(purchaseOrders)
        .values({
          merchantId: merchant.id,
          supplierPayeeId: s0.supplierPayeeId,
          status: "DRAFT",
          createdBy: "SCHEDULER",
          currency: s0.currency,
          lines,
          totalMinor,
          forecastSnapshot: { day: forecast.today, tomorrow: forecast.tomorrow, generatedAt: forecast.generatedAt, skus, lines: group },
          timeline: [{ status: "DRAFT", at: now.toISOString(), note: "forecast shortage" }],
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: purchaseOrders.id });
      await ledger.append("PO_DRAFTED", { userId: merchant.ownerUserId, merchantId: merchant.id, purchaseOrderId: row!.id, createdBy: "SCHEDULER", skus, totalMinor, currency: s0.currency }, tx);
      out.push({ purchaseOrderId: row!.id, merchantId: merchant.id, supplierPayeeId: s0.supplierPayeeId, skus, totalMinor, currency: s0.currency });
      const items = group.map((l) => `${l.name} (${l.shortage} ${l.unit})`).join(", ");
      await notify(
        merchant.ownerUserId,
        {
          kind: "BUSINESS_SHORTAGE",
          title: "Stock will run short by tomorrow",
          body: `Short by the end of tomorrow: ${items}. A purchase order from ${s0.supplierName} is drafted for you to review and sign.`,
          data: {
            key: "business.shortage",
            params: { items: group.map((l) => ({ sku: l.sku, name: l.name, unit: l.unit, shortage: l.shortage })), supplier: s0.supplierName, total: { amountMinor: totalMinor, currency: s0.currency } },
            purchaseOrderId: row!.id,
          },
        },
        tx,
      );
    }
    return out;
  });
}

/** Every merchant whose owner is active (not erased, not restricted under GDPR Art. 18). */
export async function forecastTick(now: Date = clock.now()): Promise<DraftedPo[]> {
  const rows = await getDb()
    .select({ m: merchants })
    .from(merchants)
    .innerJoin(users, eq(users.id, merchants.ownerUserId))
    .where(and(eq(users.accountType, "BUSINESS"), isNull(users.erasedAt), isNull(users.restrictedAt)));
  const out: DraftedPo[] = [];
  for (const { m } of rows) out.push(...(await draftForMerchant(m, now)));
  return out;
}
