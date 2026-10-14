/* Wallet (wallet/service.ts): GET /wallet (Kassa ID, top-up limits), POST /wallet/top-ups (test money in). */
import { TopUpRequest, TopUpResponse, WalletResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { topUp, walletInfo } from "./service.ts";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get("/wallet", { schema: { response: { 200: WalletResponse } } }, async (req) => walletInfo(userIdOf(req)));

  app.post("/wallet/top-ups", { schema: { body: TopUpRequest, response: { 200: TopUpResponse } } }, async (req) => topUp(userIdOf(req), req.body));
};

export default routes;
