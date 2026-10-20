import multipart from "@fastify/multipart";
import { AgentMessageRequest, ConversationMessagesResponse, ConversationsResponse, ReaderDocType, RenameConversationRequest, UploadDocumentResponse } from "@kassa/shared";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { ownedNotFound } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { isAiConfigError } from "../ai/errors.ts";
import { currentAgentMode, recordingEnabled } from "../ai/mode.ts";
import { MAX_VOICE_BYTES, transcribeAudio, VOICE_FORMATS, VoiceError } from "../ai/voice.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { requireAiConsent } from "../privacy/notice.ts";
import { DocumentError, MAX_DOCUMENT_BYTES, storeDocument } from "../reader/index.ts";
import { answerText, ChoiceError } from "./choices.ts";
import {
  claimConversation,
  ConversationForbiddenError,
  conversationOwner,
  deleteConversation,
  listConversations,
  loadAllMessages,
  loadHistory,
  loadPlaceholders,
  ownsConversation,
  renameConversation,
} from "./history.ts";
import { startTurn } from "./loop.ts";
import { dbPorts } from "./ports.ts";
import { dbTurnStore } from "./store.ts";
import { toUIMessages } from "./ui-history.ts";

/*
 * POST /agent/message → AI SDK v7 UI message stream (text + data-proposal / data-routes /
 * data-budget-impact / data-choices cards, metadata {replay}). POST /agent/documents (multipart) → {docId}.
 * POST /agent/transcribe {audioBase64, format} → {text} (the mic button; speech to text only, no turn).
 * GET /agent/conversations, GET /agent/conversations/:id/messages: the caller's persisted chats.
 * Every conversation id is claimed by its first request (history.ts claimConversation): another user's id, or the
 * caller's onboarding id, answers 404 like a missing one, and the probe is audited.
 */

/** BOLA (OWASP API1): someone else's conversation answers like a missing one; the probe is audited. */
async function claimOr404(userId: string, conversationId: string, title?: string | null): Promise<void> {
  try {
    await claimConversation(conversationId, userId, "agent", title);
  } catch (e) {
    if (e instanceof ConversationForbiddenError) throw await ownedNotFound(userId, "conversation", conversationId, async () => true);
    throw e;
  }
}

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
    const { conversationId, scenario, choice } = req.body;
    await claimOr404(userId, conversationId, req.body.text.slice(0, 60));
    // A pick (tap, or typed / spoken text matching the pending picker) becomes the option's label; ids the stored
    // picker does not offer are refused (the client cannot invent options).
    let text: string;
    try {
      text = answerText(await loadHistory(conversationId, userId), req.body.text, choice);
    } catch (e) {
      if (e instanceof ChoiceError) throw new HttpProblem(e.code === "CHOICE_NOT_FOUND" ? 404 : 400, e.code, e.message);
      throw e;
    }
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
          context: { timeZone: req.body.timeZone, locale: req.body.locale },
        });
        writer.merge(turn.uiStream);
        const s = await turn.done;
        // Turn latency and how it ended (agent/budget.ts): a cut turn is answered by the final call or by code.
        req.log.info({ steps: s.steps, toolCalls: s.toolCalls.length, elapsedMs: s.elapsedMs, answeredBy: s.answeredBy, cutoff: s.cutoff }, "agent turn");
      },
      onError: (e) => {
        req.log.error({ err: e }, "agent turn failed");
        return isAiConfigError(e) ? `${e.code}: ${e.message}` : "The assistant could not answer. Please try again.";
      },
    });
    return reply.send(createUIMessageStreamResponse({ stream, headers: { "cache-control": "no-store" } }));
  });

  app.get("/agent/conversations", { schema: { response: { 200: ConversationsResponse } } }, async (req) => {
    const rows = await listConversations(userIdOf(req), "agent");
    return {
      conversations: rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt.toISOString(),
        lastMessageAt: (r.lastMessageAt ?? r.createdAt).toISOString(),
        messageCount: r.messageCount,
      })),
    };
  });

  app.get(
    "/agent/conversations/:id/messages",
    { schema: { params: z.object({ id: z.string().uuid() }), response: { 200: ConversationMessagesResponse } } },
    async (req) => {
      const userId = userIdOf(req);
      const { id } = req.params;
      if (!(await ownsConversation(id, userId, "agent"))) throw await ownedNotFound(userId, "conversation", id, async () => (await conversationOwner(id)) !== null);
      const [messages, placeholders] = await Promise.all([loadAllMessages(id, userId), loadPlaceholders(id, userId)]);
      return { messages: await toUIMessages(id, messages, placeholders, dbPorts(userId, id)) };
    },
  );

  app.patch(
    "/agent/conversations/:id",
    { schema: { params: z.object({ id: z.string().uuid() }), body: RenameConversationRequest } },
    async (req, reply) => {
      const userId = userIdOf(req);
      const { id } = req.params;
      if (!(await renameConversation(id, userId, "agent", req.body.title))) {
        throw await ownedNotFound(userId, "conversation", id, async () => (await conversationOwner(id)) !== null);
      }
      return reply.status(204).send();
    },
  );

  app.delete("/agent/conversations/:id", { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const userId = userIdOf(req);
    const { id } = req.params;
    if (!(await deleteConversation(id, userId, "agent"))) {
      throw await ownedNotFound(userId, "conversation", id, async () => (await conversationOwner(id)) !== null);
    }
    return reply.status(204).send();
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
    // The document joins a conversation: same ownership rule as /agent/message (other user / other channel → 404).
    if (conversationId !== undefined) await claimOr404(userId, conversationId);
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

  /*
   * Speech to text for the chat's mic button (the app, the web app, KassaLite): the recording goes to VOICE_MODEL
   * (ai/voice.ts) and only the transcript comes back. Nothing is stored and no turn starts here: the app shows the
   * transcript in the composer and sends it to /agent/message as a normal turn. AI consent is checked by the hook
   * above, like every agent route.
   */
  app.post(
    "/agent/transcribe",
    {
      bodyLimit: Math.ceil((MAX_VOICE_BYTES * 4) / 3) + 64 * 1024,
      schema: {
        body: z.object({
          audioBase64: z.string().min(1).max(Math.ceil((MAX_VOICE_BYTES * 4) / 3) + 64),
          format: z.enum(VOICE_FORMATS),
        }),
        response: { 200: z.object({ text: z.string() }) },
      },
    },
    async (req) => {
      const audio = req.body.audioBase64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
      if (!audio || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) throw new HttpProblem(400, "VOICE_AUDIO_INVALID", "audioBase64 must be base64 audio");
      const bytes = Math.floor((audio.length * 3) / 4) - (audio.endsWith("==") ? 2 : audio.endsWith("=") ? 1 : 0);
      if (bytes > MAX_VOICE_BYTES) throw new HttpProblem(413, "VOICE_TOO_LARGE", `Recordings are limited to ${MAX_VOICE_BYTES / (1024 * 1024)} MB`);
      try {
        return { text: await transcribeAudio(audio, req.body.format) };
      } catch (e) {
        req.log.warn({ err: e }, "chat transcription failed");
        if (isAiConfigError(e)) throw new HttpProblem(503, e.code, "Voice input is not set up on this server (no voice model key).");
        if (e instanceof VoiceError && e.status === 400) throw new HttpProblem(422, "VOICE_UNREADABLE", `The voice model could not read this recording (${req.body.format}).`);
        throw new HttpProblem(502, "VOICE_UNAVAILABLE", "The voice model did not answer. Try again.");
      }
    },
  );
};

export default routes;
