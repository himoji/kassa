import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";

import { AiConfigError, isAiConfigError } from "./errors.ts";
import type { Env } from "./registry.ts";
import { apiCallErrorOf, SDK_MAX_RETRIES } from "./retry.ts";

/*
 * Structured output that works with any provider (docs/architecture/decisions.md 2026-10-11 "Structured output
 * capability strategy"). Modes, tried in this order:
 *   native — the provider's structured output (`response_format` json_schema; AI SDK Output.object);
 *   tool   — ONE forced call (toolChoice {type:"tool"}) of a single schema-carrier tool whose input schema
 *            is the zod schema. The tool has NO execute function, generateText stops after that one
 *            step, and we only read the call's arguments: nothing is ever executed. So the Reader
 *            still has no real tools (I10): the "tool" is a JSON-schema envelope for the answer,
 *            the model cannot reach any function, data or side effect through it;
 *   json   — plain text with a strict "JSON only" instruction and the JSON Schema in the system prompt.
 * A mode is abandoned only when the provider rejects the capability itself (HTTP 400/404/422 naming
 * structured output / response_format, resp. tools); the result is cached per model in memory, so later
 * calls go straight to the working mode. Whatever the mode, the output is parsed and validated with the
 * SAME zod schema; a parse/validation failure is retried once (with the validation issues, never the
 * content, fed back), then fails with AI_STRUCTURED_OUTPUT_INVALID; only native mode, when it is accepted
 * but yields no valid answer twice (empty or unparsable), gets one more chance in tool mode.
 * AI_STRUCTURED_MODE=native|tool|json picks the first mode to try (default auto = cached or native).
 */

export const STRUCTURED_MODES = ["native", "tool", "json"] as const;
export type StructuredMode = (typeof STRUCTURED_MODES)[number];

/** Name of the schema-carrier tool in tool mode. It has no execute function. */
export const EXTRACT_TOOL_NAME = "submit_result";

const capabilityCache = new Map<string, StructuredMode>();

export function modelKey(model: LanguageModel): string {
  if (typeof model === "string") return model;
  const m = model as { provider?: string; modelId?: string };
  return `${m.provider ?? "unknown"}:${m.modelId ?? "unknown"}`;
}

export function cachedStructuredMode(model: LanguageModel): StructuredMode | undefined {
  return capabilityCache.get(modelKey(model));
}

export function resetStructuredCapabilityCache(): void {
  capabilityCache.clear();
}

export function structuredModeOverride(env: Env = process.env): StructuredMode | null {
  const v = env.AI_STRUCTURED_MODE?.trim().toLowerCase();
  return v && (STRUCTURED_MODES as readonly string[]).includes(v) ? (v as StructuredMode) : null;
}

const CAPABILITY_STATUS = new Set([400, 404, 422]);
// A schema too big for the provider's constrained decoding ("The compiled grammar is too large") is a
// capability limit of that mode too: the next mode (a looser tool call, then JSON text) still works.
const SCHEMA_TOO_LARGE = /grammar is too large|schema is too (?:large|complex)/i;
const NATIVE_UNSUPPORTED = /structured[-_ ]?outputs?|response[-_ ]?format|json[-_ ]?schema|json[-_ ]?object|json[-_ ]?mode/i;
const TOOLS_UNSUPPORTED = /tool|function[-_ ]?call/i;

/** Did the provider reject this mode's capability (as opposed to a transient or auth failure)? */
export function isCapabilityError(e: unknown, mode: Exclude<StructuredMode, "json">): boolean {
  const api = apiCallErrorOf(e);
  if (!api || api.statusCode === undefined || !CAPABILITY_STATUS.has(api.statusCode)) return false;
  const text = `${api.message}\n${api.responseBody ?? ""}`;
  return SCHEMA_TOO_LARGE.test(text) || (mode === "native" ? NATIVE_UNSUPPORTED : TOOLS_UNSUPPORTED).test(text);
}

class InvalidOutput extends Error {
  constructor(readonly issues: string) {
    super(issues);
  }
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new InvalidOutput(issuesOf(r.error));
  return r.data;
}

/** The first JSON object in a model's text (tolerates code fences and surrounding prose). */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new InvalidOutput("no JSON object in the answer");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new InvalidOutput("the answer is not valid JSON");
  }
}

function jsonInstructions(schema: z.ZodType): string {
  return `Output format: reply with ONLY one JSON object that validates against this JSON Schema. No prose, no Markdown, no code fences.\n${JSON.stringify(z.toJSONSchema(schema))}`;
}

export interface StructuredCall<T> {
  model: LanguageModel;
  schema: z.ZodType<T>;
  instructions: string;
  /** Either a prompt string or messages. */
  prompt?: string;
  messages?: ModelMessage[];
  /** Describes the result for the schema-carrier tool (tool mode). */
  description?: string;
  abortSignal?: AbortSignal;
  env?: Env;
}

export interface StructuredResult<T> {
  output: T;
  mode: StructuredMode;
}

async function attempt<T>(mode: StructuredMode, c: StructuredCall<T>, feedback: string | null): Promise<T> {
  const instructions = feedback ? `${c.instructions}\n\nYour previous answer was rejected by validation (${feedback}). Answer again, following the schema exactly.` : c.instructions;
  const input = c.messages ? { messages: c.messages } : { prompt: c.prompt ?? "" };
  const common = { model: c.model, maxRetries: SDK_MAX_RETRIES, ...(c.abortSignal ? { abortSignal: c.abortSignal } : {}) };
  if (mode === "native") {
    try {
      const { output } = await generateText({ ...common, ...input, instructions, output: Output.object({ schema: c.schema }) });
      return validate(c.schema, output);
    } catch (e) {
      // No object (unparsable) or no answer at all (e.g. a reasoning model whose stream ended with
      // finish_reason "error" after only reasoning): both count as an invalid answer.
      if (NoObjectGeneratedError.isInstance(e)) throw new InvalidOutput(e.message.slice(0, 200));
      if (NoOutputGeneratedError.isInstance(e)) throw new InvalidOutput("the model returned no answer");
      throw e;
    }
  }
  if (mode === "tool") {
    // Schema carrier only: no `execute`, so the SDK cannot run anything; one forced call, one step.
    const tools = { [EXTRACT_TOOL_NAME]: tool({ description: c.description ?? "Submit the result. Its arguments ARE the answer.", inputSchema: c.schema }) };
    const result = await generateText({
      ...common,
      ...input,
      instructions: `${instructions}\n\nSubmit your answer by calling ${EXTRACT_TOOL_NAME} exactly once.`,
      tools,
      toolChoice: { type: "tool", toolName: EXTRACT_TOOL_NAME },
    });
    const call = result.toolCalls.find((t) => t.toolName === EXTRACT_TOOL_NAME);
    if (call) return validate(c.schema, call.input);
    // Some providers ignore toolChoice and answer in text: accept it if it validates.
    if (result.text.trim()) return validate(c.schema, extractJsonObject(result.text));
    throw new InvalidOutput(`no ${EXTRACT_TOOL_NAME} call in the answer`);
  }
  const { text } = await generateText({ ...common, ...input, instructions: `${instructions}\n\n${jsonInstructions(c.schema)}` });
  return validate(c.schema, extractJsonObject(text));
}

/** One mode with the single validation retry. */
async function runMode<T>(mode: StructuredMode, c: StructuredCall<T>): Promise<T> {
  let feedback: string | null = null;
  for (let i = 0; i < 2; i++) {
    try {
      return await attempt(mode, c, feedback);
    } catch (e) {
      if (!(e instanceof InvalidOutput)) throw e;
      feedback = e.issues;
    }
  }
  throw new AiConfigError("AI_STRUCTURED_OUTPUT_INVALID", `The model's answer did not match the expected format twice (${mode} mode): ${feedback}`, { mode, issues: feedback });
}

/** Generate an object validated by `schema`, using the best structured-output mode the model supports. */
export async function generateStructured<T>(c: StructuredCall<T>): Promise<StructuredResult<T>> {
  const key = modelKey(c.model);
  const first = capabilityCache.get(key) ?? structuredModeOverride(c.env) ?? "native";
  for (let i = STRUCTURED_MODES.indexOf(first); i < STRUCTURED_MODES.length; i++) {
    const mode = STRUCTURED_MODES[i]!;
    try {
      const output = await runMode(mode, c);
      capabilityCache.set(key, mode);
      return { output, mode };
    } catch (e) {
      // Native output that is accepted but unusable twice: give the forced tool call one chance (not
      // cached unless it works). Invalid answers in tool / json mode are final.
      if (mode === "native" && isAiConfigError(e) && e.code === "AI_STRUCTURED_OUTPUT_INVALID") {
        console.warn(`[ai] ${key}: native structured output gave no valid answer twice; trying tool mode`);
        continue;
      }
      if (mode === "json" || !isCapabilityError(e, mode)) throw e;
      capabilityCache.set(key, STRUCTURED_MODES[i + 1]!);
      // Operator signal (no prompt or key material): which mode this model ends up on.
      console.warn(`[ai] ${key}: ${mode} structured output rejected by the provider; trying ${STRUCTURED_MODES[i + 1]} mode`);
    }
  }
  throw new Error("unreachable");
}
