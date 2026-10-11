import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { LanguageModelV4Content, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { AiConfigError } from "../ai/errors.ts";

/*
 * Replay (spec §9): RECORD=1 records each planner step's output (text + tool calls) per scenario into
 * fixtures/agent-recordings/<scenario>.json; AGENT_MODE=REPLAY serves them through the AI SDK mock
 * language model. Only MODEL outputs are recorded — tools still execute for real against the
 * database, rules and Reader, so replay exercises the whole tool loop and every safety check.
 * Recordings hold redacted text only (placeholders), never personal data.
 */

export const RECORDINGS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../fixtures/agent-recordings");

export const RecordedStep = z.object({
  text: z.string().optional(),
  toolCalls: z.array(z.object({ toolName: z.string(), input: z.record(z.string(), z.unknown()) })).optional(),
});
export type RecordedStep = z.infer<typeof RecordedStep>;

export const RecordedTurn = z.object({
  /** Redacted user text the turn was recorded with. */
  userText: z.string(),
  /** Keywords (case-insensitive, all must occur) used to pick this turn when the text differs. */
  match: z.array(z.string()).default([]),
  steps: z.array(RecordedStep).min(1),
});
export type RecordedTurn = z.infer<typeof RecordedTurn>;

export const Recording = z.object({
  scenario: z.string(),
  description: z.string().optional(),
  recordedWith: z.string(),
  turns: z.array(RecordedTurn).min(1),
});
export type Recording = z.infer<typeof Recording>;

export function scenarioSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "scenario";
}

export function loadRecording(scenario: string, dir = RECORDINGS_DIR): Recording | null {
  const p = resolve(dir, `${scenarioSlug(scenario)}.json`);
  if (!existsSync(p)) return null;
  return Recording.parse(JSON.parse(readFileSync(p, "utf8")));
}

export function listRecordings(dir = RECORDINGS_DIR): Recording[] {
  if (!existsSync(dir)) return [];
  const out: Recording[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(Recording.parse(JSON.parse(readFileSync(resolve(dir, f), "utf8"))));
    } catch {
      // not a planner recording (e.g. reader/ subfolder files are not listed here)
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Pick the recorded turn for this user text: exact text, then keywords, then turn index. */
export function selectTurn(
  userText: string,
  opts: { scenario?: string | undefined; priorUserTurns?: number; dir?: string; exclude?: string[] } = {},
): { recording: Recording; turn: RecordedTurn } {
  const pool = opts.scenario
    ? [loadRecording(opts.scenario, opts.dir)].filter((r): r is Recording => r !== null)
    : listRecordings(opts.dir).filter((r) => !(opts.exclude ?? []).includes(r.scenario));
  const t = norm(userText);
  for (const rec of pool) for (const turn of rec.turns) if (norm(turn.userText) === t) return { recording: rec, turn };
  for (const rec of pool) {
    for (const turn of rec.turns) if (turn.match.length > 0 && turn.match.every((k) => t.includes(k.toLowerCase()))) return { recording: rec, turn };
  }
  if (opts.scenario && pool[0]) {
    const turns = pool[0].turns;
    return { recording: pool[0], turn: turns[Math.min(opts.priorUserTurns ?? 0, turns.length - 1)]! };
  }
  throw new AiConfigError("AI_REPLAY_MISSING", "Replay mode has no recording for this message. Try a demo scenario prompt, or switch to LIVE.", { userText });
}

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

export function stepChunks(step: RecordedStep, stepIndex: number): LanguageModelV4StreamPart[] {
  const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (step.text) {
    const id = `t${stepIndex}`;
    chunks.push({ type: "text-start", id });
    // Word-sized deltas so the app's streaming UI behaves like a live model.
    for (const piece of step.text.match(/\S+\s*|\s+/g) ?? []) chunks.push({ type: "text-delta", id, delta: piece });
    chunks.push({ type: "text-end", id });
  }
  (step.toolCalls ?? []).forEach((c, i) => {
    chunks.push({ type: "tool-call", toolCallId: `replay-${stepIndex}-${i}`, toolName: c.toolName, input: JSON.stringify(c.input) });
  });
  chunks.push({
    type: "finish",
    finishReason: { unified: step.toolCalls?.length ? "tool-calls" : "stop", raw: undefined },
    usage: USAGE,
  });
  return chunks;
}

/** The same recorded step as a non-streaming result (generateText, e.g. onboarding's structured output). */
export function stepContent(step: RecordedStep, stepIndex: number): LanguageModelV4Content[] {
  return [
    ...(step.text ? [{ type: "text" as const, text: step.text }] : []),
    ...(step.toolCalls ?? []).map((c, i) => ({ type: "tool-call" as const, toolCallId: `replay-${stepIndex}-${i}`, toolName: c.toolName, input: JSON.stringify(c.input) })),
  ];
}

/** A provider-independent model that plays back one recorded turn, step by step (streamed or not). */
export function replayModel(turn: RecordedTurn, opts: { chunkDelayInMs?: number } = {}): LanguageModel {
  let i = 0;
  return new MockLanguageModelV4({
    provider: "kassa-replay",
    modelId: "replay",
    doGenerate: async () => {
      const step = turn.steps[i] ?? { text: "(End of the recorded replay.)" };
      const content = stepContent(step, i);
      i++;
      return { content, finishReason: { unified: step.toolCalls?.length ? "tool-calls" : "stop", raw: undefined }, usage: USAGE, warnings: [] };
    },
    doStream: async () => {
      const step = turn.steps[i] ?? { text: "(End of the recorded replay.)" };
      const chunks = stepChunks(step, i);
      i++;
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: opts.chunkDelayInMs ?? 0 }) };
    },
  });
}

/** Captures each model step (text + tool calls) during a live run. */
export class StepRecorder {
  readonly steps: RecordedStep[] = [];

  middleware(): LanguageModelMiddleware {
    return {
      specificationVersion: "v4",
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        let text = "";
        const toolCalls: NonNullable<RecordedStep["toolCalls"]> = [];
        const steps = this.steps;
        const tap = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(chunk, ctl) {
            if (chunk.type === "text-delta") text += chunk.delta;
            if (chunk.type === "tool-call") {
              try {
                toolCalls.push({ toolName: chunk.toolName, input: JSON.parse(chunk.input || "{}") as Record<string, unknown> });
              } catch {
                toolCalls.push({ toolName: chunk.toolName, input: {} });
              }
            }
            ctl.enqueue(chunk);
          },
          flush() {
            steps.push({ ...(text ? { text } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
          },
        });
        return { ...result, stream: result.stream.pipeThrough(tap) };
      },
    };
  }

  /** Append (or replace, same userText) this turn in fixtures/agent-recordings/<scenario>.json. */
  save(scenario: string, userText: string, recordedWith: string, dir = RECORDINGS_DIR): string {
    const slug = scenarioSlug(scenario);
    const p = resolve(dir, `${slug}.json`);
    const existing = existsSync(p) ? Recording.parse(JSON.parse(readFileSync(p, "utf8"))) : null;
    const turn: RecordedTurn = { userText, match: [], steps: this.steps.length ? this.steps : [{ text: "" }] };
    const turns = (existing?.turns ?? []).filter((t) => norm(t.userText) !== norm(userText));
    const rec: Recording = { scenario: slug, ...(existing?.description ? { description: existing.description } : {}), recordedWith, turns: [...turns, turn] };
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`);
    return p;
  }
}
