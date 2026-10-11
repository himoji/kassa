import { APICallError } from "@ai-sdk/provider";
import { RetryError, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

import type { Env } from "./registry.ts";

/*
 * Provider retries for 429 / 5xx (shared upstream pools such as OpenRouter's free tier throttle often).
 * The AI SDK's own retry is fixed at 2 s × 2ⁿ without jitter, so every model call site passes
 * `maxRetries: 0` (SDK_MAX_RETRIES) and live models are wrapped with this middleware instead:
 *   - retried: APICallError.isRetryable (408, 409, 429, 5xx, network failures), up to AI_MAX_RETRIES (default 5);
 *   - delay: Retry-After / retry-after-ms when present and ≤ 60 s (RFC 9110 §10.2.3), else exponential
 *     backoff with "equal jitter" (base·2ⁿ, half fixed + half random, capped), AWS Architecture Blog
 *     "Exponential Backoff and Jitter" (2015);
 *   - only the request is retried (doGenerate / opening doStream); a stream that fails midway is not.
 */

export const DEFAULT_AI_MAX_RETRIES = 5;
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 20_000;
const MAX_RETRY_AFTER_MS = 60_000;

/** Pass to generateText / streamText: retries happen in retryMiddleware, not twice. */
export const SDK_MAX_RETRIES = 0;

export function aiMaxRetries(env: Env = process.env): number {
  const raw = env.AI_MAX_RETRIES?.trim();
  if (!raw) return DEFAULT_AI_MAX_RETRIES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 20) : DEFAULT_AI_MAX_RETRIES;
}

/** The provider error behind an SDK error (RetryError keeps the last attempt's error). */
export function apiCallErrorOf(e: unknown): APICallError | null {
  if (APICallError.isInstance(e)) return e;
  if (RetryError.isInstance(e)) return apiCallErrorOf(e.lastError);
  const cause = (e as { cause?: unknown } | null)?.cause;
  return cause && cause !== e ? apiCallErrorOf(cause) : null;
}

export function isRetryableAiError(e: unknown): boolean {
  return apiCallErrorOf(e)?.isRetryable === true;
}

/** Server-requested delay (retry-after-ms, then Retry-After seconds or HTTP-date), if usable. */
export function retryAfterMs(e: unknown, nowMs = Date.now()): number | null {
  const h = apiCallErrorOf(e)?.responseHeaders;
  if (!h) return null;
  const get = (k: string) => Object.entries(h).find(([name]) => name.toLowerCase() === k)?.[1];
  let ms: number | null = null;
  const msHeader = get("retry-after-ms");
  if (msHeader && !Number.isNaN(parseFloat(msHeader))) ms = parseFloat(msHeader);
  const after = get("retry-after");
  if (ms === null && after) {
    const secs = Number(after.trim());
    ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(after) - nowMs;
  }
  return ms !== null && Number.isFinite(ms) && ms >= 0 && ms <= MAX_RETRY_AFTER_MS ? ms : null;
}

/** Delay before retry number `attempt` (0-based). `random` ∈ [0, 1). */
export function backoffDelayMs(attempt: number, error: unknown, random: () => number = Math.random): number {
  const server = retryAfterMs(error);
  if (server !== null) return server;
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}

export interface RetryOptions {
  maxRetries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

async function withRetry<T>(call: () => PromiseLike<T>, signal: AbortSignal | undefined, o: RetryOptions): Promise<T> {
  const max = o.maxRetries ?? aiMaxRetries();
  const sleep = o.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= max || !isRetryableAiError(e) || signal?.aborted) throw e;
      const delayMs = backoffDelayMs(attempt, e, o.random);
      o.onRetry?.({ attempt: attempt + 1, delayMs, error: e });
      await sleep(delayMs, signal);
    }
  }
}

export function retryMiddleware(o: RetryOptions = {}): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    wrapGenerate: ({ doGenerate, params }) => withRetry(doGenerate, params.abortSignal, o),
    wrapStream: ({ doStream, params }) => withRetry(doStream, params.abortSignal, o),
  };
}

/** Wrap a model with provider retries (models.ts does this for every live model). */
export function withRetries(model: LanguageModel, o: RetryOptions = {}): LanguageModel {
  if (typeof model === "string") return model;
  return wrapLanguageModel({ model: model as Exclude<LanguageModel, string>, middleware: retryMiddleware(o) });
}
