import multipart from "@fastify/multipart";
import { AgentMessageRequest, ReaderDocType, UploadDocumentResponse } from "@kassa/shared";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { ownedNotFound } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { isAiConfigError } from "../ai/errors.ts";
import { currentAgentMode, recordingEnabled } from "../ai/mode.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { requireAiConsent } from "../privacy/notice.ts";
import { DocumentError, MAX_DOCUMENT_BYTES, storeDocument } from "../reader/index.ts";
import { conversationOwner } from "./history.ts";
import { startTurn } from "./loop.ts";
import { dbPorts } from "./ports.ts";
import { dbTurnStore } from "./store.ts";

/*
 * POST /agent/message → AI SDK v7 UI message stream (text + data-proposal / data-routes /
 * data-budget-impact cards, metadata {replay}). POST /agent/documents (multipart) → {docId}.
 */

const MessageBody = AgentMessageRequest.extend({
  /** Demo / replay scenario name (fixtures/agent-recordings/<scenario>.json). Optional. */
  scenario: z.string().regex(/^[a-z0-9-]{1,48}$/).optional(),
});

const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(multipart, { limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 5, fieldSize: 1024 } });
  app.addHook("preHandler", requireUser);
  // GDPR Art. 6(1)(a)/7 consent + Art. 18 restriction, EU AI Act Art. 50 notice (privacy/notice.ts).
  app.addHook("preHandler", requireAiConsent);

  app.post("/agent/message", { schema: { body: MessageBody } }, async (req, reply) => {
    const userId = userIdOf(req);
    const { conversationId, text, scenario } = req.body;
    const owner = await conversationOwner(conversationId);
    // BOLA (OWASP API1): someone else's conversation answers like a missing one; the probe is audited.
    if (owner && owner !== userId) throw await ownedNotFound(userId, "conversation", conversationId, async () => true);
    const mode = await currentAgentMode();
    const abort = new AbortController();
    req.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const turn = await startTurn({
          ports: dbPorts(userId, conversationId),
          store: dbTurnStore(conversationId, userId),
          text,
          mode,
          scenario,
          record: recordingEnabled(),
          emit: (c) => writer.write(c),
          abortSignal: abort.signal,
        });
        writer.merge(turn.uiStream);
        await turn.done;
      },
      onError: (e) => {
        req.log.error({ err: e }, "agent turn failed");
        return isAiConfigError(e) ? `${e.code}: ${e.message}` : "The assistant could not answer. Please try again.";
      },
    });
    return reply.send(createUIMessageStreamResponse({ stream, headers: { "cache-control": "no-store" } }));
  });

  app.post("/agent/documents", { schema: { response: { 200: UploadDocumentResponse } } }, async (req) => {
    const userId = userIdOf(req);
    if (!req.isMultipart()) throw new HttpProblem(415, "MULTIPART_REQUIRED", "Upload the document as multipart/form-data (field 'file')");
    const part = await req.file();
    if (!part) throw new HttpProblem(400, "FILE_REQUIRED", "Missing file field");
    let data: Buffer;
    try {
      data = await part.toBuffer();
    } catch {
      throw new HttpProblem(413, "DOC_TOO_LARGE", "Documents are limited to 10 MB");
    }
    const field = (name: string): string | undefined => {
      const f = part.fields[name];
      const one = Array.isArray(f) ? f[0] : f;
      return one && one.type === "field" ? String(one.value) : undefined;
    };
    const kindRaw = field("kind");
    const kind = kindRaw ? ReaderDocType.safeParse(kindRaw) : null;
    if (kind && !kind.success) throw new HttpProblem(400, "DOC_KIND_INVALID", "kind must be invoice, notification or email_change_request");
    const conversationId = field("conversationId");
    if (conversationId !== undefined && !z.string().uuid().safeParse(conversationId).success) throw new HttpProblem(400, "BAD_CONVERSATION_ID", "conversationId must be a UUID");
    try {
      const docId = await storeDocument(userId, {
        data: new Uint8Array(data),
        mediaType: part.mimetype,
        filename: part.filename ?? null,
        kind: kind?.success ? kind.data : null,
        conversationId: conversationId ?? null,
      });
      return { docId };
    } catch (e) {
      if (e instanceof DocumentError) throw new HttpProblem(e.code === "DOC_TOO_LARGE" ? 413 : e.code === "DOC_UNSUPPORTED_TYPE" ? 415 : 400, e.code, e.message);
      throw e;
    }
  });
};

export default routes;
