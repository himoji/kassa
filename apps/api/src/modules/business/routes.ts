/*
 * (added 2026-10-14, Business M4) Kassa Business read API (contracts: @kassa/shared businessDto.ts):
 * GET /business/inventory, GET /business/forecast, GET /business/sales/today, GET /business/purchase-orders.
 * Owner-only: the session user must be a BUSINESS account (else 403 BUSINESS_ACCOUNT_REQUIRED) and the data is
 * always that owner's own merchant (no merchant id in the URL, so there is nothing to enumerate).
 * (M5) GET /business/purchase-orders/:id; POST .../:id/sign/options, .../:id/sign (payments passkey, business/sign.ts),
 * .../:id/send (retry delivery to the supplier). A PO id of another merchant is 404.
 */
import {
  BusinessForecastResponse,
  BusinessInventoryResponse,
  BusinessPurchaseOrdersResponse,
  BusinessSalesTodayResponse,
  PurchaseOrderDto,
  PurchaseOrderSignOptionsResponse,
  PurchaseOrderSignRequest,
} from "@kassa/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { payees, purchaseOrders, salesDaily, users } from "../../db/schema.ts";
import { notFound, HttpProblem } from "../../http/problem.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { clock } from "../clock/index.ts";
import { localDay } from "./forecast.ts";
import { loadForecast } from "./forecastData.ts";
import { type MerchantRow, merchantOfOwner } from "./queries.ts";
import { resendPurchaseOrder, signOptions, signPurchaseOrder } from "./sign.ts";

/** The session user's merchant; 403 for a PERSONAL account, 404 for a BUSINESS account without one. */
export async function ownMerchant(userId: string): Promise<MerchantRow> {
  const user = (await getDb().select({ accountType: users.accountType }).from(users).where(eq(users.id, userId)))[0];
  if (user?.accountType !== "BUSINESS") throw new HttpProblem(403, "BUSINESS_ACCOUNT_REQUIRED", "This is a Kassa Business feature");
  const merchant = await merchantOfOwner(userId);
  if (!merchant) throw notFound("Merchant");
  return merchant;
}

const merchantDto = (m: MerchantRow) => ({ id: m.id, slug: m.slug, name: m.name, currency: m.currency, timezone: m.timezone });

type PoJoin = { po: typeof purchaseOrders.$inferSelect; supplierName: string };
const poDto = ({ po, supplierName }: PoJoin) => ({
  id: po.id,
  status: po.status,
  createdBy: po.createdBy,
  supplierPayeeId: po.supplierPayeeId,
  supplierName,
  currency: po.currency,
  lines: po.lines,
  totalMinor: po.totalMinor,
  reasonCodes: po.reasonCodes,
  createdAt: po.createdAt.toISOString(),
  signedAt: po.signedAt?.toISOString() ?? null,
  poHash: po.poHash,
  timeline: po.timeline,
  invoice: po.invoice ? { invoiceId: po.invoice.invoiceId, amountMinor: po.invoice.amountMinor, currency: po.invoice.currency, issuedAt: po.invoice.issuedAt } : null,
  proposalId: po.proposalId,
});
const IdParams = z.object({ id: z.string().uuid() });
const NoBody = z.object({}).optional();
const SignResult = z.object({ id: z.string().uuid(), status: z.enum(["SIGNED", "SENT"]), poHash: z.string().nullable() });

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get("/business/forecast", { schema: { response: { 200: BusinessForecastResponse } } }, async (req) => {
    const merchant = await ownMerchant(userIdOf(req));
    const f = await loadForecast(merchant, clock.now());
    return { merchant: merchantDto(merchant), today: f.today, tomorrow: f.tomorrow, generatedAt: f.generatedAt, lines: f.lines, shortages: f.shortages };
  });

  app.get("/business/inventory", { schema: { response: { 200: BusinessInventoryResponse } } }, async (req) => {
    const merchant = await ownMerchant(userIdOf(req));
    const f = await loadForecast(merchant, clock.now());
    return {
      merchant: merchantDto(merchant),
      items: f.lines.map((l) => ({ sku: l.sku, name: l.name, unit: l.unit, onHand: l.onHand, need: l.need, safety: l.safety, incoming: l.incoming, shortage: l.shortage })),
    };
  });

  app.get("/business/sales/today", { schema: { response: { 200: BusinessSalesTodayResponse } } }, async (req) => {
    const merchant = await ownMerchant(userIdOf(req));
    const day = localDay(clock.now(), merchant.timezone);
    const rows = await getDb()
      .select({ menuSku: salesDaily.menuSku, qty: salesDaily.qty, revenueMinor: salesDaily.revenueMinor })
      .from(salesDaily)
      .where(and(eq(salesDaily.merchantId, merchant.id), eq(salesDaily.day, day)))
      .orderBy(salesDaily.menuSku);
    return {
      merchant: merchantDto(merchant),
      day,
      totalUnits: rows.reduce((s, r) => s + r.qty, 0),
      revenueMinor: rows.reduce((s, r) => s + r.revenueMinor, 0),
      items: rows,
    };
  });

  app.get("/business/purchase-orders", { schema: { response: { 200: BusinessPurchaseOrdersResponse } } }, async (req) => {
    const merchant = await ownMerchant(userIdOf(req));
    const rows = await getDb()
      .select({ po: purchaseOrders, supplierName: payees.name })
      .from(purchaseOrders)
      .innerJoin(payees, eq(payees.id, purchaseOrders.supplierPayeeId))
      .where(eq(purchaseOrders.merchantId, merchant.id))
      .orderBy(desc(purchaseOrders.createdAt))
      .limit(100);
    return {
      merchant: merchantDto(merchant),
      items: rows.map(poDto),
    };
  });

  app.get("/business/purchase-orders/:id", { schema: { params: IdParams, response: { 200: PurchaseOrderDto } } }, async (req) => {
    const merchant = await ownMerchant(userIdOf(req));
    const row = (
      await getDb()
        .select({ po: purchaseOrders, supplierName: payees.name })
        .from(purchaseOrders)
        .innerJoin(payees, eq(payees.id, purchaseOrders.supplierPayeeId))
        .where(and(eq(purchaseOrders.id, req.params.id), eq(purchaseOrders.merchantId, merchant.id)))
    )[0];
    if (!row) throw notFound("Purchase order");
    return poDto(row);
  });

  app.post("/business/purchase-orders/:id/sign/options", { schema: { params: IdParams, body: NoBody, response: { 200: PurchaseOrderSignOptionsResponse } } }, async (req) =>
    signOptions(await ownMerchant(userIdOf(req)), req.params.id),
  );

  app.post("/business/purchase-orders/:id/sign", { schema: { params: IdParams, body: PurchaseOrderSignRequest, response: { 200: SignResult } } }, async (req) =>
    signPurchaseOrder(await ownMerchant(userIdOf(req)), req.params.id, req.body.core, req.body.assertion),
  );

  app.post("/business/purchase-orders/:id/send", { schema: { params: IdParams, body: NoBody, response: { 200: SignResult } } }, async (req) =>
    resendPurchaseOrder(await ownMerchant(userIdOf(req)), req.params.id),
  );
};

export default routes;
