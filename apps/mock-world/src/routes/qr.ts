import type { FastifyInstance } from "fastify";
import { formatMoney, isSupportedCurrency } from "@kassa/shared";
import { z } from "zod";

import { HttpError, parseWith } from "../errors.ts";
import { esc, page } from "../html.ts";
import type { QrPayment, QrWallet } from "../qr/qr.ts";
import { QrError } from "../qr/qr.ts";

/*
 * QR wallet (simulated), spec §11 Handoff and §17:
 *   POST /qr/payments          {merchantId | payeeName, amountMinor, currency, reference?, variant?}
 *                              -> {paymentId, payeeName, amountMinor, currency, qrPayload, payUrl, ...}
 *   GET  /qr/payments/:id      JSON view
 *   GET  /qr/:paymentId        "QR Wallet (simulated)" phone-sized page with a Pay button
 *   POST /qr/:paymentId/pay    marks paid, HMAC webhook to /api/webhooks/mock/qr
 *   POST /qr/attack/swap       {enabled} demo switch for A5 (every new code names another payee)
 * The JSON view never reveals the variant: the API must catch a swap by comparing payeeName.
 */

const CreateBody = z
  .object({
    merchantId: z.string().min(1).max(64).optional(),
    payeeName: z.string().min(1).max(140).optional(),
    amountMinor: z.number().int().positive().refine(Number.isSafeInteger),
    currency: z.string().regex(/^[A-Z]{3}$/),
    reference: z.string().max(140).nullable().optional(),
    variant: z.enum(["normal", "swapped"]).optional(),
  })
  .refine((b) => b.merchantId !== undefined || b.payeeName !== undefined, { message: "merchantId or payeeName is required" });

export function publicView(p: QrPayment) {
  return {
    paymentId: p.paymentId,
    merchantId: p.merchantId,
    payeeName: p.payeeName,
    amountMinor: p.amountMinor,
    currency: p.currency,
    reference: p.reference,
    qrPayload: p.qrPayload,
    payUrl: p.payUrl,
    status: p.status,
    createdAt: p.createdAt,
    paidAt: p.paidAt,
    simulated: true as const,
  };
}

function rethrow(err: unknown): never {
  if (err instanceof QrError) throw new HttpError(err.status, err.code, err.message);
  throw err;
}

const IdParam = z.object({ paymentId: z.string().uuid() });

export function qrRoutes(app: FastifyInstance, qr: QrWallet): void {
  app.post("/qr/payments", async (req, reply) => {
    const b = parseWith(CreateBody, req.body);
    if (!isSupportedCurrency(b.currency)) throw new HttpError(400, "BAD_REQUEST", `Unsupported currency ${b.currency}`);
    const p = await qr
      .create({
        ...(b.merchantId !== undefined ? { merchantId: b.merchantId } : {}),
        ...(b.payeeName !== undefined ? { payeeName: b.payeeName } : {}),
        amountMinor: b.amountMinor,
        currency: b.currency,
        reference: b.reference ?? null,
        ...(b.variant !== undefined ? { variant: b.variant } : {}),
      })
      .catch(rethrow);
    return reply.code(201).send(publicView(p));
  });

  app.get("/qr/payments/:paymentId", async (req) => {
    const { paymentId } = parseWith(IdParam, req.params, "params");
    const p = qr.get(paymentId);
    if (!p) throw new HttpError(404, "NOT_FOUND", "Unknown payment");
    return publicView(p);
  });

  app.post("/qr/attack/swap", async (req) => {
    const { enabled } = parseWith(z.object({ enabled: z.boolean() }), req.body);
    qr.swapAll = enabled;
    return { swapAll: qr.swapAll, simulated: true };
  });

  app.post("/qr/:paymentId/pay", async (req) => {
    const { paymentId } = parseWith(IdParam, req.params, "params");
    const p = await qr.pay(paymentId).catch(rethrow);
    return publicView(p);
  });

  app.get("/qr/:paymentId", async (req, reply) => {
    const r = IdParam.safeParse(req.params);
    const p = r.success ? qr.get(r.data.paymentId) : undefined;
    if (!p) {
      return reply.code(404).type("text/html; charset=utf-8").send(page("QR Wallet", "<h1>QR Wallet (simulated)</h1><p>Unknown payment code.</p>", { narrow: true }));
    }
    const paid = p.status === "PAID";
    const body = `
<h1>QR Wallet (simulated)</h1>
<div class="card">
  <div class="muted">Pay to</div>
  <h2 id="payee">${esc(p.payeeName)}</h2>
  <div class="amount">${esc(formatMoney(p.amountMinor, p.currency))}</div>
  ${p.reference ? `<div class="muted">Reference: <span class="mono">${esc(p.reference)}</span></div>` : ""}
</div>
<div class="card">
  <div class="muted">Scanned code (EMV QR payload)</div>
  <div class="mono">${esc(p.qrPayload)}</div>
</div>
<p><button id="pay" ${paid ? "disabled" : ""}>${paid ? "Paid" : "Pay"}</button></p>
<p id="out" class="status ${paid ? "ok" : ""}" aria-live="polite">${paid ? `Paid at ${esc(p.paidAt)}` : ""}</p>`;
    const script = `
document.getElementById('pay').onclick = async (e) => {
  e.target.disabled = true;
  const res = await fetch(location.pathname + '/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const j = await res.json();
  const out = document.getElementById('out');
  if (res.ok) { out.className = 'status ok'; out.textContent = 'Paid. The wallet notified Kassa.'; e.target.textContent = 'Paid'; }
  else { out.className = 'status bad'; out.textContent = j.error || 'Payment failed'; }
};`;
    return reply.type("text/html; charset=utf-8").send(page("QR Wallet", body, { narrow: true, script }));
  });
}
