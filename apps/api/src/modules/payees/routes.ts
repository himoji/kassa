import { CreatePayeeRequest, PasskeyGatedRequest, PayeeDto, PayeesResponse, PayPayeeRequest, PayPayeeResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { createPayee, listPayees, payPayee, toPayeeDto, verifyCallback } from "./service.ts";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get("/payees", { schema: { response: { 200: PayeesResponse } } }, async (req) => {
    const rows = await listPayees(userIdOf(req));
    return { payees: rows.map(toPayeeDto) };
  });

  app.post("/payees", { schema: { body: CreatePayeeRequest, response: { 201: PayeeDto } } }, async (req, reply) => {
    const p = await createPayee(userIdOf(req), req.body);
    return reply.status(201).send(toPayeeDto(p));
  });

  app.post(
    "/payees/:id/verify-callback",
    // X3: passkey-gated (428 PASSKEY_REQUIRED round trip, body PasskeyGatedRequest).
    { schema: { params: z.object({ id: z.string().uuid() }), body: PasskeyGatedRequest.nullish(), response: { 200: PayeeDto } } },
    async (req) => toPayeeDto(await verifyCallback(userIdOf(req), req.params.id, req.body ?? {})),
  );

  // The user pays a payee themselves: the same rules as an agent draft, then the order screen and the passkey.
  app.post(
    "/payees/:id/pay",
    { schema: { params: z.object({ id: z.string().uuid() }), body: PayPayeeRequest, response: { 200: PayPayeeResponse } } },
    async (req) => payPayee(userIdOf(req), req.params.id, req.body),
  );
};

export default routes;
