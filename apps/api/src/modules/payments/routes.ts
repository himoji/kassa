/*
 * Payment-side app routes (appDto contract): pay-in-place PaymentIntent secret, handoff view, and the
 * simulated confirmation used when Stripe keys are absent.
 */
import { HandoffView, PayInPlaceIntentResponse } from "@kassa/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { payments } from "../../db/schema.ts";
import { HttpProblem, notFound } from "../../http/problem.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { intentClientSecret, onIntentSucceeded } from "../rails/payInPlace.ts";

const Params = z.object({ paymentId: z.string().uuid() });

async function ownPayment(userId: string, paymentId: string) {
  const p = (await getDb().select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.userId, userId))))[0];
  if (!p) throw notFound("payment");
  return p;
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.post("/payments/:paymentId/intent", { schema: { params: Params, response: { 200: PayInPlaceIntentResponse } } }, async (req) => {
    const p = await ownPayment(userIdOf(req), req.params.paymentId);
    if (p.rail !== "PAY_IN_PLACE") throw new HttpProblem(409, "WRONG_RAIL", "Not a pay-in-place payment");
    if (p.status !== "CREATED") throw new HttpProblem(409, "NOT_PENDING", `Payment is ${p.status}`);
    const { clientSecret, publishableKey } = await intentClientSecret(p.details);
    return { paymentId: p.id, clientSecret, publishableKey, amountMinor: p.amountMinor, currency: p.currency };
  });

  /** Simulated payment_intent.succeeded for fake intents (no Stripe keys). Real intents use the webhook. */
  app.post("/payments/:paymentId/intent/simulate-success", { schema: { params: Params } }, async (req) => {
    const p = await ownPayment(userIdOf(req), req.params.paymentId);
    if (p.details.provider !== "fake" || typeof p.railRef !== "string") {
      throw new HttpProblem(409, "NOT_SIMULATED", "Only simulated intents can be confirmed here");
    }
    return { ok: await onIntentSucceeded(p.railRef) };
  });

  app.get("/handoff/:paymentId", { schema: { params: Params, response: { 200: HandoffView } } }, async (req) => {
    const p = await ownPayment(userIdOf(req), req.params.paymentId);
    if (p.rail !== "HANDOFF") throw new HttpProblem(409, "WRONG_RAIL", "Not a handoff payment");
    const d = p.details as Record<string, unknown>;
    if (typeof d.qrPayeeName !== "string") throw new HttpProblem(409, "RAIL_ERROR", "No QR request for this payment", { reasonCodes: ["RAIL_ERROR"] });
    return {
      paymentId: p.id,
      proposalId: p.proposalId,
      qrPayeeName: d.qrPayeeName,
      verifiedPayeeName: String(d.verifiedPayeeName ?? ""),
      nameSimilarity: Number(d.nameSimilarity ?? 0),
      check: d.check === "MATCH" ? ("MATCH" as const) : ("QR_PAYEE_MISMATCH" as const),
      reasonCodes: p.reasonCodes,
      amountMinor: p.amountMinor,
      currency: p.currency,
      qrPayload: String(d.qrPayload ?? ""),
      walletUrl: typeof d.walletUrl === "string" ? d.walletUrl : null,
      simulated: true as const,
    };
  });
};

export default routes;
