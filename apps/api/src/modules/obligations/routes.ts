import { CreateObligationRequest } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { createObligation, deleteObligation } from "./service.ts";

// GET /obligations (with coverage and mandates) lives in money/routes.ts; these are the user's own writes.
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.post(
    "/obligations",
    { schema: { body: CreateObligationRequest, response: { 201: z.object({ id: z.string().uuid() }) } } },
    async (req, reply) => reply.status(201).send({ id: (await createObligation(userIdOf(req), req.body)).id }),
  );

  app.delete("/obligations/:id", { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    await deleteObligation(userIdOf(req), req.params.id);
    return reply.status(204).send();
  });
};

export default routes;
