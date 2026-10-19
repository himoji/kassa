/*
 * Payment status transitions from rail callbacks (webhooks, scheduler polling). Kept apart from
 * payments/index.ts so rails can import it without an import cycle.
 */
import type { PaymentStatus, ReasonCode } from "@kassa/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { payments, proposals, purchaseOrders, transactions } from "../../db/schema.ts";
import { releaseSettlement } from "../obligations/settlements.ts";
import { normalizeName } from "../screening/normalize.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { notifyPaymentOutcome } from "./notify.ts";

/** Rail callbacks (webhooks, scheduler): move a payment to a new status and log it. */
export async function updatePaymentStatus(
  paymentId: string,
  status: PaymentStatus,
  extra: { reasonCodes?: ReasonCode[]; details?: Record<string, unknown>; source: string; merchantName?: string },
): Promise<boolean> {
  const db = getDb();
  const p = (await db.select().from(payments).where(eq(payments.id, paymentId)))[0];
  if (!p) return false;
  if (p.status === status) return true;
  // Terminal states do not move (ISO 20022 pacs.002: ACSC/RJCT are final).
  if (p.status === "SENT" || p.status === "FAILED" || p.status === "CANCELED") return false;
  await db.transaction(async (tx) => {
    await tx
      .update(payments)
      .set({
        status,
        reasonCodes: extra.reasonCodes ?? p.reasonCodes,
        details: extra.details ? { ...p.details, ...extra.details } : p.details,
        updatedAt: clock.now(),
      })
      .where(eq(payments.id, paymentId));
    // (2026-10-18) A conversion is an exchange between the user's own balances, not spending: no transaction.
    if (status === "SENT" && p.rail !== "CONVERT") {
      // A sent Kassa payment is also spending: log it as a KASSA_PAYMENT transaction (spec §6) for budgets.
      const prop = (await tx.select().from(proposals).where(eq(proposals.id, p.proposalId)))[0];
      const merchant = extra.merchantName ?? prop?.canonicalOrder?.payeeName ?? "Kassa payment";
      const now = clock.now();
      await tx.insert(transactions).values({
        userId: p.userId,
        source: "KASSA_PAYMENT",
        occurredAt: now,
        merchantRaw: merchant,
        merchantNorm: normalizeName(merchant, { stripLegal: true }),
        amountMinor: p.amountMinor,
        currency: p.currency,
        homeAmountMinor: p.homeAmountMinor,
        settledAmountMinor: p.amountMinor,
        settledCurrency: p.currency,
        category: prop?.category ?? null,
        status: "SETTLED",
        paymentId: p.id,
        dedupeKey: `kassa-payment|${p.id}`,
      });
    }
    // (M5) The purchase order this payment settles: PAID when sent; back to INVOICED when the payment failed.
    const poId = (await tx.select({ order: proposals.canonicalOrder }).from(proposals).where(eq(proposals.id, p.proposalId)))[0]?.order?.purchaseOrderId;
    if (poId && (status === "SENT" || status === "FAILED" || status === "CANCELED")) {
      const next = status === "SENT" ? "PAID" : "INVOICED";
      const at = clock.now();
      const moved = await tx
        .update(purchaseOrders)
        .set({ status: next, timeline: sql`${purchaseOrders.timeline} || ${JSON.stringify([{ status: next, at: at.toISOString(), note: `payment ${status.toLowerCase()}` }])}::jsonb`, updatedAt: at })
        .where(and(eq(purchaseOrders.id, poId), inArray(purchaseOrders.status, ["PAYING", "INVOICED"])))
        .returning({ id: purchaseOrders.id });
      if (moved.length > 0 && next === "PAID") await ledger.append("PO_PAID", { userId: p.userId, purchaseOrderId: poId, paymentId, amountMinor: p.amountMinor, currency: p.currency }, tx);
    }
    // B4: a payment that failed or was canceled after execution no longer settles its obligation period.
    if (status === "FAILED" || status === "CANCELED") await releaseSettlement(tx, p.proposalId);
    await ledger.append("PAYMENT_STATUS", { userId: p.userId, proposalId: p.proposalId, paymentId, status, from: p.status, source: extra.source, reasonCodes: extra.reasonCodes ?? [] }, tx);
  });
  // X9: one notice per final outcome, on the common transition (webhooks, polling, card capture, handoff).
  if (status === "SENT" || status === "FAILED" || status === "CANCELED") await notifyPaymentOutcome(paymentId, status, extra.reasonCodes ?? []);
  return true;
}

