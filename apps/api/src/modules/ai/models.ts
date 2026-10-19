import type { LanguageModel } from "ai";

import { AiConfigError } from "./errors.ts";
import { aiMaxRetries, aiStreamMaxRetries, withRetries } from "./retry.ts";
import { assertProviderKey, createRegistry, parseModelSpec, type Env, type KassaRegistry, type ModelSpec } from "./registry.ts";

/** Spec §3 roles, defaults from docs/architecture/decisions.md (provider-agnostic LLM). */
export const DEFAULT_PLANNER_MODEL = "openrouter:deepseek/deepseek-v4.1-flash-1017";
export const DEFAULT_READER_MODEL = "openrouter:deepseek/deepseek-v4.1-flash-1017";

let cached: { env: Env; registry: KassaRegistry } | null = null;

function registryFor(env: Env): KassaRegistry {
  if (!cached || cached.env !== env) cached = { env, registry: createRegistry(env) };
  return cached.registry;
}

/** A bare model id (no `provider:` prefix) is an OpenRouter model id. */
function normalizeSpec(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  if (!v) return fallback;
  return v.includes(":") ? v : `openrouter:${v}`;
}

export function plannerSpec(env: Env = process.env): ModelSpec {
  return parseModelSpec(normalizeSpec(env.PLANNER_MODEL, DEFAULT_PLANNER_MODEL), "PLANNER_MODEL");
}

export function readerSpec(env: Env = process.env): ModelSpec {
  return parseModelSpec(normalizeSpec(env.READER_MODEL, DEFAULT_READER_MODEL), "READER_MODEL");
}

function resolve(spec: ModelSpec, env: Env): LanguageModel {
  assertProviderKey(spec, env);
  // The registry's inferred id type is a union of literal ids; specs are validated by parseModelSpec.
  const registry = registryFor(env);
  const languageModel = registry.languageModel.bind(registry) as (id: string) => LanguageModel;
  // 429 / 5xx retries with backoff + jitter (ai/retry.ts; fewer for streamed calls); call sites pass maxRetries: 0 to the SDK.
  return withRetries(languageModel(spec.id), { maxRetries: aiMaxRetries(env), streamMaxRetries: aiStreamMaxRetries(env) });
}

/** Planner (agent loop, onboarding). Throws AiConfigError if the provider key is missing. */
export function getPlannerModel(env: Env = process.env): LanguageModel {
  return resolve(plannerSpec(env), env);
}

/** Reader (untrusted content, no tools). Throws AiConfigError if the provider key is missing. */
export function getReaderModel(env: Env = process.env): LanguageModel {
  return resolve(readerSpec(env), env);
}

/**
 * Whether the reader model accepts image input. The AI SDK has no capability flag, so: local
 * OpenAI-compatible endpoints are assumed text-only unless LOCAL_VISION=true; READER_VISION=false
 * disables vision for any provider. Callers throw AI_VISION_UNSUPPORTED when this is false.
 */
export function readerSupportsVision(env: Env = process.env): boolean {
  if (env.READER_VISION?.toLowerCase() === "false") return false;
  const { provider } = readerSpec(env);
  if (provider === "local" || provider === "ollama") return env.LOCAL_VISION?.toLowerCase() === "true";
  return true;
}

export function assertReaderVision(env: Env = process.env): void {
  if (!readerSupportsVision(env)) {
    throw new AiConfigError(
      "AI_VISION_UNSUPPORTED",
      `READER_MODEL "${readerSpec(env).id}" has no image input. Upload a PDF/text, or set LOCAL_VISION=true if your local model supports vision.`,
      { model: readerSpec(env).id },
    );
  }
}
