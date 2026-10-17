import { randomUUID } from "node:crypto";

import { APICallError, type LanguageModelV4CallOptions, type LanguageModelV4Content } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { isAiConfigError } from "../../src/modules/ai/errors.ts";
import { cachedStructuredMode, EXTRACT_TOOL_NAME, extractJsonObject, generateStructured, resetStructuredCapabilityCache } from "../../src/modules/ai/structured.ts";
import { readUntrusted } from "../../src/modules/reader/reader.ts";

/*
 * ai/structured.ts: native structured output, else a forced schema-carrier tool call, else JSON text;
 * capability cached per model; one validation retry. No network: mock models only.
 */

const Schema = z.object({ name: z.string(), count: z.number().int() });
const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const done = (content: LanguageModelV4Content[]) => ({ content, finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE, warnings: [] });
const text = (t: string) => done([{ type: "text", text: t }]);
const toolCall = (input: unknown) => done([{ type: "tool-call", toolCallId: "c1", toolName: EXTRACT_TOOL_NAME, input: JSON.stringify(input) }]);

/** The 400 OpenRouter returns for models without response_format support (smoke run 2026-10-11). */
const noStructured = () =>
  new APICallError({ message: "Bad Request", url: "https://x/chat/completions", requestBodyValues: {}, statusCode: 400, responseBody: '{"error":{"message":"does not support feature: structured-outputs"}}' });
const noTools = () =>
  new APICallError({ message: "Bad Request", url: "https://x/chat/completions", requestBodyValues: {}, statusCode: 400, responseBody: '{"error":{"message":"tool use is not supported for this model"}}' });

const modeOf = (call: LanguageModelV4CallOptions) => (call.tools?.length ? "tool" : call.responseFormat?.type === "json" ? "native" : "json");

/** A model that behaves like a provider with the given capabilities and answers `answer` in each mode. */
function provider(caps: { native: boolean; tools: boolean }, answer: (mode: string, n: number) => unknown) {
  let n = 0;
  return new MockLanguageModelV4({
    provider: "test",
    modelId: `m-${randomUUID()}`,
    doGenerate: async (call) => {
      const mode = modeOf(call);
      if (mode === "native" && !caps.native) throw noStructured();
      if (mode === "tool" && !caps.tools) throw noTools();
      const value = answer(mode, n++);
      if (mode === "tool") return toolCall(value);
      return text(mode === "json" ? `Sure:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` : JSON.stringify(value));
    },
  });
}

const env = {};
afterEach(() => resetStructuredCapabilityCache());

describe("structured output strategy (any provider)", () => {
  it("uses native structured output when the provider supports it", async () => {
    const model = provider({ native: true, tools: true }, () => ({ name: "a", count: 1 }));
    const r = await generateStructured({ model, schema: Schema, instructions: "x", prompt: "p", env });
    expect(r).toEqual({ output: { name: "a", count: 1 }, mode: "native" });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]!.tools ?? []).toEqual([]);
  });

  it("on the 'does not support structured-outputs' 400 falls back to ONE forced schema-carrier tool call, and caches it", async () => {
    const model = provider({ native: false, tools: true }, () => ({ name: "b", count: 2 }));
    const r = await generateStructured({ model, schema: Schema, instructions: "x", prompt: "p", env });
    expect(r).toEqual({ output: { name: "b", count: 2 }, mode: "tool" });
    const call = model.doGenerateCalls[1]!;
    expect(call.tools?.map((t) => t.name)).toEqual([EXTRACT_TOOL_NAME]);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: EXTRACT_TOOL_NAME });
    expect(cachedStructuredMode(model)).toBe("tool");
    // Second call goes straight to tool mode (no second 400).
    await generateStructured({ model, schema: Schema, instructions: "x", prompt: "p", env });
    expect(model.doGenerateCalls.map(modeOf)).toEqual(["native", "tool", "tool"]);
  });

  it("falls back to JSON-in-text when tools are rejected too, with a JSON-only instruction", async () => {
    const model = provider({ native: false, tools: false }, () => ({ name: "c", count: 3 }));
    const r = await generateStructured({ model, schema: Schema, instructions: "x", prompt: "p", env });
    expect(r).toEqual({ output: { name: "c", count: 3 }, mode: "json" });
    expect(model.doGenerateCalls.map(modeOf)).toEqual(["native", "tool", "json"]);
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toMatch(/ONLY one JSON object/);
    expect(cachedStructuredMode(model)).toBe("json");
  });

  it("a schema too large for constrained decoding (Anthropic's 'compiled grammar is too large') falls back like a missing capability", async () => {
    const tooLarge = () =>
      new APICallError({ message: "Provider returned error", url: "https://x/chat/completions", requestBodyValues: {}, statusCode: 400, responseBody: '{"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.\\"}}"}}}' });
    const model = new MockLanguageModelV4({
      provider: "test",
      modelId: `m-${randomUUID()}`,
      doGenerate: async (call) => {
        if (modeOf(call) !== "json") throw tooLarge();
        return text(JSON.stringify({ name: "g", count: 4 }));
      },
    });
    const r = await generateStructured({ model, schema: Schema, instructions: "x", prompt: "p", env });
    expect(r).toEqual({ output: { name: "g", count: 4 }, mode: "json" });
    expect(model.doGenerateCalls.map(modeOf)).toEqual(["native", "tool", "json"]);
  });

  it("AI_STRUCTURED_MODE picks the first mode to try", async () => {
    const model = provider({ native: true, tools: true }, () => ({ name: "d", count: 4 }));
    const r = await generateStructured({ model, schema: Schema, instructions: "x", prompt: "p", env: { AI_STRUCTURED_MODE: "json" } });
    expect(r.mode).toBe("json");
    expect(model.doGenerateCalls.map(modeOf)).toEqual(["json"]);
  });

  it("an invalid answer is retried once (with the validation issues), then succeeds", async () => {
    const model = provider({ native: false, tools: true }, (_m, n) => (n === 0 ? { name: "e", count: "many" } : { name: "e", count: 5 }));
    const r = await generateStructured({ model, schema: Schema, instructions: "x", prompt: "p", env });
    expect(r.output).toEqual({ name: "e", count: 5 });
    expect(model.doGenerateCalls.map(modeOf)).toEqual(["native", "tool", "tool"]);
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain("rejected by validation");
  });

  it("two invalid answers fail with AI_STRUCTURED_OUTPUT_INVALID (no third try, no silent default)", async () => {
    const model = provider({ native: true, tools: true }, () => ({ name: 1 }));
    const e = await generateStructured({ model, schema: Schema, instructions: "x", prompt: "p", env }).catch((x: unknown) => x);
    expect(isAiConfigError(e) && e.code).toBe("AI_STRUCTURED_OUTPUT_INVALID");
    // native twice, then one more chance in tool mode (twice), then the error.
    expect(model.doGenerateCalls.map(modeOf)).toEqual(["native", "native", "tool", "tool"]);
  });

  it("native accepted but no answer (reasoning-only stream, finish 'other') → retried, then tool mode", async () => {
    const model = new MockLanguageModelV4({
      provider: "test",
      modelId: `m-${randomUUID()}`,
      doGenerate: async (call) =>
        modeOf(call) === "tool" ? toolCall({ name: "f", count: 6 }) : { ...done([{ type: "reasoning", text: "thinking…" }]), finishReason: { unified: "other" as const, raw: "error" } },
    });
    const r = await generateStructured({ model, schema: Schema, instructions: "x", prompt: "p", env });
    expect(r).toEqual({ output: { name: "f", count: 6 }, mode: "tool" });
    expect(model.doGenerateCalls.map(modeOf)).toEqual(["native", "native", "tool"]);
  });

  it("non-capability errors (auth, 429 after retries) are not mistaken for a missing capability", async () => {
    const model = new MockLanguageModelV4({
      provider: "test",
      modelId: `m-${randomUUID()}`,
      doGenerate: async () => {
        throw new APICallError({ message: "Unauthorized", url: "u", requestBodyValues: {}, statusCode: 401, responseBody: "invalid key" });
      },
    });
    await expect(generateStructured({ model, schema: Schema, instructions: "x", prompt: "p", env })).rejects.toThrow("Unauthorized");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(cachedStructuredMode(model)).toBeUndefined();
  });

  it("extractJsonObject tolerates fences and prose but not garbage", () => {
    expect(extractJsonObject('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('ok {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJsonObject("no json here")).toThrow();
  });
});

describe("Reader on a provider without structured output (I10 kept)", () => {
  const SOURCE = "University in Budapest (simulated)\nPayee account: HU83 1180 0990 5400 2217 0000 0005\nAmount due: EUR 2,400.00\nDue date: 31.10.2026";
  const f = (value: string | null, evidence: string | null) => ({ value, evidence });
  const extraction = {
    payeeName: f("University in Budapest", "University in Budapest (simulated)"),
    accountNumber: f("HU83118009905400221700000005", "HU83 1180 0990 5400 2217 0000 0005"),
    reference: f(null, null),
    amount: f("9400.00", "Amount due: EUR 2,400.00"),
    currency: f("EUR", "EUR 2,400.00"),
    dueDate: f("2026-10-31", "Due date: 31.10.2026"),
  };

  it("the forced extraction 'tool' is the only tool, carries the schema, has nothing to execute, and evidence checks still run", async () => {
    const model = provider({ native: false, tools: true }, () => extraction);
    const r = await readUntrusted("invoice", { type: "text", text: SOURCE }, { model, modelLabel: "test:reader" });
    const call = model.doGenerateCalls[1]!;
    expect(call.tools).toHaveLength(1);
    const carrier = call.tools![0]!;
    expect(carrier).toMatchObject({ type: "function", name: EXTRACT_TOOL_NAME });
    expect(JSON.stringify((carrier as { inputSchema: unknown }).inputSchema)).toContain("accountNumber");
    expect(JSON.stringify(call.prompt)).toContain("<untrusted_document>");
    // Same server checks as before: amount value contradicts its evidence → UNVERIFIED, mismatch flagged.
    expect(r.checks.account).toBe("VERIFIED");
    expect(r.checks.amount).toBe("UNVERIFIED");
    expect(r.reasonCodes).toContain("READER_SOURCE_MISMATCH");
  });

  it("works in JSON mode too, with the same checks", async () => {
    const model = provider({ native: false, tools: false }, () => ({ ...extraction, amount: f("2400.00", "Amount due: EUR 2,400.00") }));
    const r = await readUntrusted("invoice", { type: "text", text: SOURCE }, { model, modelLabel: "test:reader" });
    expect(model.doGenerateCalls[2]!.tools ?? []).toEqual([]);
    expect(r.parsed).toEqual({ amountMinor: 240000, currency: "EUR", dueDate: "2026-10-31", account: "HU83118009905400221700000005" });
  });
});
