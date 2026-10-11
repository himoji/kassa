/**
 * Typed AI configuration / capability errors. `code` is stable and machine-readable; routes map it to
 * an RFC 9457 problem body (`ApiError.code`).
 */
export type AiErrorCode =
  | "AI_MODEL_SPEC_INVALID"
  | "AI_PROVIDER_UNKNOWN"
  | "AI_PROVIDER_KEY_MISSING"
  | "AI_VISION_UNSUPPORTED"
  | "AI_REPLAY_MISSING";

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
