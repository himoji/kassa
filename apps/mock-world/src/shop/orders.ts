import { randomBytes, randomUUID } from "node:crypto";

import { HttpError } from "../errors.ts";
import type { QrPayment, QrWallet } from "../qr/qr.ts";
import { pizzaCheckout, type ShopDeps } from "../routes/shop.ts";
import { type Collection, mapCollection } from "../store/sync.ts";
import type { WebhookSink } from "../webhooks.ts";
import { PIZZA_MENUS, PIZZA_STORES } from "../world/data.ts";
import type { StoreId } from "../../../../fixtures/seed-data.ts";

/*
 * (M2/M3) The pizza shops' own order book (a third-party system, simulated): delivery orders and counter-till bills.
 *
 * - Prices are always the shop's own (PIZZA_MENUS): a client sends SKUs and quantities; `expectedTotalMinor` (the amount
 *   the customer signed in Kassa) must equal the shop's total, else nothing is charged (AMOUNT_MISMATCH).
 * - Payment: a one-time card (the same pizzaCheckout() as the terminal, so Kassa's issuer decides) or the shop's QR
 *   code in the QR wallet (Shanghai, region CN). A paid QR moves the order on through QrWallet.onPaid.
 * - Delivery status: AWAITING_PAYMENT → RECEIVED → ACCEPTED → COOKING → OUT_FOR_DELIVERY → DELIVERED (or DECLINED).
 *   The kitchen screen advances it; with SHOP_AUTOPILOT it advances itself on the demo clock.
 * - Till bills: OPEN → PAID, or DECLINED (with the reason; still payable by another attempt).
 * - Every change is reported to Kassa as a signed "shop" webhook (webhooks.ts).
 * - `clientRef` (Kassa's proposal id) makes order creation idempotent per store.
 */

export const ORDER_FLOW = ["RECEIVED", "ACCEPTED", "COOKING", "OUT_FOR_DELIVERY", "DELIVERED"] as const;
export type OrderStatus = "AWAITING_PAYMENT" | (typeof ORDER_FLOW)[number] | "DECLINED";
export type BillStatus = "OPEN" | "PAID" | "DECLINED";

export interface LineItem {
  sku: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
}

export interface QrView {
  paymentId: string;
  payeeName: string;
  amountMinor: number;
  currency: string;
  qrPayload: string;
  payUrl: string;
}

interface Payment {
  method: "CARD" | "QR";
  /** Last 4 characters of the card id only (the kitchen screen shows it; the id itself is a bearer credential). */
  cardHint: string | null;
  authorizationId: string | null;
  qrPaymentId: string | null;
}

export interface ShopOrder {
  orderId: string;
  storeId: StoreId;
  clientRef: string | null;
  items: LineItem[];
  totalMinor: number;
  currency: string;
  deliveryAddress: string | null;
  payment: Payment;
  status: OrderStatus;
  reasonCode: string | null;
  timeline: { status: OrderStatus; at: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface TillBill {
  billId: string;
  storeId: StoreId;
  items: LineItem[];
  totalMinor: number;
  currency: string;
  status: BillStatus;
  reasonCode: string | null;
  clientRef: string | null;
  payment: Payment | null;
  /** Kassa app link the till's QR code encodes. */
  payUrl: string;
  timeline: { status: BillStatus; at: string; reasonCode?: string }[];
  createdAt: string;
  paidAt: string | null;
}

export type ItemRequest = { sku: string; qty: number };

export type OrderBookDeps = ShopDeps & { webhooks: WebhookSink; qr: QrWallet; kassaAppUrl: string; stepMs: number; autopilot: boolean };

function priced(storeId: StoreId, items: ItemRequest[]): { items: LineItem[]; totalMinor: number } {
  const bySku = new Map<string, number>();
  for (const it of items) {
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 50) throw new HttpError(400, "BAD_QUANTITY", `Bad quantity for ${it.sku}`);
    bySku.set(it.sku, (bySku.get(it.sku) ?? 0) + it.qty);
  }
  const out: LineItem[] = [];
  for (const [sku, qty] of bySku) {
    const m = PIZZA_MENUS[storeId].find((x) => x.sku === sku);
    if (!m) throw new HttpError(400, "UNKNOWN_SKU", `Unknown item ${sku}`);
    out.push({ sku, name: m.name, qty, unitPriceMinor: m.priceMinor });
  }
  if (out.length === 0) throw new HttpError(400, "EMPTY_ORDER", "No items");
  return { items: out, totalMinor: out.reduce((s, i) => s + i.qty * i.unitPriceMinor, 0) };
}

const hint = (cardId: string) => cardId.slice(-4);
const qrView = (p: QrPayment): QrView => ({ paymentId: p.paymentId, payeeName: p.payeeName, amountMinor: p.amountMinor, currency: p.currency, qrPayload: p.qrPayload, payUrl: p.payUrl });

export class ShopOrderBook {
  private readonly orders = new Map<string, ShopOrder>();
  private readonly bills = new Map<string, TillBill>();

  constructor(private readonly deps: OrderBookDeps) {
    deps.qr.onPaid((p) => this.onQrPaid(p));
  }

  reset(): void {
    this.orders.clear();
    this.bills.clear();
  }

  /** Shared between instances (store/sync.ts). */
  collections(): Collection[] {
    return [mapCollection("shop.order", this.orders), mapCollection("shop.bill", this.bills)];
  }

  private now(): Promise<Date> {
    return this.deps.clock.now();
  }

  // ---------- delivery orders ----------

  /** Newest first. */
  listOrders(storeId: StoreId): ShopOrder[] {
    return [...this.orders.values()].filter((o) => o.storeId === storeId).reverse();
  }

  getOrder(storeId: StoreId, orderId: string): ShopOrder | undefined {
    const o = this.orders.get(orderId);
    return o?.storeId === storeId ? o : undefined;
  }

  async createOrder(
    storeId: StoreId,
    input: { clientRef?: string | null; items: ItemRequest[]; expectedTotalMinor?: number; deliveryAddress?: string | null; payment: { method: "CARD"; cardId: string } | { method: "QR" } },
  ): Promise<{ order: ShopOrder; qr: QrView | null; created: boolean }> {
    if (input.clientRef) {
      const existing = [...this.orders.values()].find((o) => o.storeId === storeId && o.clientRef === input.clientRef);
      if (existing) return { order: existing, qr: this.qrOf(existing.payment.qrPaymentId), created: false };
    }
    const store = PIZZA_STORES[storeId];
    const { items, totalMinor } = priced(storeId, input.items);
    if (input.expectedTotalMinor !== undefined && input.expectedTotalMinor !== totalMinor) {
      throw new HttpError(409, "AMOUNT_MISMATCH", `The shop's total is ${totalMinor}, not ${input.expectedTotalMinor}`, { totalMinor });
    }
    const at = (await this.now()).toISOString();
    const order: ShopOrder = {
      orderId: `ord_${randomBytes(8).toString("hex")}`,
      storeId,
      clientRef: input.clientRef ?? null,
      items,
      totalMinor,
      currency: store.currency,
      deliveryAddress: input.deliveryAddress ?? null,
      payment: { method: input.payment.method, cardHint: null, authorizationId: null, qrPaymentId: null },
      status: "AWAITING_PAYMENT",
      reasonCode: null,
      timeline: [{ status: "AWAITING_PAYMENT", at }],
      createdAt: at,
      updatedAt: at,
    };
    this.orders.set(order.orderId, order);
    if (input.payment.method === "CARD") {
      order.payment.cardHint = hint(input.payment.cardId);
      const r = await pizzaCheckout(this.deps, { cardId: input.payment.cardId, items: items.map((i) => ({ sku: i.sku, quantity: i.qty })) }, storeId);
      order.payment.authorizationId = r.body.authorizationId;
      if (r.body.status === "approved") await this.setOrderStatus(order, "RECEIVED");
      else await this.setOrderStatus(order, "DECLINED", r.body.reasonCode ?? "DECLINED");
      return { order, qr: null, created: true };
    }
    const qr = await this.deps.qr.create({ merchantId: store.id, amountMinor: totalMinor, currency: store.currency, reference: order.orderId });
    order.payment.qrPaymentId = qr.paymentId;
    // Kassa learns the order exists (awaiting the customer's QR payment).
    this.report(order);
    return { order, qr: qrView(qr), created: true };
  }

  /** Kitchen screen: one step forward along ORDER_FLOW. */
  async advance(storeId: StoreId, orderId: string): Promise<ShopOrder> {
    const o = this.getOrder(storeId, orderId);
    if (!o) throw new HttpError(404, "NOT_FOUND", "Unknown order");
    const i = (ORDER_FLOW as readonly string[]).indexOf(o.status);
    if (i < 0 || i === ORDER_FLOW.length - 1) throw new HttpError(409, "CANNOT_ADVANCE", `Order is ${o.status}`);
    await this.setOrderStatus(o, ORDER_FLOW[i + 1]!);
    return o;
  }

  /** SHOP_AUTOPILOT: every paid, undelivered order moves one step once `stepMs` of demo time passed since its last change. */
  async tick(): Promise<number> {
    if (!this.deps.autopilot) return 0;
    const now = (await this.now()).getTime();
    let moved = 0;
    for (const o of this.orders.values()) {
      const i = (ORDER_FLOW as readonly string[]).indexOf(o.status);
      if (i < 0 || i === ORDER_FLOW.length - 1) continue;
      if (now - Date.parse(o.updatedAt) < this.deps.stepMs) continue;
      await this.setOrderStatus(o, ORDER_FLOW[i + 1]!);
      moved++;
    }
    return moved;
  }

  private async setOrderStatus(o: ShopOrder, status: OrderStatus, reasonCode: string | null = null): Promise<void> {
    const at = (await this.now()).toISOString();
    o.status = status;
    o.reasonCode = reasonCode;
    o.updatedAt = at;
    o.timeline.push({ status, at });
    this.report(o);
  }

  private report(o: ShopOrder): void {
    this.deps.webhooks.send("shop", {
      eventId: randomUUID(),
      type: "shop.order.updated",
      storeId: o.storeId,
      orderId: o.orderId,
      clientRef: o.clientRef,
      status: o.status,
      reasonCode: o.reasonCode,
      items: o.items,
      totalMinor: o.totalMinor,
      currency: o.currency,
      at: o.updatedAt,
      simulated: true,
    });
  }

  // ---------- counter till ----------

  async createBill(storeId: StoreId, items: ItemRequest[]): Promise<TillBill> {
    const store = PIZZA_STORES[storeId];
    const p = priced(storeId, items);
    const at = (await this.now()).toISOString();
    // The store is part of the id so the Kassa app link (/pay/<billId>) needs no second parameter.
    const billId = `${storeId}-${randomBytes(10).toString("hex")}`;
    const bill: TillBill = {
      billId,
      storeId,
      items: p.items,
      totalMinor: p.totalMinor,
      currency: store.currency,
      status: "OPEN",
      reasonCode: null,
      clientRef: null,
      payment: null,
      payUrl: `${this.deps.kassaAppUrl}/pay/${billId}`,
      timeline: [{ status: "OPEN", at }],
      createdAt: at,
      paidAt: null,
    };
    this.bills.set(billId, bill);
    return bill;
  }

  getBill(storeId: StoreId, billId: string): TillBill | undefined {
    const b = this.bills.get(billId);
    return b?.storeId === storeId ? b : undefined;
  }

  private billOrThrow(storeId: StoreId, billId: string): TillBill {
    const b = this.getBill(storeId, billId);
    if (!b) throw new HttpError(404, "NOT_FOUND", "Unknown bill");
    if (b.status === "PAID") throw new HttpError(409, "ALREADY_PAID", "This bill is already paid");
    return b;
  }

  private checkTotal(b: TillBill, expectedTotalMinor: number | undefined): void {
    if (expectedTotalMinor !== undefined && expectedTotalMinor !== b.totalMinor) {
      throw new HttpError(409, "AMOUNT_MISMATCH", `The bill total is ${b.totalMinor}, not ${expectedTotalMinor}`, { totalMinor: b.totalMinor });
    }
  }

  /** Charge a one-time card for the bill (the till's card terminal; Kassa's issuer decides). */
  async payBillWithCard(storeId: StoreId, billId: string, input: { cardId: string; clientRef?: string | null; expectedTotalMinor?: number }): Promise<TillBill> {
    const b = this.billOrThrow(storeId, billId);
    this.checkTotal(b, input.expectedTotalMinor);
    b.clientRef = input.clientRef ?? b.clientRef;
    const r = await pizzaCheckout(this.deps, { cardId: input.cardId, items: b.items.map((i) => ({ sku: i.sku, quantity: i.qty })) }, storeId);
    b.payment = { method: "CARD", cardHint: hint(input.cardId), authorizationId: r.body.authorizationId, qrPaymentId: null };
    if (r.body.status === "approved") await this.setBillStatus(b, "PAID");
    else await this.setBillStatus(b, "DECLINED", r.body.reasonCode ?? "DECLINED");
    return b;
  }

  /** The bill as the shop's QR code in the QR wallet (Shanghai: Kassa hands the payment off). One code per bill. */
  async billQr(storeId: StoreId, billId: string, input: { clientRef?: string | null; expectedTotalMinor?: number }): Promise<{ bill: TillBill; qr: QrView }> {
    const b = this.billOrThrow(storeId, billId);
    this.checkTotal(b, input.expectedTotalMinor);
    b.clientRef = input.clientRef ?? b.clientRef;
    const existing = this.qrOf(b.payment?.qrPaymentId ?? null);
    if (existing) return { bill: b, qr: existing };
    const store = PIZZA_STORES[storeId];
    const qr = await this.deps.qr.create({ merchantId: store.id, amountMinor: b.totalMinor, currency: b.currency, reference: b.billId });
    b.payment = { method: "QR", cardHint: null, authorizationId: null, qrPaymentId: qr.paymentId };
    return { bill: b, qr: qrView(qr) };
  }

  /** Kassa refused to pay (rules or payments): the till shows red with the reason. The bill stays payable. */
  async declineBill(storeId: StoreId, billId: string, reasonCode: string): Promise<TillBill> {
    const b = this.billOrThrow(storeId, billId);
    await this.setBillStatus(b, "DECLINED", reasonCode);
    return b;
  }

  private async setBillStatus(b: TillBill, status: BillStatus, reasonCode: string | null = null): Promise<void> {
    const at = (await this.now()).toISOString();
    b.status = status;
    b.reasonCode = reasonCode;
    if (status === "PAID") b.paidAt = at;
    b.timeline.push({ status, at, ...(reasonCode ? { reasonCode } : {}) });
    this.deps.webhooks.send("shop", {
      eventId: randomUUID(),
      type: "shop.bill.updated",
      storeId: b.storeId,
      billId: b.billId,
      clientRef: b.clientRef,
      status,
      reasonCode,
      items: b.items,
      totalMinor: b.totalMinor,
      currency: b.currency,
      at,
      simulated: true,
    });
  }

  // ---------- QR wallet ----------

  private qrOf(qrPaymentId: string | null): QrView | null {
    const p = qrPaymentId ? this.deps.qr.get(qrPaymentId) : undefined;
    return p && p.status === "PENDING" ? qrView(p) : null;
  }

  /** A paid QR code that belongs to an order or bill of this shop moves it on (amount and merchant must match). */
  private async onQrPaid(p: QrPayment): Promise<void> {
    for (const o of this.orders.values()) {
      if (o.payment.qrPaymentId !== p.paymentId || o.status !== "AWAITING_PAYMENT") continue;
      if (p.payeeName !== PIZZA_STORES[o.storeId].name || p.amountMinor !== o.totalMinor) await this.setOrderStatus(o, "DECLINED", "QR_PAYEE_MISMATCH");
      else await this.setOrderStatus(o, "RECEIVED");
      return;
    }
    for (const b of this.bills.values()) {
      if (b.payment?.qrPaymentId !== p.paymentId || b.status === "PAID") continue;
      if (p.payeeName !== PIZZA_STORES[b.storeId].name || p.amountMinor !== b.totalMinor) await this.setBillStatus(b, "DECLINED", "QR_PAYEE_MISMATCH");
      else await this.setBillStatus(b, "PAID");
      return;
    }
  }
}
