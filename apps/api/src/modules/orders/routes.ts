/*
 * Orders (spec §7 T2 flow, §8): GET /orders/:id → {canonicalOrder, orderHash, webauthnOptions(challenge =
 * orderHash), …}; approve with the passkey assertion; reject. Plus GET /proposals for pending sign-offs.
 */
import {
  ApproveOrderRequest,
  ApproveOrderResponse,
  OrderView,
  ProposalsResponse,
  ProposalStatus,
  RejectOrderRequest,
} from "@kassa/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { proposals, users } from "../../db/schema.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { approveOrder, getOrderView, rejectOrder } from "../rules/index.ts";

const Params = z.object({ proposalId: z.string().uuid() });

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get("/orders/:proposalId", { schema: { params: Params, response: { 200: OrderView } } }, async (req) =>
    getOrderView(userIdOf(req), req.params.proposalId),
  );

  app.post(
    "/orders/:proposalId/approve",
    { schema: { params: Params, body: ApproveOrderRequest, response: { 200: ApproveOrderResponse } } },
    async (req) => approveOrder(userIdOf(req), req.params.proposalId, req.body.assertion),
  );

  app.post("/orders/:proposalId/reject", { schema: { params: Params, body: RejectOrderRequest.optional() } }, async (req, reply) => {
    await rejectOrder(userIdOf(req), req.params.proposalId, req.body?.reason);
    return reply.status(204).send();
  });

  app.get(
    "/proposals",
    {
      schema: {
        querystring: z.object({ status: ProposalStatus.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: ProposalsResponse },
      },
    },
    async (req) => {
      const userId = userIdOf(req);
      const db = getDb();
      const u = (await db.select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userId)))[0];
      const rows = await db
        .select()
        .from(proposals)
        .where(req.query.status ? and(eq(proposals.userId, userId), eq(proposals.status, req.query.status)) : eq(proposals.userId, userId))
        .orderBy(desc(proposals.createdAt))
        .limit(req.query.limit);
      return {
        proposals: rows.map((p) => ({
          proposalId: p.id,
          createdBy: p.createdBy,
          decision: p.decision,
          reasonCodes: p.reasonCodes,
          riskScore: p.riskScore,
          status: p.status,
          payeeName: p.canonicalOrder?.payeeName ?? "",
          amountMinor: p.draft.amountMinor,
          currency: p.draft.currency,
          homeAmountMinor: p.canonicalOrder?.homeAmountMinor ?? 0,
          homeCurrency: p.canonicalOrder?.homeCurrency ?? u?.homeCurrency ?? "KZT",
          createdAt: p.createdAt.toISOString(),
        })),
      };
    },
  );
};

export default routes;
