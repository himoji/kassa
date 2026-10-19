/*
 * Orders (spec §7 T2 flow, §8): GET /orders/:id → {canonicalOrder, orderHash, webauthnOptions(challenge =
 * orderHash), …}; approve with the passkey assertion; reject. Plus GET /proposals for pending sign-offs, and
 * GET /agent/activity: what the agent and the scheduler proposed lately and what became of it (the Home card).
 */
import {
  AgentActivityResponse,
  type AgentOutcome,
  ApproveOrderRequest,
  ApproveOrderResponse,
  ConvertRequest,
  OrderView,
  OWN_WALLET_PAYEE_NAME,
  PayPayeeResponse,
  ProposalsResponse,
  ProposalStatus,
  RejectOrderRequest,
} from "@kassa/shared";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { payees, proposals, users } from "../../db/schema.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { clock, DAY_MS } from "../clock/index.ts";
import { approveOrder, getOrderView, proposeConversion, rejectOrder } from "../rules/index.ts";

const Params = z.object({ proposalId: z.string().uuid() });

/** What became of a proposal, in the user's terms (AgentActivityResponse). */
export function agentOutcome(p: { decision: string; status: string }): AgentOutcome {
  if (p.status === "EXECUTED" || p.status === "APPROVED") return p.decision === "AUTO" ? "PAID_AUTO" : "PAID_APPROVED";
  if (p.status === "PENDING_APPROVAL") return "WAITING";
  if (p.status === "REFUSED") return "HELD";
  if (p.status === "REJECTED") return "DECLINED";
  return "OTHER";
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  // (2026-10-18) Convert between the user's own balances: a CONVERT order to sign with the passkey (always ASK).
  app.post("/conversions", { schema: { body: ConvertRequest, response: { 200: PayPayeeResponse } } }, async (req) => {
    const r = await proposeConversion({ userId: userIdOf(req), createdBy: "USER", toCurrency: req.body.toCurrency, amountMinor: req.body.amountMinor, fromCurrency: req.body.fromCurrency });
    return { proposalId: r.proposalId, decision: r.decision, reasonCodes: r.reasonCodes, summary: r.summary };
  });

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
    "/agent/activity",
    { schema: { querystring: z.object({ days: z.coerce.number().int().min(1).max(31).default(7) }), response: { 200: AgentActivityResponse } } },
    async (req) => {
      const userId = userIdOf(req);
      const since = new Date(clock.nowMs() - req.query.days * DAY_MS);
      const rows = await getDb()
        .select()
        .from(proposals)
        .where(and(eq(proposals.userId, userId), inArray(proposals.createdBy, ["AGENT", "SCHEDULER"]), gte(proposals.createdAt, since)))
        .orderBy(desc(proposals.createdAt))
        .limit(100);
      // A refused proposal has no canonical order: its payee's name comes from the payee register.
      const ids = [...new Set(rows.filter((p) => !p.canonicalOrder?.payeeName).map((p) => p.draft.payeeId).filter((id) => /^[0-9a-f-]{36}$/i.test(id ?? "")))];
      const names = new Map(
        ids.length ? (await getDb().select({ id: payees.id, name: payees.name }).from(payees).where(and(eq(payees.userId, userId), inArray(payees.id, ids)))).map((r) => [r.id, r.name]) : [],
      );
      const counts: Record<AgentOutcome, number> = { PAID_AUTO: 0, PAID_APPROVED: 0, WAITING: 0, HELD: 0, DECLINED: 0, OTHER: 0 };
      const items = rows.map((p) => {
        const outcome = agentOutcome(p);
        counts[outcome]++;
        return {
          proposalId: p.id,
          createdBy: p.createdBy as "AGENT" | "SCHEDULER",
          outcome,
          payeeName: p.canonicalOrder?.payeeName || (p.draft.rail === "CONVERT" ? OWN_WALLET_PAYEE_NAME : names.get(p.draft.payeeId)) || "",
          amountMinor: p.draft.amountMinor,
          currency: p.draft.currency,
          reasonCodes: p.reasonCodes,
          createdAt: p.createdAt.toISOString(),
        };
      });
      return { since: since.toISOString(), counts, items };
    },
  );

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
