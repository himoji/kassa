/* Identity check (KYC), sandbox (kyc/service.ts): GET /kyc (standing + threshold), POST /kyc/start (run a check). */
import { KycCheckDto, KycStartRequest, KycStatusResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { kycView, startCheck } from "./service.ts";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get("/kyc", { schema: { response: { 200: KycStatusResponse } } }, async (req) => kycView(userIdOf(req)));

  app.post("/kyc/start", { schema: { body: KycStartRequest, response: { 201: KycCheckDto } } }, async (req, reply) =>
    reply.code(201).send(await startCheck(userIdOf(req), req.body)),
  );
};

export default routes;
