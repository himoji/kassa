import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createProviderRegistry } from "ai";

import { AiConfigError } from "./errors.ts";

/*
 * Provider-agnostic model registry (docs/DECISIONS.md 2026-10-10 "Provider-agnostic LLM via the Vercel
 * AI SDK"). Models are addressed as `provider:model`; the registry splits on the FIRST `:` so local
 * model ids such as `local:llama3.1:8b` work.
 */

export const PROVIDER_IDS = ["openai", "google", "openrouter", "local", "ollama"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Env var holding each provider's API key. `null` = no key needed (local endpoints). */
export const PROVIDER_KEY_ENV: Record<ProviderId, string | null> = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  local: null,
  ollama: null,
};

/** Ollama's OpenAI-compatible endpoint; LM Studio users set LOCAL_BASE_URL=http://localhost:1234/v1. */
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";

/** OpenRouter's OpenAI-compatible endpoint (https://openrouter.ai/docs/api-reference/overview). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type Env = Record<string, string | undefined>;

export interface ModelSpec {
  provider: ProviderId;
  modelId: string;
  /** The original `provider:model` string. */
  id: string;
}

export function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

/** Parse and validate a `provider:model` string. Throws AiConfigError with a clear message. */
export function parseModelSpec(spec: string | undefined, envName = "model"): ModelSpec {
  const raw = (spec ?? "").trim();
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new AiConfigError(
      "AI_MODEL_SPEC_INVALID",
      `${envName}="${raw}" must look like "provider:model" (provider one of ${PROVIDER_IDS.join(", ")})`,
      { envName, value: raw },
    );
  }
  const provider = raw.slice(0, idx);
  const modelId = raw.slice(idx + 1);
  if (!isProviderId(provider)) {
    throw new AiConfigError(
      "AI_PROVIDER_UNKNOWN",
      `${envName}: unknown provider "${provider}" (expected one of ${PROVIDER_IDS.join(", ")})`,
      { envName, provider },
    );
  }
  return { provider, modelId, id: raw };
}

/**
 * OPENROUTER_API_KEY, else LOCAL_API_KEY when LOCAL_BASE_URL already points at OpenRouter (the same key
 * already goes to the same host, so `openrouter:` and `local:` configs are interchangeable).
 */
export function openRouterKey(env: Env): string | undefined {
  const own = env.OPENROUTER_API_KEY?.trim();
  if (own) return own;
  let host = "";
  try {
    host = new URL(env.LOCAL_BASE_URL?.trim() ?? "").hostname;
  } catch {
    host = "";
  }
  return host === new URL(OPENROUTER_BASE_URL).hostname ? env.LOCAL_API_KEY?.trim() || undefined : undefined;
}

/** Throws AiConfigError("AI_PROVIDER_KEY_MISSING") when the provider needs a key that is not set. */
export function assertProviderKey(spec: ModelSpec, env: Env): void {
  const keyEnv = PROVIDER_KEY_ENV[spec.provider];
  const present = spec.provider === "openrouter" ? !!openRouterKey(env) : !!env[keyEnv ?? ""]?.trim();
  if (keyEnv && !present) {
    throw new AiConfigError(
      "AI_PROVIDER_KEY_MISSING",
      `Model "${spec.id}" needs ${keyEnv} to be set. Set it, switch provider, or run with AGENT_MODE=REPLAY.`,
      { provider: spec.provider, keyEnv },
    );
  }
}

export function createRegistry(env: Env) {
  const local = createOpenAICompatible({
    name: "local",
    baseURL: env.LOCAL_BASE_URL?.trim() || DEFAULT_LOCAL_BASE_URL,
    ...(env.LOCAL_API_KEY ? { apiKey: env.LOCAL_API_KEY } : {}),
    // Ollama and LM Studio both implement OpenAI `response_format: json_schema`.
    supportsStructuredOutputs: true,
  });
  // OpenRouter: an alias for an OpenAI-compatible endpoint with its own key. Many of its models reject
  // response_format; ai/structured.ts falls back to a forced tool call or JSON text for those.
  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: OPENROUTER_BASE_URL,
    ...(openRouterKey(env) ? { apiKey: openRouterKey(env) } : {}),
    supportsStructuredOutputs: true,
  });
  return createProviderRegistry({
    openai: createOpenAI({ apiKey: env.OPENAI_API_KEY }),
    google: createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY }),
    openrouter,
    local,
    ollama: local,
  });
}

export type KassaRegistry = ReturnType<typeof createRegistry>;
