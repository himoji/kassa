import multipart from "@fastify/multipart";
import { ImportCommitRequest, ImportCommitResponse, ImportPreviewRequest, ImportPreviewResponse, KassaExport, MoneyHistoryResponse } from "@kassa/shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { getDb } from "../../db/client.ts";
import { profiles, users } from "../../db/schema.ts";
import { HttpProblem } from "../../http/problem.ts";
import { isAiConfigError } from "../ai/errors.ts";
import { currentAgentMode } from "../ai/mode.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { rememberedCategory } from "../capture/service.ts";
import { clock, isoDate } from "../clock/index.ts";
import { aiProcessingAllowedFor } from "../privacy/notice.ts";
import { MAX_IMPORT_FILE_BYTES } from "./files.ts";
import { ImportFormatError } from "./mapper.ts";
import { previewImport, previewText, type ImportFileInput, type PreviewOptions } from "./read.ts";
import { commitImport, exportData } from "./service.ts";

/** Files per upload (a student's banks: a few statements at once). */
const MAX_IMPORT_FILES = 6;

/** GET /export, GET /history, POST /import/preview (pasted text), POST /import/file (multipart files), POST /import/commit (read.ts, service.ts). */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);
  await app.register(multipart, { limits: { fileSize: MAX_IMPORT_FILE_BYTES, files: MAX_IMPORT_FILES, fields: 4, fieldSize: 64 } });

  // The stored history for the Home card (computed in code at import time; a missing column reads as none).
  app.get("/history", { schema: { response: { 200: MoneyHistoryResponse } } }, async (req) => {
    const row = await getDb()
      .select({ h: profiles.moneyHistory })
      .from(profiles)
      .where(eq(profiles.userId, userIdOf(req)))
      .catch(() => []);
    return { history: row[0]?.h ?? null };
  });

  app.get("/export", { schema: { response: { 200: KassaExport } } }, async (req, reply) => {
    const data = await exportData(userIdOf(req));
    void reply.header("content-disposition", `attachment; filename="kassa-export-${data.exportedAt.slice(0, 10)}.json"`);
    return data;
  });

  /** Options for one preview: the user's currency and name, AI consent, and the AI mode (REPLAY never calls a model). */
  async function options(userId: string, ai: PreviewOptions["ai"]): Promise<PreviewOptions> {
    const db = getDb();
    const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
    if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
    const replay = (await currentAgentMode()) === "REPLAY";
    return {
      homeCurrency: u.homeCurrency,
      profileName: u.displayName,
      ai: replay ? "off" : ai,
      aiAllowed: aiProcessingAllowedFor(u),
      today: isoDate(clock.now()),
      rememberedCategory: (merchantNorm) => rememberedCategory(db, userId, merchantNorm),
    };
  }

  async function run<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ImportFormatError) throw new HttpProblem(422, "IMPORT_UNREADABLE", e.message);
      if (isAiConfigError(e)) throw new HttpProblem(503, e.code, "Kassa could not reach its AI reader. Try again, or import the bank's CSV or Excel export.");
      throw e;
    }
  }

  app.post("/import/preview", { schema: { body: ImportPreviewRequest, response: { 200: ImportPreviewResponse } } }, async (req) =>
    run(async () => previewText(req.body.text, await options(userIdOf(req), "auto"))),
  );

  app.post("/import/file", { schema: { response: { 200: ImportPreviewResponse } } }, async (req) => {
    if (!req.isMultipart()) throw new HttpProblem(415, "MULTIPART_REQUIRED", "Upload the statements as multipart/form-data (field 'file', one or more)");
    const files: ImportFileInput[] = [];
    let ai: PreviewOptions["ai"] = "auto";
    try {
      await readParts();
    } catch (e) {
      if (e instanceof HttpProblem) throw e;
      throw new HttpProblem(400, "MULTIPART_INVALID", "The upload could not be read; choose the files again");
    }
    async function readParts() {
    for await (const part of req.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "ai" && (part.value === "off" || part.value === "always" || part.value === "auto")) ai = part.value;
        continue;
      }
      let data: Buffer;
      try {
        data = await part.toBuffer();
      } catch {
        throw new HttpProblem(413, "IMPORT_TOO_LARGE", "Each file can be up to 10 MB");
      }
      if (data.byteLength === 0) continue;
      files.push({ name: part.filename || `file ${files.length + 1}`, data: new Uint8Array(data) });
    }
    }
    if (files.length === 0) throw new HttpProblem(400, "FILE_REQUIRED", "Choose at least one file");
    return run(async () => previewImport(files, await options(userIdOf(req), ai)));
  });

  app.post("/import/commit", { schema: { body: ImportCommitRequest, response: { 200: ImportCommitResponse } } }, async (req) =>
    commitImport(userIdOf(req), req.body.items, req.body.history),
  );
};

export default routes;
