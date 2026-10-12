import { verifyMockWebhook, formatMoney, MOCK_WEBHOOK_SIGNATURE_HEADER, MOCK_WEBHOOK_TIMESTAMP_HEADER } from "@kassa/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { Clock } from "../clock.ts";
import type { MockWorldConfig } from "../config.ts";
import { HttpError, parseWith } from "../errors.ts";
import { esc, page } from "../html.ts";
import { ATTACK_TARGETS, resolveSupplier, type SupplierBook } from "../supplier/book.ts";

/*
 * (added 2026-10-15, Business M5) Suppliers' purchase orders over HTTP (simulated third-party systems):
 *   POST /supplier/purchase-orders            Kassa sends a signed PO; HMAC (X-Kassa-Timestamp / X-Kassa-Signature over
 *                                              the raw body, MOCK_HMAC_SECRET, 5-minute window) or 401
 * Demo-only (404 unless DEMO_ENABLED; public pages over the phone tunnel):
 *   GET  /supplier/:id/portal                  the supplier's portal page (Confirm / Mark delivered / Issue invoice)
 *   GET  /supplier/:id/purchase-orders         JSON
 *   POST /supplier/:id/purchase-orders/:po/{confirm,deliver,invoice}   (invoice: {amountMinor?})
 *   POST /supplier/:id/attack/swapped-invoice  {purchaseOrderId} (B and D only: A9, invoice with swapped bank details)
 *   GET  /supplier/:id/invoices/:invoiceId/invoice.pdf
 * Registered in its own encapsulation context (raw-body JSON parser for the HMAC check).
 */

const Line = z.object({
  supplierSku: z.string().min(1).max(64),
  packs: z.number().int().positive(),
  packSize: z.number().int().positive(),
  packPriceMinor: z.number().int().positive(),
  lineTotalMinor: z.number().int().positive(),
});
const ReceiveBody = z.object({
  purchaseOrderId: z.string().uuid(),
  poHash: z.string().nullable(),
  supplierName: z.string().min(1).max(140),
  merchant: z.object({ slug: z.string().min(1).max(64), name: z.string().min(1).max(140) }),
  currency: z.string().length(3),
  lines: z.array(Line).min(1).max(50),
  totalMinor: z.number().int().positive(),
  deliverBy: z.string().max(10),
});

type P = { id?: unknown; po?: unknown; invoiceId?: unknown };
const idOf = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{4,80}$/.test(v) ? v : "");

declare module "fastify" {
  interface FastifyRequest {
    mockRawBody?: string;
  }
}

export async function supplierPortalRoutes(app: FastifyInstance, deps: { config: MockWorldConfig; book: SupplierBook; clock: Clock }): Promise<void> {
  const { book } = deps;
  const demoOnly = () => {
    if (!deps.config.demoEnabled) throw new HttpError(404, "NOT_FOUND", "Not found");
  };
  const html = (reply: FastifyReply, body: string) => reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(body);

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.mockRawBody = body as string;
    try {
      done(null, (body as string).length > 0 ? JSON.parse(body as string) : {});
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.post("/supplier/purchase-orders", async (req, reply) => {
    const ts = req.headers[MOCK_WEBHOOK_TIMESTAMP_HEADER];
    const sig = req.headers[MOCK_WEBHOOK_SIGNATURE_HEADER];
    const v = verifyMockWebhook(
      deps.config.hmacSecret,
      typeof ts === "string" ? ts : undefined,
      typeof sig === "string" ? sig : undefined,
      req.mockRawBody ?? "",
      Math.floor((await deps.clock.now()).getTime() / 1000),
    );
    if (!v.ok) throw new HttpError(401, v.code, "Purchase order not signed by Kassa");
    const b = parseWith(ReceiveBody, req.body);
    const r = await book.receive(b);
    return reply.code(r.created ? 201 : 200).send({ order: r.order, simulated: true });
  });

  app.get("/supplier/:id/purchase-orders", async (req) => {
    demoOnly();
    const s = resolveSupplier((req.params as P).id);
    const target = ATTACK_TARGETS[s.id];
    return { supplier: { id: s.id, name: s.name }, orders: book.list(s.id), attackable: target ? book.list(target) : [], simulated: true };
  });

  const po = (req: { params: unknown }) => ({ s: resolveSupplier((req.params as P).id), id: idOf((req.params as P).po) });

  app.post("/supplier/:id/purchase-orders/:po/confirm", async (req) => {
    demoOnly();
    const { s, id } = po(req);
    return { order: book.confirm(s.id, id), simulated: true };
  });

  app.post("/supplier/:id/purchase-orders/:po/deliver", async (req) => {
    demoOnly();
    const { s, id } = po(req);
    return { order: book.deliver(s.id, id), simulated: true };
  });

  app.post("/supplier/:id/purchase-orders/:po/invoice", async (req) => {
    demoOnly();
    const { s, id } = po(req);
    const b = parseWith(z.object({ amountMinor: z.number().int().positive().optional() }), req.body);
    return { invoice: await book.invoice(s.id, id, b.amountMinor !== undefined ? { amountMinor: b.amountMinor } : {}), simulated: true };
  });

  app.post("/supplier/:id/attack/swapped-invoice", async (req) => {
    demoOnly();
    const s = resolveSupplier((req.params as P).id);
    const b = parseWith(z.object({ purchaseOrderId: z.string().uuid() }), req.body);
    return { invoice: await book.swappedInvoice(s.id, b.purchaseOrderId), simulated: true };
  });

  app.get("/supplier/:id/invoices/:invoiceId/invoice.pdf", async (req, reply) => {
    demoOnly();
    const s = resolveSupplier((req.params as P).id);
    const pdf = await book.invoicePdf(s.id, idOf((req.params as P).invoiceId));
    return reply.type("application/pdf").header("cache-control", "no-store").send(Buffer.from(pdf));
  });

  app.get("/supplier/:id/portal", async (req, reply) => {
    demoOnly();
    const s = resolveSupplier((req.params as P).id);
    const target = ATTACK_TARGETS[s.id];
    const base = `/mock/supplier/${s.id}`;
    const body = `
<h1>${esc(s.name)}: supplier portal</h1>
<p class="muted">Simulated supplier system. Purchase orders signed in Kassa arrive here; each step is reported back to Kassa. Prices in ${esc(s.currency)} (e.g. ${esc(formatMoney(s.items[0]?.priceMinor ?? 0, s.currency))}).</p>
<div id="orders" aria-live="polite"><p class="muted">No purchase orders yet.</p></div>
${target ? `<h2>Fraud test (simulated attack)</h2><p class="muted">Send an invoice for ${esc(resolveSupplier(target).name)}'s order, in their name, with this supplier's bank details. Kassa must refuse it.</p><div id="attack"></div>` : ""}`;
    const script = `
const BASE = ${JSON.stringify(base)};
const CUR = ${JSON.stringify(s.currency)};
const fmt = (m) => new Intl.NumberFormat(undefined, { style: 'currency', currency: CUR }).format(m / 100);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
async function post(path, body) { await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); load(); }
function button(label, fn) { const b = el('button', '', label); b.style.margin = '4px'; b.onclick = () => { b.disabled = true; fn(); }; return b; }
async function load() {
  const res = await fetch(BASE + '/purchase-orders', { cache: 'no-store' });
  if (!res.ok) return;
  const { orders, attackable } = await res.json();
  const box = document.getElementById('orders');
  box.replaceChildren();
  if (orders.length === 0) box.append(el('p', 'muted', 'No purchase orders yet.'));
  for (const o of orders) {
    const card = el('div', 'card');
    card.append(el('h2', '', o.merchant.name + '  ' + fmt(o.totalMinor)), el('div', 'status', o.status), el('div', 'muted', 'Deliver by ' + o.deliverBy));
    const list = el('ul');
    for (const l of o.lines) list.append(el('li', '', l.packs + ' x ' + l.supplierSku));
    card.append(list);
    const id = encodeURIComponent(o.purchaseOrderId);
    if (o.status === 'RECEIVED') card.append(button('Confirm', () => post('/purchase-orders/' + id + '/confirm')));
    if (o.status === 'CONFIRMED' || o.status === 'INVOICED') card.append(button('Mark delivered', () => post('/purchase-orders/' + id + '/deliver')));
    if ((o.status === 'CONFIRMED' || o.status === 'DELIVERED') && !o.invoices.some((i) => !i.swapped)) card.append(button('Issue invoice', () => post('/purchase-orders/' + id + '/invoice')));
    for (const i of o.invoices) { const a = el('a', '', 'Invoice ' + i.invoiceId + ' (PDF)'); a.href = '/mock/supplier/' + i.issuedBy + '/invoices/' + i.invoiceId + '/invoice.pdf'; card.append(el('p'), a); }
    box.append(card);
  }
  const atk = document.getElementById('attack');
  if (atk) {
    atk.replaceChildren();
    if (attackable.length === 0) atk.append(el('p', 'muted', 'No orders to target yet.'));
    for (const o of attackable) {
      const card = el('div', 'card');
      card.append(el('div', '', o.supplierName + ' / ' + o.merchant.name + '  ' + fmt(o.totalMinor) + '  (' + o.status + ')'));
      card.append(button('Send invoice with swapped bank details', () => post('/attack/swapped-invoice', { purchaseOrderId: o.purchaseOrderId })));
      atk.append(card);
    }
  }
}
load(); setInterval(load, 1500);`;
    return html(reply, page(`${s.name} portal`, body, { script }));
  });
}
