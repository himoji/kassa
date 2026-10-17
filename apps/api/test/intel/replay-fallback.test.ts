import { APICallError } from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { AiConfigError } from "../../src/modules/ai/errors.ts";
import { isModelUnavailable, newFallbackState, withReplayFallback } from "../../src/modules/ai/fallback.ts";
import { replayModel } from "../../src/modules/agent/replay.ts";

const recorded = () => replayModel({ userText: "hi", match: [], steps: [{ text: "From the recording." }] });
const apiError = (statusCode: number) =>
  new APICallError({ message: `status ${statusCode}`, url: "http://x", requestBodyValues: {}, statusCode, isRetryable: statusCode >= 500 || statusCode === 429 });
const failing = (e: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw e;
    },
  });

describe("LIVE with a replay safety net (ai/fallback.ts)", () => {
  afterEach(() => {
    delete process.env.AI_REPLAY_FALLBACK;
  });

  it("serves the recording when the provider is down, and says so", async () => {
    const state = newFallbackState();
    const { text } = await generateText({ model: withReplayFallback(failing(apiError(503)), recorded, state), prompt: "hi", maxRetries: 0 });
    expect(text).toBe("From the recording.");
    expect(state).toMatchObject({ used: true });
  });

  it("leaves a rejected request (400) to the caller, and never hides a live answer", async () => {
    const state = newFallbackState();
    await expect(generateText({ model: withReplayFallback(failing(apiError(400)), recorded, state), prompt: "hi", maxRetries: 0 })).rejects.toThrow();
    expect(state.used).toBe(false);

    const live = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text: "Live." }], finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] }) });
    const ok = newFallbackState();
    expect((await generateText({ model: withReplayFallback(live, recorded, ok), prompt: "hi", maxRetries: 0 })).text).toBe("Live.");
    expect(ok.used).toBe(false);
  });

  it("can be turned off with AI_REPLAY_FALLBACK=false", async () => {
    process.env.AI_REPLAY_FALLBACK = "false";
    const state = newFallbackState();
    await expect(generateText({ model: withReplayFallback(failing(apiError(503)), recorded, state), prompt: "hi", maxRetries: 0 })).rejects.toThrow();
    expect(state.used).toBe(false);
  });

  it("knows unavailable from rejected", () => {
    expect(isModelUnavailable(new AiConfigError("AI_PROVIDER_KEY_MISSING", "no key"))).toBe(true);
    expect(isModelUnavailable(apiError(401))).toBe(true);
    expect(isModelUnavailable(apiError(402))).toBe(true);
    expect(isModelUnavailable(apiError(429))).toBe(true);
    expect(isModelUnavailable(apiError(400))).toBe(false);
    expect(isModelUnavailable(new TypeError("fetch failed"))).toBe(true);
  });
});
