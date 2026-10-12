/*
 * (added 2026-10-14, Business M2/M3) Shop orders (delivery) and till bills paid through Kassa: the shop_orders rows,
 * their status timeline mirrored from the shop's signed "shop" webhooks (and the shop's synchronous answers), the
 * customer's notifications, and the merchant's sale (stock goes down by recipe) once the order is paid.
 *
 * Status only moves forward along its channel's flow (SHOP_DELIVERY_FLOW / SHOP_TILL_FLOW); DECLINED / FAILED end an
 * unpaid order. A repeated or out-of-order event changes nothing. The sale is recorded once per shop order
 * (business.recordSale is idempotent per ref); a webhook can never approve or pay anything (I6).
 */
import { SHOP_DELIVERY_FLOW, SHOP_FINAL_STATUSES, SHOP_TILL_FLOW, type FulfillmentItem, type ShopOrderView } from "@kassa/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { proposals, shopOrders } from "../../db/schema.ts";
import { ownedNotFound } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { merchantBySlug, recordSale } from "../business/index.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { notify } from "../notifications/service.ts";

export type ShopOrderRow = typeof shopOrders.$inferSelect;
type Channel = ShopOrderRow["channel"];

const FINAL = new Set<string>(SHOP_FINAL_STATUSES);
const flowOf = (channel: Channel): readonly string[] => (channel === "TILL" ? SHOP_TILL_FLOW : SHOP_DELIVERY_FLOW);
/** The first status at which the merchant has been paid (the sale counts from here). */
const paidFrom = (channel: Channel) => (channel === "TILL" ? "PAID" : "RECEIVED");

/** Whether `next` is a forward move from `current` (end states never move; DECLINED / FAILED only before payment). */
export function isForward(channel: Channel, current: string, next: string): boolean {
  if (current === next || FINAL.has(current)) return false;
  const flow = flowOf(channel);
  const i = flow.indexOf(current);
  if (next === "DECLINED" || next === "FAILED") return i < flow.indexOf(paidFrom(channel));
  const j = flow.indexOf(next);
  return j >= 0 && j > i;
}

const isPaid = (channel: Channel, status: string) => flowOf(channel).indexOf(status) >= flowOf(channel).indexOf(paidFrom(channel));

/** The shop_orders row of a proposal (one per proposal), or null. */
export async function shopOrderOfProposal(proposalId: string, db: DbOrTx = getDb()): Promise<ShopOrderRow | null> {
  return (await db.select().from(shopOrders).where(eq(shopOrders.proposalId, proposalId)).orderBy(desc(shopOrders.createdAt)).limit(1))[0] ?? null;
}

/** Create (or return the existing) shop_orders row for a paid-through-Kassa merchant order. */
export async function ensureShopOrder(input: {
  userId: string;
  proposalId: string;
  merchantSlug: string;
  channel: Channel;
  billId: string | null;
  items: FulfillmentItem[];
  totalMinor: number;
  currency: string;
  paymentId: string | null;
}): Promise<ShopOrderRow> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`shop-order:${input.proposalId}`}))`);
    const existing = await shopOrderOfProposal(input.proposalId, tx);
    if (existing) {
      if (input.paymentId && !existing.paymentId) {
        return (await tx.update(shopOrders).set({ paymentId: input.paymentId, updatedAt: clock.now() }).where(eq(shopOrders.id, existing.id)).returning())[0]!;
      }
      return existing;
    }
    const merchant = await merchantBySlug(input.merchantSlug, tx);
    const now = clock.now();
    const row = (
      await tx
        .insert(shopOrders)
        .values({
          userId: input.userId,
          merchantSlug: input.merchantSlug,
          merchantId: merchant?.id ?? null,
          channel: input.channel,
          billId: input.billId,
          items: input.items,
          totalMinor: input.totalMinor,
          currency: input.currency,
          status: "SUBMITTED",
          timeline: [{ status: "SUBMITTED", at: now.toISOString() }],
          proposalId: input.proposalId,
          paymentId: input.paymentId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
    )[0]!;
    await ledger.append("SHOP_ORDER_CREATED", { userId: input.userId, shopOrderId: row.id, proposalId: input.proposalId, merchantSlug: input.merchantSlug, channel: input.channel, totalMinor: input.totalMinor, currency: input.currency }, tx);
    return row;
  });
}

const TITLES: Record<string, string> = {
  AWAITING_PAYMENT: "waiting for your QR payment",
  RECEIVED: "order received",
  ACCEPTED: "order accepted",
  COOKING: "your order is being prepared",
  OUT_FOR_DELIVERY: "out for delivery",
  DELIVERED: "delivered",
  PAID: "bill paid",
  DECLINED: "payment declined",
  FAILED: "order failed",
};

/**
 * Move a shop order forward (from the shop's answer or its webhook). Returns the row and whether it changed.
 * Records the merchant's sale on the first paid status and notifies the customer on every change.
 */
export async function applyShopStatus(
  shopOrderId: string,
  next: string,
  opts: { at?: string; reasonCode?: string | null; externalOrderId?: string | null; source: string },
): Promise<{ row: ShopOrderRow; changed: boolean }> {
  const db = getDb();
  const res = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`shop-order-status:${shopOrderId}`}))`);
    const row = (await tx.select().from(shopOrders).where(eq(shopOrders.id, shopOrderId)))[0];
    if (!row) throw new HttpProblem(404, "NOT_FOUND", "shop order not found");
    const setExternal = opts.externalOrderId && !row.externalOrderId ? { externalOrderId: opts.externalOrderId } : {};
    if (!isForward(row.channel, row.status, next)) {
      if (Object.keys(setExternal).length === 0) return { row, changed: false, wasPaid: true };
      return { row: (await tx.update(shopOrders).set(setExternal).where(eq(shopOrders.id, row.id)).returning())[0]!, changed: false, wasPaid: true };
    }
    const at = opts.at ?? clock.now().toISOString();
    const entry = { status: next, at, ...(opts.reasonCode ? { note: opts.reasonCode } : {}) };
    const updated = (
      await tx
        .update(shopOrders)
        .set({ status: next, timeline: [...row.timeline, entry], updatedAt: clock.now(), ...setExternal })
        .where(eq(shopOrders.id, row.id))
        .returning()
    )[0]!;
    await ledger.append("SHOP_ORDER_STATUS", { userId: row.userId, shopOrderId: row.id, proposalId: row.proposalId, from: row.status, to: next, reasonCodes: opts.reasonCode ? [opts.reasonCode] : [], source: opts.source }, tx);
    return { row: updated, changed: true, wasPaid: isPaid(row.channel, row.status) };
  });
  if (!res.changed) return { row: res.row, changed: false };
  const row = res.row;
  if (!res.wasPaid && isPaid(row.channel, row.status)) {
    // Stock goes down by recipe once per order (idempotent per ref inside recordSale).
    await recordSale({
      merchantSlug: row.merchantSlug,
      items: row.items.map((i) => ({ sku: i.sku, qty: i.qty, unitPriceMinor: i.unitPriceMinor })),
      at: new Date(opts.at ?? clock.now().toISOString()),
      refType: row.channel === "TILL" ? "TILL_BILL" : "SHOP_ORDER",
      refId: row.id,
    }).catch(async (err: unknown) => {
      await ledger.append("SHOP_SALE_NOT_RECORDED", { shopOrderId: row.id, merchantSlug: row.merchantSlug, error: (err as Error).message });
    });
  }
  const name = await merchantNameOf(row);
  await notify(row.userId, {
    kind: "SHOP_ORDER_STATUS",
    title: `${name}: ${TITLES[row.status] ?? row.status.toLowerCase()}`,
    body:
      row.status === "DECLINED" || row.status === "FAILED"
        ? `Nothing more is charged. Reason: ${opts.reasonCode ?? "unknown"}.`
        : row.channel === "TILL"
          ? "The counter till shows your payment (simulated)."
          : "Order status from the shop (simulated).",
    data: {
      key: "shop.orderStatus",
      params: { merchant: name, status: row.status, channel: row.channel, reasonCode: opts.reasonCode ?? null },
      shopOrderId: row.id,
      proposalId: row.proposalId,
      status: row.status,
      reasonCode: opts.reasonCode ?? null,
    },
  }).catch(() => undefined);
  return { row, changed: true };
}

async function merchantNameOf(row: ShopOrderRow, db: DbOrTx = getDb()): Promise<string> {
  if (row.proposalId) {
    const p = (await db.select({ order: proposals.canonicalOrder }).from(proposals).where(eq(proposals.id, row.proposalId)))[0];
    if (p?.order?.payeeName) return p.order.payeeName;
  }
  return (await merchantBySlug(row.merchantSlug, db))?.name ?? row.merchantSlug;
}

export async function toView(row: ShopOrderRow, db: DbOrTx = getDb()): Promise<ShopOrderView> {
  const last = [...row.timeline].reverse().find((t) => t.status === row.status);
  return {
    id: row.id,
    merchantSlug: row.merchantSlug,
    merchantName: await merchantNameOf(row, db),
    channel: row.channel,
    externalOrderId: row.externalOrderId,
    billId: row.billId,
    items: row.items,
    totalMinor: row.totalMinor,
    currency: row.currency,
    status: row.status,
    reasonCode: row.status === "DECLINED" || row.status === "FAILED" ? (last?.note ?? null) : null,
    final: FINAL.has(row.status),
    timeline: row.timeline,
    proposalId: row.proposalId,
    paymentId: row.paymentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listShopOrders(userId: string, opts: { proposalId?: string; limit: number }): Promise<ShopOrderView[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(shopOrders)
    .where(opts.proposalId ? and(eq(shopOrders.userId, userId), eq(shopOrders.proposalId, opts.proposalId)) : eq(shopOrders.userId, userId))
    .orderBy(desc(shopOrders.createdAt))
    .limit(opts.limit);
  return Promise.all(rows.map((r) => toView(r, db)));
}

export async function getShopOrder(userId: string, id: string): Promise<ShopOrderView> {
  const db = getDb();
  const row = (await db.select().from(shopOrders).where(and(eq(shopOrders.id, id), eq(shopOrders.userId, userId))))[0];
  // BOLA: another user's order is indistinguishable from a missing one; the probe is audited.
  if (!row) throw await ownedNotFound(userId, "shop order", id, async () => (await db.select({ id: shopOrders.id }).from(shopOrders).where(eq(shopOrders.id, id))).length > 0);
  return toView(row, db);
}

// ---------- the shop's signed webhook ----------

const ShopEvent = z.object({
  type: z.enum(["shop.order.updated", "shop.bill.updated"]),
  storeId: z.string().min(1).max(64),
  orderId: z.string().min(1).max(80).optional(),
  billId: z.string().min(1).max(80).optional(),
  clientRef: z.string().nullable().optional(),
  status: z.string().min(1).max(32),
  reasonCode: z.string().max(64).nullable().optional(),
  totalMinor: z.number().int(),
  currency: z.string(),
  at: z.string().optional(),
});

/** Statuses the shop reports, per event type. */
const SHOP_STATUSES: Record<z.infer<typeof ShopEvent>["type"], ReadonlySet<string>> = {
  "shop.order.updated": new Set(["AWAITING_PAYMENT", "RECEIVED", "ACCEPTED", "COOKING", "OUT_FOR_DELIVERY", "DELIVERED", "DECLINED"]),
  "shop.bill.updated": new Set(["PAID", "DECLINED"]),
};

/**
 * POST /webhooks/mock/shop (after HMAC + replay checks). Matches the shop order by Kassa's clientRef (the proposal id)
 * or the shop's own id; the event must name the same store, total and currency as the row (else refused, ledgered).
 */
export async function onShopWebhook(body: unknown): Promise<{ ok: true; matched: boolean; changed?: boolean }> {
  const parsed = ShopEvent.safeParse(body);
  if (!parsed.success) throw new HttpProblem(400, "BAD_WEBHOOK", "Unrecognised shop event");
  const e = parsed.data;
  if (!SHOP_STATUSES[e.type].has(e.status)) throw new HttpProblem(400, "BAD_WEBHOOK", `Unknown shop status ${e.status}`);
  const db = getDb();
  const uuid = z.string().uuid().safeParse(e.clientRef);
  let row: ShopOrderRow | undefined;
  if (uuid.success) {
    row = (await db.select().from(shopOrders).where(and(eq(shopOrders.proposalId, uuid.data), eq(shopOrders.merchantSlug, e.storeId))))[0];
  }
  if (!row && e.orderId) row = (await db.select().from(shopOrders).where(and(eq(shopOrders.merchantSlug, e.storeId), eq(shopOrders.externalOrderId, e.orderId))))[0];
  if (!row && e.billId) row = (await db.select().from(shopOrders).where(and(eq(shopOrders.merchantSlug, e.storeId), eq(shopOrders.billId, e.billId))))[0];
  if (!row) {
    // A bill or order not paid through Kassa (or not yet known): nothing to update.
    await ledger.append("WEBHOOK_UNMATCHED", { kind: "shop", storeId: e.storeId, orderId: e.orderId ?? null, billId: e.billId ?? null, status: e.status });
    return { ok: true, matched: false };
  }
  const channelOk = (e.type === "shop.bill.updated") === (row.channel === "TILL");
  const billOk = row.channel !== "TILL" || e.billId === row.billId;
  if (!channelOk || !billOk || e.totalMinor !== row.totalMinor || e.currency !== row.currency) {
    await ledger.append("WEBHOOK_REJECTED", { kind: "shop", userId: row.userId, shopOrderId: row.id, reason: "ORDER_MISMATCH", status: e.status });
    throw new HttpProblem(409, "WEBHOOK_REJECTED", "Shop event does not match the order Kassa paid for", { details: { reason: "ORDER_MISMATCH" } });
  }
  const r = await applyShopStatus(row.id, e.status, { at: e.at, reasonCode: e.reasonCode ?? null, externalOrderId: e.orderId ?? null, source: "webhook:mock-shop" });
  return { ok: true, matched: true, changed: r.changed };
}
