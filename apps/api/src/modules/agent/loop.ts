import { randomUUID } from "node:crypto";

import { isStepCount, streamText, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware, type ModelMessage, type StepResult, type StopCondition, type ToolSet, type UIMessageChunk } from "ai";

import type { AgentMode } from "@kassa/shared";

import { AiConfigError } from "../ai/errors.ts";
import { newFallbackState, replayFallbackEnabled, withReplayFallback } from "../ai/fallback.ts";
import { getPlannerModel, plannerSpec } from "../ai/models.ts";
import { SDK_MAX_RETRIES } from "../ai/retry.ts";
import { timeoutMiddleware, turnBudget, turnClock, turnTimeoutOf, type TurnBudget } from "./budget.ts";
import { redactionMiddleware } from "./middleware.ts";
import type { AgentPorts } from "./ports.ts";
import { BUSINESS_PROMPT, SYSTEM_PROMPT } from "./prompt.ts";
import { Redactor, PLACEHOLDER_RE, type KnownName, type PlaceholderEntry } from "./redact.ts";
import { replayModel, selectTurn, StepRecorder } from "./replay.ts";
import { fallbackAnswer, type ProposalOutcome, type ToolOutcome } from "./summary.ts";
import { orderFactsStream } from "./turn-summary.ts";
import { buildTools, DRAFT_TOOLS, MAX_TOOL_CALLS, MAX_TOOL_STEPS, UI_TOOLS, WRITE_TOOLS, type ToolContext } from "./tools.ts";
import type { ReaderResult } from "../reader/index.ts";

/*
 * One planner turn (spec §9): ≤ 8 tool rounds (MAX_TOOL_STEPS) and ≤ MAX_TOOL_CALLS tool calls, then a final
 * text step. If a tool returns REFUSE or a COOLING payee, the next step gets no tools (explain plainly) and the loop
 * stops. The model's reasoning never reaches the client stream (only its answer text and the cards).
 *
 * The turn is also bounded in time (budget.ts): no tool round starts after the wrap-up point, and a model call that
 * stalls is cut. A turn that was cut, or that ended without answer text (and without a picker on screen), gets one
 * text-only "final answer" call over the tool results so far; if that fails too, a code-written summary of the tool
 * results and proposals (summary.ts). Cards a tool emitted before the cut stay on screen: they are written directly.
 */

export interface TurnStore {
  history(): Promise<ModelMessage[]>;
  placeholders(): Promise<PlaceholderEntry[]>;
  saveMessages(messages: ModelMessage[]): Promise<void>;
  savePlaceholders(entries: PlaceholderEntry[]): Promise<void>;
  /** Reader results of documents already read in this conversation. */
  readDocs?(): Promise<Map<string, ReaderResult>>;
}

export interface TurnOptions {
  ports: AgentPorts;
  store: TurnStore;
  text: string;
  mode: AgentMode;
  /** Replay / record scenario name. */
  scenario?: string | undefined;
  record?: boolean;
  /** Inject a model (tests). Bypasses LIVE/REPLAY selection. */
  model?: LanguageModel;
  emit: (chunk: UIMessageChunk) => void;
  abortSignal?: AbortSignal;
  replayChunkDelayMs?: number;
  /**
   * A channel that only holds a Shortcut key (POST /capture/voice): no propose_order or purchase-order draft, so the
   * key keeps its one power (logging spending), and no pickers, which a Shortcut cannot show. Reading, advice and
   * log_expense stay.
   */
  readOnly?: boolean;
  /** Time budget overrides (tests); defaults from the environment (budget.ts). */
  budget?: Partial<TurnBudget>;
}

/** Tools a read-only turn never gets (TurnOptions.readOnly). */
const NOT_READ_ONLY: readonly string[] = [...WRITE_TOOLS, ...DRAFT_TOOLS, ...UI_TOOLS];

export const READ_ONLY_PROMPT = `This message was spoken into the user's iPhone Shortcut and your answer is read aloud or shown as one notification. Answer in at most three short sentences, plain text, no Markdown or lists. In this channel you cannot propose or make payments: when the user asks to pay or send money, say what you found and tell them to open Kassa to pay it. You can still log a purchase they describe with log_expense.`;

export interface TurnHandle {
  /** UI message stream of the model output (text rehydrated for the user). */
  uiStream: ReadableStream<UIMessageChunk>;
  /** Resolves after the turn is persisted. */
  done: Promise<TurnSummary>;
  ctx: ToolContext;
}

export interface TurnSummary {
  steps: number;
  toolCalls: Array<{ toolName: string; input: unknown }>;
  stopped: boolean;
  text: string;
  recordedTo: string | null;
  /**
   * How the answer was produced: by the tool loop itself, by the final answer call after the loop was cut or ended
   * without text, or by code (summary.ts) when that call failed too.
   */
  answeredBy: "model" | "final-step" | "summary";
  /** Why the tool loop did not answer by itself (null when it did). */
  cutoff: "step" | "idle" | "deadline" | "no-text" | "error" | null;
  elapsedMs: number;
}

/** Appended to the instructions of the final answer call (and of a tool-loop step that starts after the wrap-up point). */
export const FINAL_ANSWER_PROMPT = `Time is up for this turn: do not call tools. Answer the user now, in a few short sentences, from the tool results above: what you found, and for each payment proposal created in this turn what it is and its decision (its card is already shown to the user). If something is still unknown, say what to ask next.`;

/** Recordings that belong to other channels (POST /onboarding/message), never picked by the agent chat. */
const ONBOARDING_ONLY = ["onboarding"];

export async function knownNames(ports: AgentPorts): Promise<KnownName[]> {
  const [profile, payees] = await Promise.all([ports.profile(), ports.payees()]);
  return [
    { name: profile.displayName, kind: "PERSON", ref: profile.displayName, personal: true },
    // People who send the user money (profile incomes, imported history) reach the planner as person_N.
    ...[...new Set([...profile.incomes.map((i) => i.source), ...(profile.moneyHistory?.incomes ?? []).map((i) => i.source)])]
      .filter((n) => /^\p{Lu}[\p{L}'-]+\s+\p{Lu}[\p{L}.'-]*$/u.test(n.trim()))
      .map((name) => ({ name, kind: "PERSON" as const, ref: name })),
    // Only natural persons (PERSON, OWN_ACCOUNT) get token matching; redact.ts enforces that for organisations.
    // VERIFIED payees first: a name shared by several payees (an account change, I7) resolves to the verified one
    // when the text gives no other context (redact.ts RedactContext).
    ...[...payees].sort((a, b) => Number(a.status !== "VERIFIED") - Number(b.status !== "VERIFIED")).map((p) => ({ name: p.name, kind: "PAYEE" as const, ref: p.id, payeeKind: p.kind, personal: p.kind === "PERSON" || p.kind === "OWN_ACCOUNT" })),
  ];
}

/** Restores payee/person names (and masks accounts) in streamed text for the user; never sent to a model. */
export function rehydrateStream(redactor: Redactor, payeeNames: Map<string, string>): TransformStream<UIMessageChunk, UIMessageChunk> {
  const pending = new Map<string, string>();
  const HOLD = /[a-z]+(?:_\d*(?:_\d*)?)?$/; // a placeholder may be split across deltas
  return new TransformStream({
    transform(chunk, ctl) {
      // Reasoning is the model's scratchpad: large, redacted and not for the user (also off in toUIMessageStream).
      if (chunk.type === "reasoning-start" || chunk.type === "reasoning-delta" || chunk.type === "reasoning-end") return;
      if (chunk.type === "text-delta") {
        const buf = (pending.get(chunk.id) ?? "") + chunk.delta;
        const m = HOLD.exec(buf);
        const cut = m && m[0].length <= 24 ? buf.length - m[0].length : buf.length;
        pending.set(chunk.id, buf.slice(cut));
        const ready = buf.slice(0, cut);
        if (ready) ctl.enqueue({ ...chunk, delta: redactor.rehydrateForUser(ready, payeeNames) });
        return;
      }
      if (chunk.type === "text-end") {
        const rest = pending.get(chunk.id);
        if (rest) ctl.enqueue({ type: "text-delta", id: chunk.id, delta: redactor.rehydrateForUser(rest, payeeNames) });
        pending.delete(chunk.id);
      }
      ctl.enqueue(chunk);
    },
  });
}

export async function startTurn(o: TurnOptions): Promise<TurnHandle> {
  const budget = turnBudget(o.budget);
  const clock = turnClock(budget);
  const [history, existing, names, payees, profile] = await Promise.all([o.store.history(), o.store.placeholders(), knownNames(o.ports), o.ports.payees(), o.ports.profile()]);
  // (M5) A BUSINESS account gets the business tool set and prompt section (when the ports provide them).
  const business = profile.accountType === "BUSINESS" && o.ports.business !== undefined;
  const redactor = new Redactor({ names, existing });
  const redactedText = redactor.redactText(o.text);
  const userMsg: ModelMessage = { role: "user", content: redactedText };

  const ctx: ToolContext = {
    ports: o.ports,
    redactor,
    emit: o.emit,
    readDocs: (await o.store.readDocs?.()) ?? new Map(),
    stop: { requested: false, reason: null },
    proposals: [],
    business,
    awaitingUser: null,
  };
  const all = buildTools(ctx);
  const tools = o.readOnly ? Object.fromEntries(Object.entries(all).filter(([name]) => !NOT_READ_ONLY.includes(name))) : all;

  // Model: injected (tests) → REPLAY recording → live planner from the registry, falling back to the recording when
  // the provider can't be used (ai/fallback.ts; the message is then labelled Replay).
  const priorUserTurns = history.filter((m) => m.role === "user").length;
  const recording = () => replayModel(selectTurn(redactedText, { scenario: o.scenario, priorUserTurns, exclude: ONBOARDING_ONLY }).turn, { chunkDelayInMs: o.replayChunkDelayMs ?? 12 });
  const recordingOrNull = () => {
    try {
      return recording();
    } catch {
      return null;
    }
  };
  const fallback = newFallbackState();
  let base: LanguageModel;
  let recordedWith = "injected";
  if (o.model) base = o.model;
  else if (o.mode === "REPLAY") {
    base = recording();
    recordedWith = "replay";
  } else {
    try {
      base = withReplayFallback(getPlannerModel(), recordingOrNull, fallback);
      recordedWith = plannerSpec().id;
    } catch (e) {
      // No key / bad model spec: serve the recording when there is one, else surface the configuration error.
      const r = e instanceof AiConfigError && replayFallbackEnabled() ? recordingOrNull() : null;
      if (!r) throw e;
      base = r;
      fallback.used = true;
      fallback.reason = (e as AiConfigError).code;
      recordedWith = "replay";
    }
  }
  const recorder = o.record && o.mode === "LIVE" && !o.model && recordedWith !== "replay" ? new StepRecorder() : null;
  /** The planner model, every call bounded by the budget (timeoutMiddleware is outermost: it bounds retries too). */
  const bounded = (deadline: (textStarted: boolean) => number): LanguageModel => {
    const middleware: LanguageModelMiddleware[] = [
      timeoutMiddleware({ stepMs: budget.stepMs, idleMs: budget.idleMs, deadline }),
      redactionMiddleware(redactor),
      ...(recorder ? [recorder.middleware()] : []),
    ];
    return typeof base === "string" ? base : wrapLanguageModel({ model: base as Exclude<LanguageModel, string>, middleware });
  };
  // A tool-loop call ends by answerBy, the rest is kept for the final answer call; once its answer text is streaming
  // it may run to the turn's deadline.
  const model = bounded((textStarted) => (textStarted ? clock.deadline : clock.answerBy));
  const instructions = [SYSTEM_PROMPT, ...(business ? [BUSINESS_PROMPT] : []), ...(o.readOnly ? [READ_ONLY_PROMPT] : [])].join("\n\n");

  let stopAtStep: number | null = null;
  let wrapUpStep: number | null = null;
  const stopAfterExplanation: StopCondition<ToolSet> = ({ steps }) => stopAtStep !== null && steps.length > stopAtStep;
  const stopAfterWrapUp: StopCondition<ToolSet> = ({ steps }) => wrapUpStep !== null && steps.length > wrapUpStep;
  // A picker (ask_*) is on screen: end the turn and wait for the user's answer.
  const stopForPicker: StopCondition<ToolSet> = () => Boolean(ctx.awaitingUser);
  // Steps completed before the latest step started (a step cut midway is not one of them), and the loop's error.
  let completed: { steps: Array<StepResult<ToolSet>>; messages: ModelMessage[] } = { steps: [], messages: [] };
  let loopError: unknown = null;
  const inflight = new Set<Promise<unknown>>();

  const result = streamText({
    model,
    instructions,
    messages: [...history, userMsg],
    tools: trackExecutions(tools, inflight),
    // Live models retry 429 / 5xx themselves (ai/retry.ts: AI_MAX_RETRIES, backoff + jitter, Retry-After).
    maxRetries: SDK_MAX_RETRIES,
    stopWhen: [isStepCount(MAX_TOOL_STEPS + 1), stopAfterExplanation, stopAfterWrapUp, stopForPicker],
    prepareStep: ({ stepNumber, steps, responseMessages }) => {
      completed = { steps: [...steps], messages: [...responseMessages] };
      if (ctx.stop.requested && stopAtStep === null) stopAtStep = stepNumber;
      // Past the wrap-up point no tool round starts: the model answers with what it has.
      if (stepNumber > 0 && (wrapUpStep !== null || clock.now() >= clock.wrapUpAt)) {
        wrapUpStep ??= stepNumber;
        return { activeTools: [], toolChoice: "none" as const, instructions: `${instructions}\n\n${FINAL_ANSWER_PROMPT}` };
      }
      // After REFUSE / COOLING, once 8 tool rounds are used, or once MAX_TOOL_CALLS tool calls ran: text only.
      const callsUsed = (ctx.toolCalls?.count ?? 0) >= MAX_TOOL_CALLS;
      if (stopAtStep !== null || stepNumber >= MAX_TOOL_STEPS || callsUsed) return { activeTools: [], toolChoice: "none" as const };
      return {};
    },
    onError: ({ error }) => {
      loopError ??= error;
    },
    ...(o.abortSignal ? { abortSignal: o.abortSignal } : {}),
  });

  const errorText = (e: unknown) => (e instanceof Error && "code" in e ? `${(e as { code: string }).code}: ${e.message}` : "The assistant could not answer. Please try again.");
  const loopUi = result.toUIMessageStream({
    sendReasoning: false,
    // The finish chunk is written below, once the turn has its answer.
    sendFinish: false,
    // `replay` is known at the start for REPLAY mode, and at the finish when a live turn fell back to a recording.
    messageMetadata: ({ part }) => (part.type === "start" ? { replay: (o.mode === "REPLAY" || fallback.used) && !o.model } : undefined),
    onError: errorText,
  });
  const finishChunk = (): UIMessageChunk => ({ type: "finish", ...(fallback.used ? { messageMetadata: { replay: true } } : {}) });

  const persist = async (messages: ModelMessage[]) => {
    await o.store.saveMessages([userMsg, ...messages]);
    await o.store.savePlaceholders(redactor.drainNew());
    return recorder && !fallback.used ? recorder.save(o.scenario ?? redactedText, redactedText, recordedWith) : null;
  };
  const summaryOf = (steps: Array<StepResult<ToolSet>>, text: string, recordedTo: string | null, extra: Pick<TurnSummary, "answeredBy" | "cutoff">): TurnSummary => ({
    steps: steps.length,
    toolCalls: steps.flatMap((s) => s.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input }))),
    stopped: stopAtStep !== null,
    text,
    recordedTo,
    ...extra,
    elapsedMs: clock.now() - clock.startedAt,
  });

  const run = async (out: ReadableStreamDefaultController<UIMessageChunk>): Promise<TurnSummary> => {
    const open = new OpenParts();
    let errorChunk: UIMessageChunk | null = null;
    let abortChunk: UIMessageChunk | null = null;
    try {
      for await (const c of loopUi) {
        if (c.type === "error") errorChunk = c;
        else if (c.type === "abort") abortChunk = c;
        else {
          open.track(c);
          out.enqueue(c);
        }
      }
    } catch (e) {
      // A cut model stream can surface here instead of as an error chunk.
      loopError ??= e;
    }
    const finished = await Promise.all([result.responseMessages, result.steps, result.text]).then(
      ([messages, steps, text]) => ({ messages, steps, text }),
      (e: unknown) => {
        loopError ??= e;
        return null;
      },
    );

    // The client went away: nothing more to say (nor to store, as before).
    if (o.abortSignal?.aborted) {
      if (abortChunk) out.enqueue(abortChunk);
      throw loopError ?? o.abortSignal.reason;
    }
    const steps = finished?.steps ?? completed.steps;
    const timeout = turnTimeoutOf(loopError);
    if (loopError && !timeout && completed.steps.length === 0 && ctx.proposals.length === 0) {
      // Nothing ran before the provider failed: the error is the answer (an AI configuration error tells how to fix it).
      if (errorChunk) out.enqueue(errorChunk);
      throw loopError;
    }
    const cutoff: TurnSummary["cutoff"] = loopError ? (timeout?.kind ?? "error") : !finished!.text.trim() && !ctx.awaitingUser ? "no-text" : null;
    if (cutoff === null) {
      out.enqueue(finishChunk());
      return summaryOf(steps, finished!.text, await persist(finished!.messages), { answeredBy: "model", cutoff: null });
    }

    // Cut or silent: close what the cut left open, let running tools settle (a proposal may be on its way), answer.
    open.close(out, "Stopped: this turn ran out of time.");
    await settle(inflight, Math.min(5_000, Math.max(0, clock.deadline - clock.now())));
    const prior = finished?.messages ?? completed.messages;
    const proposals: ProposalOutcome[] = ctx.proposals.map((p) => ({ summary: redactor.redactText(p.summary), decision: p.decision, reasonCodes: p.reasonCodes }));
    let answer: { text: string; messages: ModelMessage[]; by: TurnSummary["answeredBy"] } | null = null;
    if (clock.deadline - clock.now() >= Math.min(MIN_FINAL_MS, budget.finalMs / 2)) {
      const final = await finalAnswerCall(out, {
        model: bounded(() => clock.deadline),
        instructions: `${instructions}\n\n${FINAL_ANSWER_PROMPT}${proposalNote(proposals)}`,
        messages: [...history, userMsg, ...prior],
        errorText,
        abortSignal: o.abortSignal,
      });
      if (final) answer = { ...final, by: "final-step" };
    }
    if (o.abortSignal?.aborted) throw o.abortSignal.reason;
    if (!answer) {
      const text = fallbackAnswer(
        steps.flatMap((s) => s.toolResults.map((r) => ({ toolName: r.toolName, output: r.output }) satisfies ToolOutcome)),
        proposals,
        { timedOut: cutoff !== "no-text" },
      );
      const id = `summary-${randomUUID()}`;
      out.enqueue({ type: "text-start", id });
      out.enqueue({ type: "text-delta", id, delta: text });
      out.enqueue({ type: "text-end", id });
      answer = { text, messages: [{ role: "assistant", content: text }], by: "summary" };
    }
    out.enqueue(finishChunk());
    return summaryOf(steps, answer.text, await persist([...prior, ...answer.messages]), { answeredBy: answer.by, cutoff });
  };

  let resolveDone!: (s: TurnSummary) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<TurnSummary>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Avoid unhandled rejections when the caller only consumes the stream; errors surface via the stream.
  done.catch(() => undefined);
  const raw = new ReadableStream<UIMessageChunk>({
    start(out) {
      void run(out).then(
        (s) => {
          out.close();
          resolveDone(s);
        },
        (e: unknown) => {
          try {
            out.close();
          } catch {
            // already closed
          }
          rejectDone(e);
        },
      );
    },
  });

  const payeeNames = new Map(payees.map((p) => [p.id, p.name]));
  // (2026-10-18) after rehydration: the signed-order lines are server text with real names (turn-summary.ts).
  return { uiStream: raw.pipeThrough(rehydrateStream(redactor, payeeNames)).pipeThrough(orderFactsStream(ctx)), done, ctx };
}

/** Below this much time left, the final answer call is skipped for the code-written summary. */
const MIN_FINAL_MS = 3_000;

/** Proposals of this turn, for the final answer call (redacted: instructions are not redacted by the middleware). */
function proposalNote(proposals: readonly ProposalOutcome[]): string {
  if (proposals.length === 0) return "";
  return `\n\nPayment proposals created in this turn (each card is shown to the user):\n${proposals.map((p) => `- ${p.summary} Decision: ${p.decision}${p.reasonCodes.length ? ` (${p.reasonCodes.join(", ")})` : ""}.`).join("\n")}`;
}

/**
 * One text-only call over the tool results so far (no tools), streamed into `out`. Returns its answer, or null when
 * it failed, was cut or wrote nothing (anything it left open is closed).
 */
async function finalAnswerCall(
  out: ReadableStreamDefaultController<UIMessageChunk>,
  a: { model: LanguageModel; instructions: string; messages: ModelMessage[]; errorText: (e: unknown) => string; abortSignal: AbortSignal | undefined },
): Promise<{ text: string; messages: ModelMessage[] } | null> {
  let failed = false;
  const final = streamText({
    model: a.model,
    instructions: a.instructions,
    messages: a.messages,
    maxRetries: SDK_MAX_RETRIES,
    stopWhen: isStepCount(1),
    onError: () => {
      failed = true;
    },
    ...(a.abortSignal ? { abortSignal: a.abortSignal } : {}),
  });
  const open = new OpenParts();
  try {
    for await (const c of final.toUIMessageStream({ sendStart: false, sendFinish: false, sendReasoning: false, onError: a.errorText })) {
      if (c.type === "error" || c.type === "abort") continue;
      open.track(c);
      out.enqueue(c);
    }
  } catch {
    failed = true;
  }
  const r = await Promise.all([final.responseMessages, final.text]).catch(() => null);
  if (failed || !r || !r[1].trim()) {
    open.close(out, "Stopped: this turn ran out of time.");
    return null;
  }
  return { text: r[1], messages: r[0] };
}

/** UI parts a cut stream left open (text, tool calls, the step), so the client does not wait on them forever. */
class OpenParts {
  private readonly text = new Set<string>();
  private readonly tools = new Set<string>();
  private step = false;

  track(c: UIMessageChunk): void {
    switch (c.type) {
      case "text-start":
        this.text.add(c.id);
        break;
      case "text-end":
        this.text.delete(c.id);
        break;
      case "tool-input-start":
      case "tool-input-available":
        this.tools.add(c.toolCallId);
        break;
      case "tool-input-error":
      case "tool-output-available":
      case "tool-output-error":
      case "tool-output-denied":
        this.tools.delete(c.toolCallId);
        break;
      case "start-step":
        this.step = true;
        break;
      case "finish-step":
        this.step = false;
        break;
    }
  }

  close(out: ReadableStreamDefaultController<UIMessageChunk>, errorText: string): void {
    for (const id of this.text) out.enqueue({ type: "text-end", id });
    for (const toolCallId of this.tools) out.enqueue({ type: "tool-output-error", toolCallId, errorText });
    if (this.step) out.enqueue({ type: "finish-step" });
    this.text.clear();
    this.tools.clear();
    this.step = false;
  }
}

/** Tools whose running executions are kept in `inflight` (a cut turn waits for them before it answers). */
function trackExecutions(tools: ToolSet, inflight: Set<Promise<unknown>>): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const run = t.execute;
      if (!run) return [name, t];
      const execute: typeof run = (input, options) => {
        const p = Promise.resolve(run(input, options) as unknown);
        inflight.add(p);
        void p.then(
          () => inflight.delete(p),
          () => inflight.delete(p),
        );
        return p as ReturnType<typeof run>;
      };
      return [name, { ...t, execute }];
    }),
  );
}

/** Waits for `pending` to settle, at most `ms`. */
async function settle(pending: Set<Promise<unknown>>, ms: number): Promise<void> {
  if (pending.size === 0 || ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.allSettled([...pending]), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

export { PLACEHOLDER_RE };
