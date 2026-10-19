import { createHash, timingSafeEqual } from "node:crypto";

import { DEMO_TOKEN_HEADER, MOCK_REQUEST_AUTH_HEADER, verifyMockRequestAuth } from "@kassa/shared";
import type { FastifyRequest } from "fastify";

import type { MockWorldConfig } from "./config.ts";
import { HttpError } from "./errors.ts";

/*
 * (added 2026-10-18, security review) Who may call the mock world's control routes on a deployed build
 * (config.locked: NODE_ENV=production, JUDGE_MODE or VERCEL). The mock world plays the bank for every Kassa user and
 * the API reads balances from it, so a route that moves money in a profile, opens a wallet, wipes the world or lists
 * the signed webhooks must not be anonymous:
 *
 *   "kassa"  the Kassa API itself (X-Kassa-Request-Auth: HMAC over method, path and body with MOCK_HMAC_SECRET,
 *            5-minute window, @kassa/shared mockRequestAuth) or the operator (x-kassa-demo-token = DEMO_ADMIN_TOKEN).
 *            A user reaches these only through an authenticated API route that picks the user's own bank profile
 *            from the session (wallet top-ups, payments, KYC, shop orders).
 *   "admin"  the operator only: the webhook outbox (every signed delivery, profile ids included), the global QR
 *            attack switch and (2026-10-19) the screens that show or move every customer's orders: the kitchen's
 *            order list and its "advance" button, and the supplier portals' purchase orders, invoices and attack button.
 *            Their pages still load; on a locked build they ask for the operator key (html.ts operatorFetch).
 *
 * Everything else stays public on purpose: pages and catalogs, the shop's checkout page (charges a one-time card id
 * only its holder has; the issuer allows one charge for the signed amount), the till (it creates its own bills and
 * polls the one it shows; bill ids are random and listed nowhere), school portals, and the QR wallet page with its Pay
 * button, whose payment id (a random UUID) only the paying user is given (a capability link, docs/SECURITY.md). The
 * Stage has its own gate (routes/stage.ts). Local development (not locked) leaves every route open for the sim and curl.
 */

export type Access = "kassa" | "admin";

/** Locked routes by Fastify route pattern (with the /mock prefix). Anything not listed is public. */
export const ROUTE_ACCESS: Readonly<Record<string, Access>> = {
  // World control
  "POST /mock/reset": "kassa",
  "GET /mock/outbox": "admin",
  // Mock bank (Wise-shaped) and Kassa's wallet helpers
  "POST /mock/v3/profiles/:p/quotes": "kassa",
  "GET /mock/v3/profiles/:p/quotes/:id": "kassa",
  "POST /mock/v1/accounts": "kassa",
  "GET /mock/v1/accounts/:id": "kassa",
  "POST /mock/v1/transfers": "kassa",
  "GET /mock/v1/transfers/:id": "kassa",
  "POST /mock/v3/profiles/:p/transfers/:id/payments": "kassa",
  // (2026-10-18) conversion between a wallet's own balances (the API's CONVERT rail)
  "POST /mock/v2/profiles/:p/balance-movements": "kassa",
  "GET /mock/v4/profiles/:p/balances": "kassa",
  "POST /mock/bank/wallets": "kassa",
  "POST /mock/bank/top-ups": "kassa",
  // (2026-10-19) one-time card charges paid from the wallet (Kassa's issuer, on approval)
  "POST /mock/bank/card-debits": "kassa",
  "GET /mock/bank/transfers": "kassa",
  "POST /mock/bank/tick": "kassa",
  // Event emitters (money from home, POS stock levels)
  "POST /mock/remittance/incoming": "kassa",
  "POST /mock/pos/emit": "kassa",
  // QR wallet: codes are created by the API for a signed handoff; the attack switch changes every new code
  "POST /mock/qr/payments": "kassa",
  "POST /mock/qr/attack/swap": "admin",
  // Identity checks carry the account holder's name
  "POST /mock/kyc/checks": "kassa",
  "GET /mock/kyc/checks/:id": "kassa",
  // Shop: orders and bill payments are made by Kassa with a one-time card; the charge log lists card ids
  "POST /mock/shop/:store/orders": "kassa",
  "POST /mock/shop/:store/bills/:billId/pay": "kassa",
  "POST /mock/shop/:store/bills/:billId/qr": "kassa",
  "POST /mock/shop/:store/bills/:billId/decline": "kassa",
  "GET /mock/shop/:store/charges": "kassa",
  // (2026-10-19) One order by id (delivery address included): only Kassa asks for it.
  "GET /mock/shop/:store/orders/:orderId": "kassa",
  // (2026-10-19) Every customer's orders and suppliers' purchase orders: operator screens on a deployed build.
  "GET /mock/shop/:store/orders": "admin",
  "POST /mock/shop/:store/orders/:orderId/advance": "admin",
  "GET /mock/supplier/:id/purchase-orders": "admin",
  "POST /mock/supplier/:id/purchase-orders/:po/confirm": "admin",
  "POST /mock/supplier/:id/purchase-orders/:po/deliver": "admin",
  "POST /mock/supplier/:id/purchase-orders/:po/invoice": "admin",
  "POST /mock/supplier/:id/attack/swapped-invoice": "admin",
  "GET /mock/supplier/:id/invoices/:invoiceId/invoice.pdf": "admin",
};

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time token check (both sides hashed to 32 bytes first), as the API's demo admin check. */
export function adminTokenMatches(got: unknown, expected: string | null): boolean {
  if (!expected) return false;
  return timingSafeEqual(digest(typeof got === "string" ? got : ""), digest(expected));
}

/** The JSON text the API signed: it sends JSON.stringify(payload), which parses and re-serialises to the same text. */
function bodyText(req: FastifyRequest): string {
  return req.body === undefined ? "" : JSON.stringify(req.body);
}

export function kassaSigned(req: FastifyRequest, config: MockWorldConfig, nowSeconds: number): boolean {
  const h = req.headers[MOCK_REQUEST_AUTH_HEADER];
  return verifyMockRequestAuth(config.hmacSecret, typeof h === "string" ? h : undefined, req.method, req.url, bodyText(req), nowSeconds);
}

/** preHandler (after body parsing): refuses a locked route without the right credential. */
export function accessGuard(config: MockWorldConfig, realNowMs: () => number = Date.now) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!config.locked) return;
    const pattern = req.routeOptions.url;
    if (!pattern) return;
    const access = ROUTE_ACCESS[`${req.method} ${pattern}`];
    if (!access) return;
    if (adminTokenMatches(req.headers[DEMO_TOKEN_HEADER], config.demoAdminToken)) return;
    if (access === "kassa" && kassaSigned(req, config, Math.floor(realNowMs() / 1000))) return;
    throw new HttpError(
      401,
      access === "admin" ? "ADMIN_TOKEN_REQUIRED" : "KASSA_AUTH_REQUIRED",
      access === "admin" ? "This mock-world route needs the demo admin token" : "This mock-world route only answers the Kassa API (signed request) or the demo admin token",
    );
  };
}
