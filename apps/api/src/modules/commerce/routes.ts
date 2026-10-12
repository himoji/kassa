/*
 * (added 2026-10-14, Business M2/M3) Shop orders and till bills, the customer's side:
 *   GET  /shop-orders[?proposalId=]        the user's shop orders (newest first), with the shop's status timeline
 *   GET  /shop-orders/:id                  one (BOLA: another user's order is a 404, audited)
 *   GET  /merchant-bills/:billId           the till bill as the merchant reports it (for the /pay screen)
 *   POST /merchant-bills/:billId/propose   propose paying exactly that bill (amount and merchant from the till)
 * The shop's status webhook is POST /webhooks/mock/shop (webhooks/routes.ts, HMAC).
 */
import { MerchantBillProposeResponse, MerchantBillView, ShopOrdersResponse, ShopOrderView } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { BILL_ID, fetchBill, proposeBill } from "./bills.ts";
import { getShopOrder, listShopOrders } from "./service.ts";

const BillParams = z.object({ billId: z.string().regex(BILL_ID) });

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get(
    "/shop-orders",
    {
      schema: {
        querystring: z.object({ proposalId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }),
        response: { 200: ShopOrdersResponse },
      },
    },
    async (req) => ({ shopOrders: await listShopOrders(userIdOf(req), { ...(req.query.proposalId ? { proposalId: req.query.proposalId } : {}), limit: req.query.limit }) }),
  );

  app.get("/shop-orders/:id", { schema: { params: z.object({ id: z.string().uuid() }), response: { 200: ShopOrderView } } }, async (req) =>
    getShopOrder(userIdOf(req), req.params.id),
  );

  app.get("/merchant-bills/:billId", { schema: { params: BillParams, response: { 200: MerchantBillView } } }, async (req) => fetchBill(req.params.billId));

  // The body carries nothing: amount, currency, items and merchant are fetched from the till (unknown keys are dropped).
  app.post("/merchant-bills/:billId/propose", { schema: { params: BillParams, body: z.object({}).nullish(), response: { 200: MerchantBillProposeResponse } } }, async (req) =>
    proposeBill(userIdOf(req), req.params.billId),
  );
};

export default routes;
