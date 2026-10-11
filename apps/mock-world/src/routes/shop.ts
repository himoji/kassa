import type { FastifyInstance } from "fastify";
import { formatMoney } from "@kassa/shared";
import { z } from "zod";

import type { Clock } from "../clock.ts";
import { HttpError, parseWith } from "../errors.ts";
import { esc, page } from "../html.ts";
import type { AuthorizationResult, Issuer } from "../shop/issuer.ts";
import { PIZZA_MENU, PIZZA_SHOP } from "../world/data.ts";

/*
 * Pizza Shop (spec §17): GET /shop/pizza/menu, POST /shop/pizza/checkout {cardId}. Checkout asks
 * the issuer to authorize (Stripe test helper or the API's fake issuing). The shop itself does not
 * block a second charge on the same card: the demo point is that the issuer (Kassa's webhook)
 * declines it. GET /shop/pizza is a small page to run that live.
 */

const CheckoutBody = z
  .object({
    cardId: z.string().min(3).max(128),
    items: z
      .array(z.object({ sku: z.string(), quantity: z.number().int().min(1).max(50) }))
      .min(1)
      .max(20)
      .optional(),
    amountMinor: z.number().int().positive().refine(Number.isSafeInteger).optional(),
  })
  .refine((b) => b.items !== undefined || b.amountMinor !== undefined, { message: "items or amountMinor is required" });

export interface Charge {
  at: string;
  cardId: string;
  amountMinor: number;
  currency: string;
  result: AuthorizationResult;
}

export class ChargeLog {
  readonly charges: Charge[] = [];
  reset(): void {
    this.charges.length = 0;
  }
}

function priceItems(items: { sku: string; quantity: number }[]): number {
  let total = 0;
  for (const it of items) {
    const m = PIZZA_MENU.find((x) => x.sku === it.sku);
    if (!m) throw new HttpError(400, "UNKNOWN_SKU", `Unknown item ${it.sku}`);
    total += m.priceMinor * it.quantity;
  }
  return total;
}

export function shopRoutes(app: FastifyInstance, deps: { issuer: Issuer; clock: Clock; log: ChargeLog }): void {
  app.get("/shop/pizza/menu", async () => ({
    merchant: { ...PIZZA_SHOP },
    currency: PIZZA_SHOP.currency,
    items: PIZZA_MENU.map((m) => ({ ...m, currency: PIZZA_SHOP.currency })),
    simulated: true,
  }));

  app.post("/shop/pizza/checkout", async (req, reply) => {
    const body = parseWith(CheckoutBody, req.body);
    const amountMinor = body.items ? priceItems(body.items) : body.amountMinor!;
    if (body.items && body.amountMinor !== undefined && body.amountMinor !== amountMinor) {
      throw new HttpError(400, "AMOUNT_MISMATCH", "amountMinor does not match the items total");
    }
    const result = await deps.issuer.authorize({
      cardId: body.cardId,
      amountMinor,
      currency: PIZZA_SHOP.currency,
      merchant: {
        name: PIZZA_SHOP.name,
        mcc: PIZZA_SHOP.mcc,
        stripeCategory: PIZZA_SHOP.stripeCategory,
        city: PIZZA_SHOP.city,
        country: PIZZA_SHOP.country,
      },
    });
    const at = (await deps.clock.now()).toISOString();
    deps.log.charges.push({ at, cardId: body.cardId, amountMinor, currency: PIZZA_SHOP.currency, result });
    const status = result.approved ? 200 : result.reasonCode === "ISSUER_UNAVAILABLE" ? 502 : 402;
    return reply.code(status).send({
      status: result.approved ? "approved" : "declined",
      provider: result.provider,
      authorizationId: result.authorizationId,
      reasonCode: result.reasonCode,
      amountMinor,
      currency: PIZZA_SHOP.currency,
      merchant: PIZZA_SHOP.name,
      at,
      simulated: true,
    });
  });

  app.get("/shop/pizza/charges", async () => ({ charges: deps.log.charges, simulated: true }));

  app.get("/shop/pizza", async (_req, reply) => {
    const rows = PIZZA_MENU.map(
      (m) =>
        `<tr><td>${esc(m.name)}<div class="muted">${esc(m.description)}</div></td><td>${esc(formatMoney(m.priceMinor, PIZZA_SHOP.currency))}</td><td class="mono">${esc(m.sku)}</td></tr>`,
    ).join("");
    const body = `
<h1>${esc(PIZZA_SHOP.name)}</h1>
<p class="muted">Simulated restaurant. Generic name, no real brand. Card issuer: <b>${esc(deps.issuer.provider)}</b>.</p>
<div class="card"><h2>Menu</h2><table><thead><tr><th>Item</th><th>Price</th><th>SKU</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="card">
  <h2>Checkout: 2 x Margherita</h2>
  <label for="card">One-time card id (from the Kassa approval)</label>
  <input id="card" autocomplete="off" placeholder="ic_... or fake card id">
  <p><button id="pay">Charge card</button> <button id="again">Charge the same card again</button></p>
  <div id="out" class="mono" aria-live="polite"></div>
</div>`;
    const script = `
const out = document.getElementById('out');
async function charge() {
  const cardId = document.getElementById('card').value.trim();
  if (!cardId) { out.textContent = 'Enter a card id first.'; return; }
  const res = await fetch('./pizza/checkout', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cardId, items: [{ sku: 'PZ-MARG', quantity: 2 }] }) });
  const j = await res.json();
  const line = document.createElement('div');
  line.className = 'status ' + (j.status === 'approved' ? 'ok' : 'bad');
  line.textContent = new Date().toLocaleTimeString() + '  ' + (j.status || 'error').toUpperCase() + (j.reasonCode ? ' (' + j.reasonCode + ')' : '');
  out.prepend(line);
}
document.getElementById('pay').onclick = charge;
document.getElementById('again').onclick = charge;`;
    return reply.type("text/html; charset=utf-8").send(page("Pizza Shop", body, { script }));
  });
}
