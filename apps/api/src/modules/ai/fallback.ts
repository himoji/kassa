import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";

import { AiConfigError } from "./errors.ts";
import { apiCallErrorOf, isRetryableAiError } from "./retry.ts";

/*
 * LIVE first, replay as a safety net. The planner runs live; if the provider cannot be used for the FIRST model call
 * of a turn (no key, network down, 401, retries exhausted), the turn is served from the matching recorded replay
 * instead, and the message is labelled "Replay" in the app. A failure after a live step has run is not hidden: the
 * replay would not continue the same conversation, so that error surfaces as usual. Only "the model is unavailable"
 * errors switch (no key, auth refused, network, 5xx/429 after retries): a 400 such as "structured outputs not
 * supported" is left to ai/structured.ts, which retries in another mode. AI_REPLAY_FALLBACK=false turns this off.
 */

export function replayFallbackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AI_REPLAY_FALLBACK?.trim().toLowerCase() !== "false";
}

/** Whether an error means the model can't be used right now (as opposed to a request it rejected). */
export function isModelUnavailable(e: unknown): boolean {
  if (e instanceof AiConfigError) return true;
  if (isRetryableAiError(e)) return true;
  const status = apiCallErrorOf(e)?.statusCode;
  if (status === 401 || status === 403 || status === 404) return true;
  // A request that never got an HTTP answer (DNS, refused connection) has no APICallError.
  return apiCallErrorOf(e) === null && e instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(`${e.message} ${String((e as { cause?: unknown }).cause ?? "")}`);
}

export interface FallbackState {
  /** Set once the turn switched to the recording. */
  used: boolean;
  /** Why (an AiConfigError code or the provider error's message). */
  reason: string | null;
}

export function newFallbackState(): FallbackState {
  return { used: false, reason: null };
}

function reasonOf(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") return (e as { code: string }).code;
  return e instanceof Error ? e.message.slice(0, 200) : "provider error";
}

/**
 * Wraps a live model: the first call that fails goes to `fallback()` (a replay model, or null when no recording
 * matches, in which case the original error is thrown). After a switch every later step uses the replay too.
 */
export function withReplayFallback(live: LanguageModel, fallback: () => LanguageModel | null, state: FallbackState): LanguageModel {
  let liveCalls = 0;
  let replay: LanguageModelV4 | null = null;
  const switchTo = (e: unknown): LanguageModelV4 => {
    const m = liveCalls === 0 && isModelUnavailable(e) && replayFallbackEnabled() ? fallback() : null;
    if (!m || typeof m === "string") throw e;
    replay = m as LanguageModelV4;
    state.used = true;
    state.reason = reasonOf(e);
    return replay;
  };
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      if (replay) return replay.doGenerate(params);
      try {
        const r = await doGenerate();
        liveCalls++;
        return r;
      } catch (e) {
        return switchTo(e).doGenerate(params);
      }
    },
    wrapStream: async ({ doStream, params }) => {
      if (replay) return replay.doStream(params);
      try {
        const r = await doStream();
        liveCalls++;
        return r;
      } catch (e) {
        return switchTo(e).doStream(params);
      }
    },
  };
  return wrapLanguageModel({ model: live as Exclude<LanguageModel, string>, middleware });
}
