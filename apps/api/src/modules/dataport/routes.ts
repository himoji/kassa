import { ImportCommitRequest, ImportCommitResponse, ImportPreviewRequest, ImportPreviewResponse, KassaExport } from "@kassa/shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { getDb } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
import { HttpProblem } from "../../http/problem.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { ImportFormatError, mapImport } from "./mapper.ts";
import { commitImport, exportData } from "./service.ts";

/** GET /export, POST /import/preview, POST /import/commit (dataport/service.ts, mapper.ts). */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get("/export", { schema: { response: { 200: KassaExport } } }, async (req, reply) => {
    const data = await exportData(userIdOf(req));
    void reply.header("content-disposition", `attachment; filename="kassa-export-${data.exportedAt.slice(0, 10)}.json"`);
    return data;
  });

  app.post("/import/preview", { schema: { body: ImportPreviewRequest, response: { 200: ImportPreviewResponse } } }, async (req) => {
    const u = (await getDb().select({ homeCurrency: users.homeCurrency }).from(users).where(eq(users.id, userIdOf(req))))[0];
    try {
      return mapImport(req.body.text, u?.homeCurrency ?? "EUR");
    } catch (e) {
      if (e instanceof ImportFormatError) throw new HttpProblem(422, "IMPORT_UNREADABLE", e.message);
      throw e;
    }
  });

  app.post("/import/commit", { schema: { body: ImportCommitRequest, response: { 200: ImportCommitResponse } } }, async (req) =>
    commitImport(userIdOf(req), req.body.items),
  );
};

export default routes;
