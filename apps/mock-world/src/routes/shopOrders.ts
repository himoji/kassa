import type { FastifyInstance, FastifyReply } from "fastify";
import { formatMoney } from "@kassa/shared";
import { z } from "zod";

import type { MockWorldConfig } from "../config.ts";
import { HttpError, parseWith } from "../errors.ts";
import { esc, page } from "../html.ts";
import { qrSvg } from "../qr/svg.ts";
import { ORDER_FLOW, type ShopOrderBook } from "../shop/orders.ts";
import { PIZZA_MENUS } from "../world/data.ts";
import { resolveStore } from "./shop.ts";

/*
 * (M2/M3) The pizza shops' order book over HTTP (simulated third-party systems):
 *   POST /shop/:store/orders                 {clientRef?, items:[{sku,qty}], expectedTotalMinor?, deliveryAddress?,
 *                                             payment: {method:"CARD", cardId} | {method:"QR"}} → {order, qr}
 *   GET  /shop/:store/orders/:orderId        one order
 *   GET  /shop/:store/bills/:billId          one till bill
 *   POST /shop/:store/bills/:billId/pay      {cardId, clientRef?, expectedTotalMinor?} (card terminal)
 *   POST /shop/:store/bills/:billId/qr       {clientRef?, expectedTotalMinor?} → {bill, qr} (the shop's QR code)
 *   POST /shop/:store/bills/:billId/decline  {reasonCode} (Kassa refused to pay: the till shows red)
 * Demo-only (404 unless DEMO_ENABLED, like the Stage; they are public pages over the phone tunnel):
 *   GET  /shop/:store/kitchen, GET /shop/:store/orders, POST /shop/:store/orders/:orderId/advance
 *   GET  /shop/:store/till, POST /shop/:store/bills {items}, GET /shop/:store/bills/:billId/qr.svg
 * Order creation and bill payment answer 200/201 with the resulting status, including DECLINED (the shop's view).
 */

const Items = z
  .array(z.object({ sku: z.string().min(1).max(64), qty: z.number().int().min(1).max(50) }))
  .min(1)
  .max(20);
const Total = z.number().int().positive().refine(Number.isSafeInteger).optional();
const ClientRef = z.string().min(1).max(64).nullable().optional();

const CreateOrderBody = z.object({
  clientRef: ClientRef,
  items: Items,
  expectedTotalMinor: Total,
  deliveryAddress: z.string().max(280).nullable().optional(),
  payment: z.discriminatedUnion("method", [z.object({ method: z.literal("CARD"), cardId: z.string().min(3).max(128) }), z.object({ method: z.literal("QR") })]),
});
const PayBillBody = z.object({ cardId: z.string().min(3).max(128), clientRef: ClientRef, expectedTotalMinor: Total });
const BillQrBody = z.object({ clientRef: ClientRef, expectedTotalMinor: Total });
const DeclineBody = z.object({ reasonCode: z.string().regex(/^[A-Z0-9_]{2,64}$/) });

type P = { store?: unknown; orderId?: unknown; billId?: unknown };
const idOf = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{4,80}$/.test(v) ? v : "");

export function shopOrderRoutes(app: FastifyInstance, deps: { config: MockWorldConfig; book: ShopOrderBook }): void {
  const { book } = deps;
  const demoOnly = () => {
    if (!deps.config.demoEnabled) throw new HttpError(404, "NOT_FOUND", "Not found");
  };
  const html = (reply: FastifyReply, body: string) => reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(body);

  // ---------- delivery orders ----------

  app.post("/shop/:store/orders", async (req, reply) => {
    const store = resolveStore((req.params as P).store);
    const b = parseWith(CreateOrderBody, req.body);
    const r = await book.createOrder(store.storeId, {
      clientRef: b.clientRef ?? null,
      items: b.items,
      ...(b.expectedTotalMinor !== undefined ? { expectedTotalMinor: b.expectedTotalMinor } : {}),
      deliveryAddress: b.deliveryAddress ?? null,
      payment: b.payment,
    });
    return reply.code(r.created ? 201 : 200).send({ order: r.order, qr: r.qr, simulated: true });
  });

  app.get("/shop/:store/orders/:orderId", async (req) => {
    const store = resolveStore((req.params as P).store);
    const o = book.getOrder(store.storeId, idOf((req.params as P).orderId));
    if (!o) throw new HttpError(404, "NOT_FOUND", "Unknown order");
    return { order: o, simulated: true };
  });

  app.get("/shop/:store/orders", async (req) => {
    demoOnly();
    const store = resolveStore((req.params as P).store);
    return { orders: book.listOrders(store.storeId).slice(0, 50), simulated: true };
  });

  app.post("/shop/:store/orders/:orderId/advance", async (req) => {
    demoOnly();
    const store = resolveStore((req.params as P).store);
    return { order: await book.advance(store.storeId, idOf((req.params as P).orderId)), simulated: true };
  });

  // ---------- counter till ----------

  app.post("/shop/:store/bills", async (req, reply) => {
    demoOnly();
    const store = resolveStore((req.params as P).store);
    const { items } = parseWith(z.object({ items: Items }), req.body);
    return reply.code(201).send({ bill: await book.createBill(store.storeId, items), simulated: true });
  });

  const billOf = (req: { params: unknown }) => {
    const store = resolveStore((req.params as P).store);
    return { storeId: store.storeId, billId: idOf((req.params as P).billId) };
  };

  app.get("/shop/:store/bills/:billId", async (req) => {
    const { storeId, billId } = billOf(req);
    const b = book.getBill(storeId, billId);
    if (!b) throw new HttpError(404, "NOT_FOUND", "Unknown bill");
    const store = resolveStore(storeId);
    return { bill: b, merchant: { storeId, name: store.name, city: store.city, country: store.country }, simulated: true };
  });

  app.get("/shop/:store/bills/:billId/qr.svg", async (req, reply) => {
    demoOnly();
    const { storeId, billId } = billOf(req);
    const b = book.getBill(storeId, billId);
    if (!b) throw new HttpError(404, "NOT_FOUND", "Unknown bill");
    const svg = await qrSvg(b.payUrl);
    return reply.type("image/svg+xml").header("cache-control", "no-store").send(svg);
  });

  app.post("/shop/:store/bills/:billId/pay", async (req) => {
    const { storeId, billId } = billOf(req);
    const b = parseWith(PayBillBody, req.body);
    return {
      bill: await book.payBillWithCard(storeId, billId, { cardId: b.cardId, clientRef: b.clientRef ?? null, ...(b.expectedTotalMinor !== undefined ? { expectedTotalMinor: b.expectedTotalMinor } : {}) }),
      simulated: true,
    };
  });

  app.post("/shop/:store/bills/:billId/qr", async (req) => {
    const { storeId, billId } = billOf(req);
    const b = parseWith(BillQrBody, req.body);
    const r = await book.billQr(storeId, billId, { clientRef: b.clientRef ?? null, ...(b.expectedTotalMinor !== undefined ? { expectedTotalMinor: b.expectedTotalMinor } : {}) });
    return { ...r, simulated: true };
  });

  app.post("/shop/:store/bills/:billId/decline", async (req) => {
    const { storeId, billId } = billOf(req);
    const { reasonCode } = parseWith(DeclineBody, req.body);
    return { bill: await book.declineBill(storeId, billId, reasonCode), simulated: true };
  });

  // ---------- pages (demo only) ----------

  app.get("/shop/:store/kitchen", async (req, reply) => {
    demoOnly();
    const store = resolveStore((req.params as P).store);
    const base = `/mock/shop/${store.storeId}`;
    const body = `
<h1>${esc(store.name)}: kitchen screen</h1>
<p class="muted">Simulated restaurant system. Orders paid through Kassa appear here; each step is reported back to Kassa.</p>
<div id="orders" aria-live="polite"><p class="muted">No orders yet.</p></div>`;
    const script = `
const BASE = ${JSON.stringify(base)};
const FLOW = ${JSON.stringify(ORDER_FLOW)};
const CUR = ${JSON.stringify(store.currency)};
const fmt = (m) => new Intl.NumberFormat(undefined, { style: 'currency', currency: CUR }).format(m / 100);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
async function advance(id) {
  await fetch(BASE + '/orders/' + encodeURIComponent(id) + '/advance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  load();
}
async function load() {
  const res = await fetch(BASE + '/orders', { cache: 'no-store' });
  if (!res.ok) return;
  const { orders } = await res.json();
  const box = document.getElementById('orders');
  box.replaceChildren();
  if (orders.length === 0) { box.append(el('p', 'muted', 'No orders yet.')); return; }
  for (const o of orders) {
    const card = el('div', 'card');
    const head = el('h2', '', o.orderId + '  ' + fmt(o.totalMinor));
    const st = el('div', 'status ' + (o.status === 'DECLINED' ? 'bad' : o.status === 'DELIVERED' ? 'ok' : ''), o.status + (o.reasonCode ? ' (' + o.reasonCode + ')' : ''));
    const list = el('ul');
    for (const i of o.items) list.append(el('li', '', i.qty + ' x ' + i.name));
    card.append(head, st, list, el('div', 'muted', 'Paid by ' + (o.payment.method === 'CARD' ? 'one-time card ..' + (o.payment.cardHint || '') : 'QR wallet')));
    const i = FLOW.indexOf(o.status);
    if (i >= 0 && i < FLOW.length - 1) {
      const b = el('button', '', 'Mark ' + FLOW[i + 1].replaceAll('_', ' ').toLowerCase());
      b.onclick = () => { b.disabled = true; advance(o.orderId); };
      card.append(el('p'), b);
    }
    box.append(card);
  }
}
load(); setInterval(load, 1000);`;
    return html(reply, page(`${store.name} kitchen`, body, { script }));
  });

  app.get("/shop/:store/till", async (req, reply) => {
    demoOnly();
    const store = resolveStore((req.params as P).store);
    const base = `/mock/shop/${store.storeId}`;
    const buttons = PIZZA_MENUS[store.storeId]
      .map((m) => `<button class="item" data-sku="${esc(m.sku)}" style="margin:4px">${esc(m.name)}<br><span style="font-weight:400">${esc(formatMoney(m.priceMinor, store.currency))}</span></button>`)
      .join("");
    const body = `
<h1>${esc(store.name)}: counter till</h1>
<p class="muted">Simulated till. Tap items, create the bill, and the customer scans the code with their phone to pay in Kassa.</p>
<div id="entry" class="card">
  <div>${buttons}</div>
  <ul id="cart"></ul>
  <div class="amount" id="total"></div>
  <p><button id="create" disabled>Create bill</button> <button id="clear">Clear</button></p>
</div>
<div id="billbox" class="card" hidden>
  <div class="muted">Scan to pay in Kassa</div>
  <img id="qr" alt="Bill QR code" style="width:260px;height:260px;background:#fff;padding:8px;border-radius:8px">
  <div class="mono" id="link"></div>
  <div class="amount" id="billtotal"></div>
  <p id="state" class="status" aria-live="polite">Waiting for payment...</p>
  <p><button id="new">New bill</button></p>
</div>`;
    const script = `
const BASE = ${JSON.stringify(base)};
const CUR = ${JSON.stringify(store.currency)};
const MENU = ${JSON.stringify(Object.fromEntries(PIZZA_MENUS[store.storeId].map((m) => [m.sku, { name: m.name, priceMinor: m.priceMinor }])))};
const fmt = (m) => new Intl.NumberFormat(undefined, { style: 'currency', currency: CUR }).format(m / 100);
let cart = {}; let bill = null; let timer = null;
function render() {
  const ul = document.getElementById('cart'); ul.replaceChildren(); let total = 0;
  for (const [sku, qty] of Object.entries(cart)) { const li = document.createElement('li'); li.textContent = qty + ' x ' + MENU[sku].name; ul.append(li); total += qty * MENU[sku].priceMinor; }
  document.getElementById('total').textContent = total ? fmt(total) : '';
  document.getElementById('create').disabled = total === 0;
}
document.querySelectorAll('button.item').forEach((b) => { b.onclick = () => { cart[b.dataset.sku] = (cart[b.dataset.sku] || 0) + 1; render(); }; });
document.getElementById('clear').onclick = () => { cart = {}; render(); };
document.getElementById('new').onclick = () => { clearInterval(timer); bill = null; cart = {}; render(); document.getElementById('entry').hidden = false; document.getElementById('billbox').hidden = true; };
document.getElementById('create').onclick = async (e) => {
  e.target.disabled = true;
  const items = Object.entries(cart).map(([sku, qty]) => ({ sku, qty }));
  const res = await fetch(BASE + '/bills', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) });
  if (!res.ok) { e.target.disabled = false; return; }
  bill = (await res.json()).bill;
  document.getElementById('qr').src = BASE + '/bills/' + encodeURIComponent(bill.billId) + '/qr.svg';
  document.getElementById('link').textContent = bill.payUrl;
  document.getElementById('billtotal').textContent = fmt(bill.totalMinor);
  document.getElementById('entry').hidden = true; document.getElementById('billbox').hidden = false;
  show(bill); timer = setInterval(poll, 1000);
};
function show(b) {
  const s = document.getElementById('state');
  const box = document.getElementById('billbox');
  if (b.status === 'PAID') { s.className = 'status ok'; s.textContent = 'PAID'; box.style.background = '#bbf7d0'; clearInterval(timer); }
  else if (b.status === 'DECLINED') { s.className = 'status bad'; s.textContent = 'DECLINED: ' + (b.reasonCode || 'unknown reason'); box.style.background = '#fecaca'; }
  else { s.className = 'status'; s.textContent = 'Waiting for payment...'; box.style.background = ''; }
}
async function poll() {
  if (!bill) return;
  const res = await fetch(BASE + '/bills/' + encodeURIComponent(bill.billId), { cache: 'no-store' });
  if (res.ok) show((await res.json()).bill);
}
render();`;
    return html(reply, page(`${store.name} till`, body, { narrow: true, script }));
  });
}
