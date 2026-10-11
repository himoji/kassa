import { apiCallErrorOf } from "./retry.ts";

/**
 * Typed AI configuration / capability errors. `code` is stable and machine-readable; routes map it to
 * an RFC 9457 problem body (`ApiError.code`).
 */
export type AiErrorCode =
  | "AI_MODEL_SPEC_INVALID"
  | "AI_PROVIDER_UNKNOWN"
  | "AI_PROVIDER_KEY_MISSING"
  | "AI_VISION_UNSUPPORTED"
  | "AI_REPLAY_MISSING"
  /** The model's answer failed schema validation twice (ai/structured.ts). */
  | "AI_STRUCTURED_OUTPUT_INVALID"
  /** The provider failed (rate limit after all retries, 5xx, auth, bad request); details carry the status. */
  | "AI_PROVIDER_UNAVAILABLE";

export class AiConfigError extends Error {
  readonly code: AiErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: AiErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AiConfigError";
    this.code = code;
    this.details = details;
  }
}

export function isAiConfigError(e: unknown): e is AiConfigError {
  return e instanceof AiConfigError;
}

/**
 * Wrap a provider failure (APICallError, RetryError, NoOutputGeneratedError, …) in a typed, actionable
 * AiConfigError. The provider's response body is not copied into the message (it may echo the prompt).
 */
export function aiProviderFailure(e: unknown, role: "planner" | "reader", statusCode?: number): AiConfigError {
  if (isAiConfigError(e)) return e;
  const status = statusCode ?? apiCallErrorOf(e)?.statusCode;
  const hint =
    status === 429
      ? "The model provider is rate limiting (HTTP 429) even after retries; try again shortly or raise AI_MAX_RETRIES."
      : status === 401 || status === 403
        ? "The model provider rejected the API key; check the key for this provider."
        : status !== undefined && status >= 500
          ? `The model provider failed (HTTP ${status}); try again shortly.`
          : status !== undefined
            ? `The model provider rejected the request (HTTP ${status}); check ${role === "planner" ? "PLANNER_MODEL" : "READER_MODEL"} (or set AI_STRUCTURED_MODE=tool|json).`
            : apiCallErrorOf(e)
              ? "The model provider could not be reached; check the base URL / network, or switch to AGENT_MODE=REPLAY."
              : `The model's answer could not be used (${(e as Error | null)?.name ?? "unknown error"}); try again, or set AI_STRUCTURED_MODE=tool|json.`;
  return new AiConfigError("AI_PROVIDER_UNAVAILABLE", hint, { role, ...(status !== undefined ? { status } : {}), cause: (e as Error | null)?.name ?? "unknown", causeMessage: String((e as Error | null)?.message ?? "").slice(0, 200) });
}
