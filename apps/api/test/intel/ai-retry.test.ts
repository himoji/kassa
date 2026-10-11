import { APICallError } from "@ai-sdk/provider";
import { generateText, simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { aiMaxRetries, backoffDelayMs, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS, SDK_MAX_RETRIES, withRetries } from "../../src/modules/ai/retry.ts";

/* ai/retry.ts: 429 / 5xx retries with exponential backoff + jitter, honouring Retry-After. No network. */

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const ok = { content: [{ type: "text" as const, text: "hi" }], finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE, warnings: [] };
const err = (statusCode: number, headers?: Record<string, string>) =>
  new APICallError({ message: `HTTP ${statusCode}`, url: "u", requestBodyValues: {}, statusCode, ...(headers ? { responseHeaders: headers } : {}) });

function flaky(failures: APICallError[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const e = failures[i++];
      if (e) throw e;
      return ok;
    },
  });
}

describe("provider retries (429 / 5xx)", () => {
  it("AI_MAX_RETRIES defaults to 5 and rejects junk", () => {
    expect(aiMaxRetries({})).toBe(5);
    expect(aiMaxRetries({ AI_MAX_RETRIES: "2" })).toBe(2);
    expect(aiMaxRetries({ AI_MAX_RETRIES: "0" })).toBe(0);
    expect(aiMaxRetries({ AI_MAX_RETRIES: "-1" })).toBe(5);
    expect(aiMaxRetries({ AI_MAX_RETRIES: "x" })).toBe(5);
  });

  it("retries 429 and 503 until success, with growing jittered delays", async () => {
    const base = flaky([err(429), err(503), err(429)]);
    const delays: number[] = [];
    const model = withRetries(base, { maxRetries: 5, sleep: async (ms) => void delays.push(ms), random: () => 0.5 });
    const r = await generateText({ model, prompt: "p", maxRetries: SDK_MAX_RETRIES });
    expect(r.text).toBe("hi");
    expect(base.doGenerateCalls).toHaveLength(4);
    expect(delays).toEqual([750, 1500, 3000]);
  });

  it("honours Retry-After (seconds) and retry-after-ms", async () => {
    const delays: number[] = [];
    const model = withRetries(flaky([err(429, { "retry-after": "3" }), err(429, { "retry-after-ms": "250" })]), { maxRetries: 5, sleep: async (ms) => void delays.push(ms) });
    await generateText({ model, prompt: "p", maxRetries: SDK_MAX_RETRIES });
    expect(delays).toEqual([3000, 250]);
  });

  it("gives up after maxRetries and surfaces the provider error", async () => {
    const base = flaky([err(429), err(429), err(429), err(429)]);
    const model = withRetries(base, { maxRetries: 2, sleep: async () => undefined });
    await expect(generateText({ model, prompt: "p", maxRetries: SDK_MAX_RETRIES })).rejects.toMatchObject({ statusCode: 429 });
    expect(base.doGenerateCalls).toHaveLength(3);
  });

  it("does not retry 400 / 401 (not transient)", async () => {
    for (const status of [400, 401]) {
      const base = flaky([err(status)]);
      await expect(generateText({ model: withRetries(base, { maxRetries: 5, sleep: async () => undefined }), prompt: "p", maxRetries: SDK_MAX_RETRIES })).rejects.toMatchObject({ statusCode: status });
      expect(base.doGenerateCalls).toHaveLength(1);
    }
  });

  it("backoff is exponential with equal jitter, capped; an unreasonable Retry-After is ignored", () => {
    for (let a = 0; a < 8; a++) {
      const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** a);
      expect(backoffDelayMs(a, err(429), () => 0)).toBe(exp / 2);
      expect(backoffDelayMs(a, err(429), () => 0.999999)).toBeLessThanOrEqual(exp);
    }
    expect(backoffDelayMs(0, err(429, { "retry-after": "3600" }), () => 0)).toBe(RETRY_BASE_DELAY_MS / 2);
  });

  it("streaming (planner) calls retry too: a 429 when opening the stream is retried", async () => {
    let n = 0;
    const base = new MockLanguageModelV4({
      doStream: async () => {
        if (n++ === 0) throw err(429);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: "ok" },
              { type: "text-end" as const, id: "t" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE },
            ],
          }),
        };
      },
    });
    const r = streamText({ model: withRetries(base, { maxRetries: 5, sleep: async () => undefined }), prompt: "p", maxRetries: SDK_MAX_RETRIES });
    expect(await r.text).toBe("ok");
    expect(base.doStreamCalls).toHaveLength(2);
  });
});
