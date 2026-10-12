import type { FastifyInstance } from "fastify";
import { formatMoney } from "@kassa/shared";
import { z } from "zod";

import type { Clock } from "../clock.ts";
import { HttpError, parseWith } from "../errors.ts";
import { esc, page } from "../html.ts";
import type { AuthorizationResult, Issuer } from "../shop/issuer.ts";
import { PIZZA_MENUS, PIZZA_STORES, type PizzaStore, STORE_ALIASES } from "../world/data.ts";
import type { StoreId } from "../../../../fixtures/seed-data.ts";

/*
 * Pizza shops (spec §17): GET /shop/:store/menu, POST /shop/:store/checkout {cardId}. Stores: "bud" (Pizza Shop in
 * Budapest, HUF) and "sha" (Pizza Shop in Shanghai, CNY); "pizza" is the original name of the Budapest routes and stays
 * an alias. Checkout asks the issuer to authorize (Stripe test helper or the API's fake issuing). The shop itself does
 * not block a second charge on the same card: the demo point is that the issuer (Kassa's webhook) declines it.
 * GET /shop/:store is a small page to run that live.
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
  storeId: StoreId;
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

function priceItems(storeId: StoreId, items: { sku: string; quantity: number }[]): number {
  let total = 0;
  for (const it of items) {
    const m = PIZZA_MENUS[storeId].find((x) => x.sku === it.sku);
    if (!m) throw new HttpError(400, "UNKNOWN_SKU", `Unknown item ${it.sku}`);
    total += m.priceMinor * it.quantity;
  }
  return total;
}

/** The store a route parameter names ("pizza" = "bud"), or 404. */
export function resolveStore(raw: unknown): PizzaStore {
  const id = typeof raw === "string" ? STORE_ALIASES[raw] : undefined;
  if (!id) throw new HttpError(404, "NOT_FOUND", "Unknown store");
  return PIZZA_STORES[id];
}

export type ShopDeps = { issuer: Issuer; clock: Clock; log: ChargeLog };

/** One terminal charge at a pizza shop (default Budapest; also used by the Demo Stage's tap-to-pay terminal). */
export async function pizzaCheckout(deps: ShopDeps, body: z.infer<typeof CheckoutBody>, storeId: StoreId = "bud") {
  const store = PIZZA_STORES[storeId];
  const amountMinor = body.items ? priceItems(storeId, body.items) : body.amountMinor!;
  if (body.items && body.amountMinor !== undefined && body.amountMinor !== amountMinor) {
    throw new HttpError(400, "AMOUNT_MISMATCH", "amountMinor does not match the items total");
  }
  const result = await deps.issuer.authorize({
    cardId: body.cardId,
    amountMinor,
    currency: store.currency,
    merchant: {
      name: store.name,
      mcc: store.mcc,
      stripeCategory: store.stripeCategory,
      city: store.city,
      country: store.country,
    },
  });
  const at = (await deps.clock.now()).toISOString();
  deps.log.charges.push({ at, storeId, cardId: body.cardId, amountMinor, currency: store.currency, result });
  return {
    httpStatus: result.approved ? 200 : result.reasonCode === "ISSUER_UNAVAILABLE" ? 502 : 402,
    body: {
      status: result.approved ? ("approved" as const) : ("declined" as const),
      provider: result.provider,
      authorizationId: result.authorizationId,
      reasonCode: result.reasonCode,
      amountMinor,
      currency: store.currency,
      merchant: store.name,
      at,
      simulated: true as const,
    },
  };
}

export function shopRoutes(app: FastifyInstance, deps: ShopDeps): void {
  app.get("/shop/:store/menu", async (req) => {
    const store = resolveStore((req.params as { store?: unknown }).store);
    return {
      merchant: { ...store },
      currency: store.currency,
      items: PIZZA_MENUS[store.storeId].map((m) => ({ ...m, currency: store.currency })),
      simulated: true,
    };
  });

  app.post("/shop/:store/checkout", async (req, reply) => {
    const store = resolveStore((req.params as { store?: unknown }).store);
    const r = await pizzaCheckout(deps, parseWith(CheckoutBody, req.body), store.storeId);
    return reply.code(r.httpStatus).send(r.body);
  });

  app.get("/shop/:store/charges", async (req) => {
    const store = resolveStore((req.params as { store?: unknown }).store);
    return { charges: deps.log.charges.filter((c) => c.storeId === store.storeId), simulated: true };
  });

  app.get("/shop/:store", async (req, reply) => {
    const routeName = (req.params as { store?: unknown }).store as string;
    const store = resolveStore(routeName);
    const menu = PIZZA_MENUS[store.storeId];
    const rows = menu
      .map(
        (m) =>
          `<tr><td>${esc(m.name)}<div class="muted">${esc(m.description)}</div></td><td>${esc(formatMoney(m.priceMinor, store.currency))}</td><td class="mono">${esc(m.sku)}</td></tr>`,
      )
      .join("");
    const body = `
<h1>${esc(store.name)}</h1>
<p class="muted">Simulated restaurant. Generic name, no real brand. Card issuer: <b>${esc(deps.issuer.provider)}</b>.</p>
<div class="card"><h2>Menu</h2><table><thead><tr><th>Item</th><th>Price</th><th>SKU</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="card">
  <h2>Checkout: 2 x Margherita</h2>
  <label for="card">One-time card id (from the Kassa approval)</label>
  <input id="card" autocomplete="off" placeholder="ic_... or fake card id">
  <p><button id="pay">Charge card</button> <button id="again">Charge the same card again</button></p>
  <div id="out" class="mono" aria-live="polite"></div>
</div>`;
    // Relative to /mock/shop/<route name>: the alias page posts to its own alias.
    const checkoutPath = `./${encodeURIComponent(routeName)}/checkout`;
    const script = `
const out = document.getElementById('out');
async function charge() {
  const cardId = document.getElementById('card').value.trim();
  if (!cardId) { out.textContent = 'Enter a card id first.'; return; }
  const res = await fetch(${JSON.stringify(checkoutPath)}, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cardId, items: [{ sku: 'PZ-MARG', quantity: 2 }] }) });
  const j = await res.json();
  const line = document.createElement('div');
  line.className = 'status ' + (j.status === 'approved' ? 'ok' : 'bad');
  line.textContent = new Date().toLocaleTimeString() + '  ' + (j.status || 'error').toUpperCase() + (j.reasonCode ? ' (' + j.reasonCode + ')' : '');
  out.prepend(line);
}
document.getElementById('pay').onclick = charge;
document.getElementById('again').onclick = charge;`;
    return reply.type("text/html; charset=utf-8").send(page(store.name, body, { script }));
  });
}
