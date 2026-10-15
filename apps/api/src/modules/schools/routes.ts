import { SchoolLinkResponse, SchoolLookupResponse, SchoolsResponse, SchoolStudentRequest } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { linkSchool, listSchools, lookup, refreshInvoices } from "./service.ts";

const SchoolId = z.object({ id: z.string().regex(/^[a-z0-9-]{2,40}$/) });

/** "Find your school": the directory, a student's invoices, and adding the school as a recipient with its bills. */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get("/schools", { schema: { querystring: z.object({ q: z.string().max(60).optional() }), response: { 200: SchoolsResponse } } }, async (req) => ({
    schools: await listSchools(req.query.q ?? ""),
  }));

  app.post("/schools/:id/lookup", { schema: { params: SchoolId, body: SchoolStudentRequest, response: { 200: SchoolLookupResponse } } }, async (req) =>
    lookup(userIdOf(req), req.params.id, req.body.studentId),
  );

  app.post("/schools/:id/link", { schema: { params: SchoolId, body: SchoolStudentRequest, response: { 200: SchoolLinkResponse } } }, async (req) =>
    linkSchool(userIdOf(req), req.params.id, req.body.studentId),
  );

  app.post("/payees/:id/school-invoices", { schema: { params: z.object({ id: z.string().uuid() }), response: { 200: SchoolLinkResponse } } }, async (req) =>
    refreshInvoices(userIdOf(req), req.params.id),
  );
};

export default routes;
