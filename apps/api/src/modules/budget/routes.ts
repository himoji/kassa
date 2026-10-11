import { BudgetsResponse, CardFeesResponse, ForecastResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { forecastCoverage } from "../fx/index.ts";
import { cardFees } from "./fees.ts";
import { listBudgets } from "./service.ts";

/** B-owned money endpoints (PHASE1_COORDINATION): GET /budgets, GET /forecast, GET /cards/fees. */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get(
    "/budgets",
    { schema: { querystring: z.object({ category: z.string().min(1).max(64).optional() }), response: { 200: BudgetsResponse } } },
    async (req) => listBudgets(userIdOf(req), req.query.category),
  );

  app.get("/forecast", { schema: { response: { 200: ForecastResponse } } }, async (req) => forecastCoverage(userIdOf(req)));

  app.get("/cards/fees", { schema: { response: { 200: CardFeesResponse } } }, async (req) => cardFees(userIdOf(req)));
};

export default routes;
