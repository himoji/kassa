import { OnboardingConversationResponse, OnboardingHistoryRequest, OnboardingMessageRequest, OnboardingMessageResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { ownedNotFound } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { isAiConfigError } from "../ai/errors.ts";
import { currentAgentMode, recordingEnabled } from "../ai/mode.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { requireAiConsent } from "../privacy/notice.ts";
import { ChoiceError } from "../agent/choices.ts";
import { onboardingHistoryTurn } from "./history.ts";
import { latestOnboardingConversation, onboardingTurn } from "./service.ts";

/** POST /onboarding/message, POST /onboarding/history, GET /onboarding/conversation. (/onboarding/confirm and /confirm/options are Track A's, users/routes.ts.) */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);
  // Consent to AI processing is captured at sign-up (RegisterVerifyRequest.aiConsent) or POST /privacy/ai-consent.
  app.addHook("preHandler", requireAiConsent);
  app.post("/onboarding/message", { schema: { body: OnboardingMessageRequest, response: { 200: OnboardingMessageResponse } } }, async (req) => {
    try {
      return await onboardingTurn({ userId: userIdOf(req), ...req.body, mode: await currentAgentMode(), record: recordingEnabled() });
    } catch (e) {
      if (isAiConfigError(e)) {
        // Code + provider status / error class only (no prompt, draft or key material).
        req.log.warn({ code: e.code, details: e.details }, "onboarding turn failed");
        throw new HttpProblem(e.code === "AI_REPLAY_MISSING" ? 404 : 503, e.code, e.message);
      }
      if (e instanceof ChoiceError) throw new HttpProblem(e.code === "CHOICE_NOT_FOUND" ? 404 : 400, e.code, e.message);
      if ((e as { code?: string }).code === "CONVERSATION_FORBIDDEN") throw await ownedNotFound(userIdOf(req), "conversation", req.body.conversationId, async () => true);
      throw e;
    }
  });

  // Bank history read from the user's statements (POST /import/file) joins the draft; code writes the reply (history.ts).
  app.post("/onboarding/history", { schema: { body: OnboardingHistoryRequest, response: { 200: OnboardingMessageResponse } } }, async (req) => {
    try {
      return await onboardingHistoryTurn(userIdOf(req), req.body);
    } catch (e) {
      if ((e as { code?: string }).code === "CONVERSATION_FORBIDDEN") throw await ownedNotFound(userIdOf(req), "conversation", req.body.conversationId, async () => true);
      throw e;
    }
  });

  // Restores the onboarding chat (and the review screen's conversation id) after a reload.
  app.get("/onboarding/conversation", { schema: { response: { 200: OnboardingConversationResponse } } }, async (req) => latestOnboardingConversation(userIdOf(req)));
};

export default routes;
