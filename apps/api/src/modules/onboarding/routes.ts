import { OnboardingMessageRequest, OnboardingMessageResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { HttpProblem } from "../../http/problem.ts";
import { isAiConfigError } from "../ai/errors.ts";
import { currentAgentMode, recordingEnabled } from "../ai/mode.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { onboardingTurn } from "./service.ts";

/** POST /onboarding/message. (/onboarding/confirm and /confirm/options are Track A's, users/routes.ts.) */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);
  app.post("/onboarding/message", { schema: { body: OnboardingMessageRequest, response: { 200: OnboardingMessageResponse } } }, async (req) => {
    try {
      return await onboardingTurn({ userId: userIdOf(req), ...req.body, mode: await currentAgentMode(), record: recordingEnabled() });
    } catch (e) {
      if (isAiConfigError(e)) throw new HttpProblem(e.code === "AI_REPLAY_MISSING" ? 404 : 503, e.code, e.message);
      if ((e as { code?: string }).code === "CONVERSATION_FORBIDDEN") throw new HttpProblem(403, "CONVERSATION_FORBIDDEN", "This conversation belongs to another user");
      throw e;
    }
  });
};

export default routes;
