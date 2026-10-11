/*
 * Scripted planner and Reader models for attack tests (no real AI). The planner is an AI SDK mock model whose
 * next step is computed from the (redacted) prompt it receives, so a test can script a COMPROMISED planner that
 * reads tool results and obeys injected instructions, using only the placeholders it was actually shown.
 * Runs through the real agent loop (startTurn → redaction middleware → real tools → rules).
 */
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { simulateReadableStream, type UIMessageChunk } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { randomUUID } from "node:crypto";

import { dbPorts, type AgentPorts } from "../../src/modules/agent/ports.ts";
import { startTurn, type TurnSummary } from "../../src/modules/agent/loop.ts";
import { stepChunks, type RecordedStep } from "../../src/modules/agent/replay.ts";
import { dbTurnStore } from "../../src/modules/agent/store.ts";
import type { ToolContext } from "../../src/modules/agent/tools.ts";
import { readDocument } from "../../src/modules/reader/index.ts";

export type ToolResultSeen = { toolName: string; value: Record<string, unknown> };

/** Tool results in the prompt, oldest first (what the planner has been shown so far). */
export function toolResults(prompt: LanguageModelV4Prompt): ToolResultSeen[] {
  const out: ToolResultSeen[] = [];
  for (const m of prompt) {
    if (m.role !== "tool") continue;
    for (const part of m.content) {
      if (part.type !== "tool-result") continue;
      const o = part.output as { type: string; value?: unknown };
      let value: unknown = o.value;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          value = { text: value };
        }
      }
      out.push({ toolName: part.toolName, value: (value ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

/** Every text the planner was given (system, user, tool results), for "what did the model see" assertions. */
export function promptText(prompt: LanguageModelV4Prompt): string {
  return JSON.stringify(prompt);
}

/**
 * A planner whose step n is `script(n, seen, prompt)`. Return a RecordedStep (text and/or tool calls);
 * return `{ text }` with no tool calls to end the turn.
 */
export function scriptedPlanner(script: (step: number, seen: ToolResultSeen[], prompt: LanguageModelV4Prompt) => RecordedStep) {
  let step = 0;
  const prompts: LanguageModelV4Prompt[] = [];
  const model = new MockLanguageModelV4({
    provider: "test-adversary",
    modelId: "scripted",
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      const s = script(step, toolResults(prompt), prompt);
      const chunks = stepChunks(s, step);
      step++;
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 0 }) };
    },
  });
  return { model, prompts };
}

/** A Reader model that returns `output` as its structured extraction (the server still re-checks evidence). */
export function readerModel(output: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    }),
  });
}

/** Extraction field helper: `{ value, evidence }`. */
export const field = (value: string | null, evidence: string | null = value) => ({ value, evidence });

export type AgentTurnResult = { summary: TurnSummary; ctx: ToolContext; emitted: UIMessageChunk[]; text: string; prompts: LanguageModelV4Prompt[] };

/**
 * One real agent turn on the test DB: dbPorts + dbTurnStore, the scripted planner, and (optionally) a scripted
 * Reader model for read_document. Returns the turn summary and the tool context (ctx.proposals).
 */
export async function runAgentTurn(opts: {
  userId: string;
  text: string;
  planner: ReturnType<typeof scriptedPlanner>;
  reader?: unknown;
  conversationId?: string;
  ports?: Partial<AgentPorts>;
}): Promise<AgentTurnResult> {
  const conversationId = opts.conversationId ?? randomUUID();
  const base = dbPorts(opts.userId, conversationId);
  const ports: AgentPorts = {
    ...base,
    ...(opts.reader !== undefined ? { readDocument: (docId: string) => readDocument(docId, { userId: opts.userId, model: readerModel(opts.reader), modelLabel: "test:reader" }) } : {}),
    ...opts.ports,
  };
  const emitted: UIMessageChunk[] = [];
  const h = await startTurn({ ports, store: dbTurnStore(conversationId, opts.userId), text: opts.text, mode: "LIVE", model: opts.planner.model, emit: (c) => emitted.push(c) });
  let text = "";
  const reader = h.uiStream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "text-delta") text += value.delta;
    emitted.push(value);
  }
  const summary = await h.done;
  return { summary, ctx: h.ctx, emitted, text, prompts: opts.planner.prompts };
}
