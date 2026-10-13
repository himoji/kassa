import { BudgetsResponse, BudgetsSetRequest, BudgetsSetResponse, CardFeesResponse, ForecastResponse, PlanAdviceRequest, PlanAdviceResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { forecastCoverage } from "../fx/index.ts";
import { cardFees } from "./fees.ts";
import { planAdvice } from "./plan.ts";
import { listBudgets } from "./service.ts";
import { setBudgets } from "./set.ts";

/** B-owned money endpoints (PHASE1_COORDINATION): GET /budgets, PUT /budgets (set.ts), POST /plan/advice (plan.ts), GET /forecast, GET /cards/fees. */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get(
    "/budgets",
    { schema: { querystring: z.object({ category: z.string().min(1).max(64).optional() }), response: { 200: BudgetsResponse } } },
    async (req) => listBudgets(userIdOf(req), req.query.category),
  );

  app.put("/budgets", { schema: { body: BudgetsSetRequest, response: { 200: BudgetsSetResponse } } }, async (req) => setBudgets(userIdOf(req), req.body));

  app.post("/plan/advice", { schema: { body: PlanAdviceRequest, response: { 200: PlanAdviceResponse } } }, async (req) => planAdvice(userIdOf(req), req.body));

  app.get("/forecast", { schema: { response: { 200: ForecastResponse } } }, async (req) => forecastCoverage(userIdOf(req)));

  app.get("/cards/fees", { schema: { response: { 200: CardFeesResponse } } }, async (req) => cardFees(userIdOf(req)));
};

export default routes;
