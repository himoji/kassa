import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";

/*
 * Time budget of one planner turn, so a turn always ends with an answer in bounded time (a reasoning model on a busy
 * shared pool can think for minutes, and a stalled provider stream never ends on its own; the serverless function
 * stops at 300 s and the client gives up before that).
 *
 *   start ── tool rounds ── wrapUpAt ── text-only step ── answerBy ── final answer step ── deadline
 *
 *   - tool rounds run until `wrapUpAt`; a step that starts later gets no tools (loop.ts prepareStep);
 *   - every model call is cut (timeoutMiddleware) when it shows no content (text or a tool call) within `stepMs`,
 *     when no chunk at all arrives for `idleMs`, or at `answerBy` (at `deadline` once its answer text is streaming);
 *   - a cut turn gets one more text-only call bounded by `deadline` (the final answer step), and when that fails too
 *     a code-written summary of the tool results (summary.ts). Tools themselves are never interrupted.
 */

export interface TurnBudget {
  /** Whole turn: the answer is complete by then. AGENT_TURN_TIMEOUT_MS, default 75 s. */
  turnMs: number;
  /** One model call: time until its first text or tool call (reasoning, queueing, retries). AGENT_STEP_TIMEOUT_MS, default 30 s. */
  stepMs: number;
  /** One model call: longest gap between two stream chunks of any kind. AGENT_CHUNK_TIMEOUT_MS, default 20 s. */
  idleMs: number;
  /** Kept for the final answer step at the end of the turn. Default 20 % of turnMs, 5–20 s. */
  finalMs: number;
  /** Text-only time before `answerBy`: no new tool round starts later than this. Default 25 % of turnMs, 5–25 s. */
  wrapUpMs: number;
}

export const DEFAULT_TURN_MS = 75_000;
export const DEFAULT_STEP_MS = 30_000;
export const DEFAULT_IDLE_MS = 20_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function msFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const v = raw?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? Math.min(n, max) : fallback;
}

/** The budget from the environment, with per-call overrides (tests). */
export function turnBudget(override: Partial<TurnBudget> = {}, env: Record<string, string | undefined> = process.env): TurnBudget {
  const turnMs = override.turnMs ?? msFromEnv(env.AGENT_TURN_TIMEOUT_MS, DEFAULT_TURN_MS, 10_000, 280_000);
  const stepMs = override.stepMs ?? msFromEnv(env.AGENT_STEP_TIMEOUT_MS, DEFAULT_STEP_MS, 5_000, 280_000);
  const idleMs = override.idleMs ?? msFromEnv(env.AGENT_CHUNK_TIMEOUT_MS, DEFAULT_IDLE_MS, 2_000, 280_000);
  const finalMs = override.finalMs ?? clamp(Math.round(turnMs * 0.2), 5_000, 20_000);
  const wrapUpMs = override.wrapUpMs ?? clamp(Math.round(turnMs * 0.25), 5_000, 25_000);
  return { turnMs, stepMs, idleMs, finalMs, wrapUpMs };
}

export interface TurnClock {
  readonly startedAt: number;
  /** The turn's answer is complete by then. */
  readonly deadline: number;
  /** The tool loop's last model call ends by then; the rest is kept for the final answer step. */
  readonly answerBy: number;
  /** No tool round starts after this. */
  readonly wrapUpAt: number;
  now(): number;
}

export function turnClock(b: TurnBudget, now: () => number = Date.now): TurnClock {
  const startedAt = now();
  const deadline = startedAt + b.turnMs;
  const answerBy = deadline - b.finalMs;
  return { startedAt, deadline, answerBy, wrapUpAt: Math.max(startedAt, answerBy - b.wrapUpMs), now };
}

export type TimeoutKind = "step" | "idle" | "deadline";

/** A model call cut by the turn budget (never a provider error). */
export class TurnTimeoutError extends Error {
  readonly code = "AGENT_TURN_TIMEOUT";
  constructor(
    readonly kind: TimeoutKind,
    readonly afterMs: number,
  ) {
    super(kind === "step" ? `The model showed no answer within ${afterMs} ms` : kind === "idle" ? `The model stream stalled for ${afterMs} ms` : `The turn's time budget ran out after ${afterMs} ms`);
    this.name = "TurnTimeoutError";
  }
}

/** The TurnTimeoutError behind an SDK error (the SDK may wrap the stream's error). */
export function turnTimeoutOf(e: unknown): TurnTimeoutError | null {
  for (let cur = e, depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof TurnTimeoutError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export interface TimeoutOptions {
  stepMs: number;
  idleMs: number;
  /** Absolute end of a call, by whether its answer text has started streaming. */
  deadline: (textStarted: boolean) => number;
  now?: () => number;
}

/** Content that answers (resets nothing by itself, but ends the `stepMs` wait). */
const isContent = (p: LanguageModelV4StreamPart) => (p.type === "text-delta" && p.delta.length > 0) || p.type === "tool-input-start" || p.type === "tool-call";

/**
 * Bounds every streamed model call (see the header). The call's own abort signal is combined with ours, so the
 * provider request, the retry middleware's backoff sleeps and the stream all stop; the stream errors with
 * TurnTimeoutError even when the provider ignores the abort.
 */
export function timeoutMiddleware(o: TimeoutOptions): LanguageModelMiddleware {
  const now = o.now ?? Date.now;
  return {
    specificationVersion: "v4",
    wrapStream: async ({ params, model }) => {
      const t0 = now();
      const ac = new AbortController();
      const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, ac.signal]) : ac.signal;
      let textStarted = false;
      let content = false;
      let ended = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ctl: TransformStreamDefaultController<LanguageModelV4StreamPart> | null = null;
      let rejectOpen: (e: unknown) => void = () => undefined;
      const opening = new Promise<never>((_, reject) => (rejectOpen = reject));
      opening.catch(() => undefined);

      const stop = () => {
        ended = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
      const fire = (kind: TimeoutKind) => {
        if (ended) return;
        stop();
        const err = new TurnTimeoutError(kind, now() - t0);
        if (ctl) {
          try {
            ctl.error(err);
          } catch {
            // already closed
          }
        } else rejectOpen(err);
        ac.abort(err);
      };
      const arm = () => {
        if (ended) return;
        if (timer !== undefined) clearTimeout(timer);
        const t = now();
        const limits: Array<[number, TimeoutKind]> = [
          [o.deadline(textStarted) - t, "deadline"],
          [o.idleMs, "idle"],
        ];
        if (!content) limits.push([t0 + o.stepMs - t, "step"]);
        const [ms, kind] = limits.reduce((a, b) => (b[0] < a[0] ? b : a));
        timer = setTimeout(() => fire(kind), Math.max(0, ms));
      };
      params.abortSignal?.addEventListener("abort", stop, { once: true });
      arm();

      let opened: Awaited<ReturnType<typeof model.doStream>>;
      try {
        opened = await Promise.race([model.doStream({ ...params, abortSignal: signal }), opening]);
      } catch (e) {
        stop();
        throw e;
      }
      arm();
      const stream = opened.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          start(c) {
            ctl = c;
          },
          transform(part, c) {
            if (isContent(part)) {
              content = true;
              if (part.type === "text-delta") textStarted = true;
            }
            c.enqueue(part);
            arm();
          },
          flush() {
            stop();
          },
        }),
      );
      return { ...opened, stream };
    },
  };
}
