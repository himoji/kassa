/*
 * (added 2026-10-14, Business M2/M3) Fulfilment of merchant orders paid through Kassa, wired around the executor and
 * the handoff preflight in orders/wiring.ts (rules never imports this module; the agent never reaches it, I1).
 *
 * - Card (EU): after payments issued the one-time card for a proposal with draft.fulfillment, the order is sent to
 *   the shop with that card (DELIVERY: POST /shop/:store/orders; TILL: POST /shop/:store/bills/:billId/pay). The shop
 *   re-prices on its side and must arrive at the signed amount; it charges the card, and Kassa's issuer decides
 *   (single use, amount, merchant, currency). The items sent are the signed ones: itemsHash(draft items) must equal
 *   the CanonicalOrder's itemsHash, else nothing is sent.
 * - QR handoff (CN): the shop order (or till bill) is created first, when the order is shown, and the QR code the user
 *   pays is the SHOP's own code for it, checked by the existing handoff rail (payee name and amount).
 * A Kassa-side refusal of a till bill is reported to the till (it turns red with the reason).
 */
import { CanonicalOrder, itemsHash, type Fulfillment, type ReasonCode } from "@kassa/shared";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { approvals, payments, proposals } from "../../db/schema.ts";
import { checkHandoffQr, type HandoffQr } from "../rails/handoff.ts";
import { mockWorld, MockWorldError } from "../rails/http.ts";
import { ledger } from "../ledger/index.ts";
import type { ExecutionResult } from "../rules/index.ts";
import { applyShopStatus, ensureShopOrder } from "./service.ts";

type Executor = (approvalId: string) => Promise<ExecutionResult>;
type Preflight = (order: CanonicalOrder) => Promise<HandoffQr>;

type ShopOrderResponse = { order: { orderId: string; status: string; reasonCode: string | null; at?: string; updatedAt: string; totalMinor: number }; qr: ShopQr | null };
type BillResponse = { bill: { billId: string; status: string; reasonCode: string | null; totalMinor: number; paidAt: string | null }; qr?: ShopQr };
type ShopQr = { paymentId: string; payeeName: string; amountMinor: number; currency: string; qrPayload: string; payUrl: string };

const enc = encodeURIComponent;

/** The fulfilment of a proposal, if the signed order binds exactly its items. */
async function signedFulfillment(proposalId: string): Promise<{ f: Fulfillment; order: CanonicalOrder; userId: string } | null> {
  const p = (await getDb().select().from(proposals).where(eq(proposals.id, proposalId)))[0];
  const f = p?.draft.fulfillment;
  if (!p || !f || !p.canonicalOrder) return null;
  const order = CanonicalOrder.parse(p.canonicalOrder);
  if (!order.itemsHash || order.itemsHash !== itemsHash(f.items)) {
    await ledger.append("FULFILLMENT_REFUSED", { userId: p.userId, proposalId, reasonCodes: ["ORDER_HASH_MISMATCH"], detail: "items do not hash to the signed itemsHash" });
    return null;
  }
  return { f, order, userId: p.userId };
}

const shopItems = (f: Fulfillment) => f.items.map((i) => ({ sku: i.sku, qty: i.qty }));

/**
 * Tell the till that Kassa will not pay this bill for this order (it shows red with the reason). Best effort: the till
 * ignores it (409) while another customer's order is paying the bill.
 */
export async function reportTillDecline(merchantSlug: string, billId: string, reasonCode: string, proposalId: string): Promise<void> {
  await mockWorld("POST", `/shop/${enc(merchantSlug)}/bills/${enc(billId)}/decline`, { reasonCode, clientRef: proposalId }).catch(() => undefined);
}

/** After a successful CARD_ISSUING execution: hand the one-time card to the shop for exactly the signed items. */
async function fulfilWithCard(approvalId: string, res: ExecutionResult): Promise<void> {
  const db = getDb();
  const a = (await db.select({ proposalId: approvals.proposalId }).from(approvals).where(eq(approvals.id, approvalId)))[0];
  if (!a) return;
  const p = (await db.select({ draft: proposals.draft }).from(proposals).where(eq(proposals.id, a.proposalId)))[0];
  const draftF = p?.draft.fulfillment;
  if (!draftF) return;
  const ok = res.paymentId !== null && res.status !== "FAILED" && res.status !== "CANCELED";
  if (!ok) {
    if (draftF.channel === "TILL" && draftF.billId) await reportTillDecline(draftF.merchant, draftF.billId, res.reasonCodes[0] ?? "PAYMENT_FAILED", a.proposalId);
    return;
  }
  const pay = (await db.select().from(payments).where(eq(payments.id, res.paymentId!)))[0];
  // HANDOFF: the shop order exists since the preflight; only link the payment. Other rails carry no shop order.
  if (!pay || pay.rail !== "CARD_ISSUING") {
    if (pay?.rail === "HANDOFF") {
      const s = await signedFulfillment(a.proposalId);
      if (s) await ensureShopOrder({ userId: s.userId, proposalId: a.proposalId, merchantSlug: s.f.merchant, channel: s.f.channel, billId: s.f.billId ?? null, items: s.f.items, totalMinor: s.order.amountMinor, currency: s.order.currency, paymentId: pay.id });
    }
    return;
  }
  const s = await signedFulfillment(a.proposalId);
  if (!s || !pay.railRef) return;
  const { f, order, userId } = s;
  const row = await ensureShopOrder({ userId, proposalId: a.proposalId, merchantSlug: f.merchant, channel: f.channel, billId: f.billId ?? null, items: f.items, totalMinor: order.amountMinor, currency: order.currency, paymentId: pay.id });
  const cardId = pay.railRef;
  try {
    if (f.channel === "DELIVERY") {
      const r = await mockWorld<ShopOrderResponse>("POST", `/shop/${enc(f.merchant)}/orders`, {
        clientRef: a.proposalId,
        items: shopItems(f),
        expectedTotalMinor: order.amountMinor,
        ...(f.deliveryAddress ? { deliveryAddress: f.deliveryAddress } : {}),
        payment: { method: "CARD", cardId },
      });
      await applyShopStatus(row.id, r.order.status, { at: r.order.updatedAt, reasonCode: r.order.reasonCode, externalOrderId: r.order.orderId, source: "shop:create" });
    } else {
      const r = await mockWorld<BillResponse>("POST", `/shop/${enc(f.merchant)}/bills/${enc(f.billId!)}/pay`, { cardId, clientRef: a.proposalId, expectedTotalMinor: order.amountMinor });
      await applyShopStatus(row.id, r.bill.status, { at: r.bill.paidAt ?? undefined, reasonCode: r.bill.reasonCode, source: "shop:bill-pay" });
    }
  } catch (err) {
    // The card stays unused and expires (payment CANCELED by the card-expiry job); the order is FAILED.
    const code: ReasonCode = "RAIL_ERROR";
    await ledger.append("SHOP_SUBMIT_FAILED", { userId, shopOrderId: row.id, proposalId: a.proposalId, status: err instanceof MockWorldError ? err.status : null, error: (err as Error).message, reasonCodes: [code] });
    await applyShopStatus(row.id, "FAILED", { reasonCode: err instanceof MockWorldError && err.status === 409 ? "AMOUNT_MISMATCH" : code, source: "kassa" });
  }
}

/** Wrap the payments executor: run it, then fulfil the merchant order (never changes the execution result). */
export function withFulfillment(exec: Executor): Executor {
  return async (approvalId) => {
    const res = await exec(approvalId);
    try {
      await fulfilWithCard(approvalId, res);
    } catch (err) {
      await ledger.append("SHOP_FULFILMENT_ERROR", { approvalId, error: (err as Error).message }).catch(() => undefined);
    }
    return res;
  };
}

/**
 * Wrap the handoff preflight: for a merchant order, create the shop order (or take the till bill) and use the shop's
 * own QR code for it; other handoff orders keep the generic merchant QR request.
 */
export function withShopQr(base: Preflight): Preflight {
  return async (order) => {
    const s = await signedFulfillment(order.proposalId);
    if (!s) return base(order);
    const { f, userId } = s;
    const row = await ensureShopOrder({ userId, proposalId: order.proposalId, merchantSlug: f.merchant, channel: f.channel, billId: f.billId ?? null, items: f.items, totalMinor: order.amountMinor, currency: order.currency, paymentId: null });
    let qr: ShopQr;
    if (f.channel === "DELIVERY") {
      const r = await mockWorld<ShopOrderResponse>("POST", `/shop/${enc(f.merchant)}/orders`, {
        clientRef: order.proposalId,
        items: shopItems(f),
        expectedTotalMinor: order.amountMinor,
        ...(f.deliveryAddress ? { deliveryAddress: f.deliveryAddress } : {}),
        payment: { method: "QR" },
      });
      if (!r.qr) throw new Error("the shop returned no QR code for the order");
      qr = r.qr;
      await applyShopStatus(row.id, r.order.status, { at: r.order.updatedAt, externalOrderId: r.order.orderId, source: "shop:create" });
    } else {
      const r = await mockWorld<BillResponse>("POST", `/shop/${enc(f.merchant)}/bills/${enc(f.billId!)}/qr`, { clientRef: order.proposalId, expectedTotalMinor: order.amountMinor });
      if (!r.qr) throw new Error("the till returned no QR code for the bill");
      qr = r.qr;
      await applyShopStatus(row.id, "AWAITING_PAYMENT", { source: "shop:bill-qr" });
    }
    return checkHandoffQr(qr, order);
  };
}
