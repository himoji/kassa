import { CreateMandateRequest, MandateDto, MandateOptionsRequest, MandateOptionsResponse, MandatesResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { createMandate, listMandates, mandateOptions, revokeMandate, toMandateDto } from "./service.ts";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get("/mandates", { schema: { response: { 200: MandatesResponse } } }, async (req) => {
    const rows = await listMandates(userIdOf(req));
    return { mandates: await Promise.all(rows.map(toMandateDto)) };
  });

  app.post("/mandates/options", { schema: { body: MandateOptionsRequest, response: { 200: MandateOptionsResponse } } }, async (req) =>
    mandateOptions(userIdOf(req), req.body),
  );

  app.post("/mandates", { schema: { body: CreateMandateRequest, response: { 201: MandateDto } } }, async (req, reply) => {
    const m = await createMandate(userIdOf(req), req.body.core, req.body.assertion);
    return reply.status(201).send(await toMandateDto(m));
  });

  app.post(
    "/mandates/:id/revoke",
    { schema: { params: z.object({ id: z.string().uuid() }), response: { 200: MandateDto } } },
    async (req) => toMandateDto(await revokeMandate(userIdOf(req), req.params.id)),
  );
};

export default routes;
