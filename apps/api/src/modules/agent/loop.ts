import { isStepCount, streamText, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware, type ModelMessage, type StopCondition, type ToolSet, type UIMessageChunk } from "ai";

import type { AgentMode } from "@kassa/shared";

import { getPlannerModel, plannerSpec } from "../ai/models.ts";
import { SDK_MAX_RETRIES } from "../ai/retry.ts";
import { redactionMiddleware } from "./middleware.ts";
import type { AgentPorts } from "./ports.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { Redactor, PLACEHOLDER_RE, type KnownName, type PlaceholderEntry } from "./redact.ts";
import { replayModel, selectTurn, StepRecorder } from "./replay.ts";
import { buildTools, MAX_TOOL_STEPS, type ToolContext } from "./tools.ts";
import type { ReaderResult } from "../reader/index.ts";

/*
 * One planner turn (spec §9): ≤ 8 tool rounds, then a final text step. If a tool returns REFUSE or a
 * COOLING payee, the next step gets no tools (explain plainly) and the loop stops.
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
}

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
}

/** Recordings that belong to other channels (POST /onboarding/message), never picked by the agent chat. */
const ONBOARDING_ONLY = ["onboarding"];

export async function knownNames(ports: AgentPorts): Promise<KnownName[]> {
  const [profile, payees] = await Promise.all([ports.profile(), ports.payees()]);
  return [
    { name: profile.displayName, kind: "PERSON", ref: profile.displayName, personal: true },
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
  const [history, existing, names, payees] = await Promise.all([o.store.history(), o.store.placeholders(), knownNames(o.ports), o.ports.payees()]);
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
  };
  const tools = buildTools(ctx);

  // Model: injected (tests) → REPLAY recording → live planner from the registry.
  let base: LanguageModel;
  let recordedWith = "injected";
  if (o.model) base = o.model;
  else if (o.mode === "REPLAY") {
    const priorUserTurns = history.filter((m) => m.role === "user").length;
    base = replayModel(selectTurn(redactedText, { scenario: o.scenario, priorUserTurns, exclude: ONBOARDING_ONLY }).turn, { chunkDelayInMs: o.replayChunkDelayMs ?? 12 });
    recordedWith = "replay";
  } else {
    base = getPlannerModel();
    recordedWith = plannerSpec().id;
  }
  const recorder = o.record && o.mode === "LIVE" && !o.model ? new StepRecorder() : null;
  const middleware: LanguageModelMiddleware[] = [redactionMiddleware(redactor), ...(recorder ? [recorder.middleware()] : [])];
  const model = typeof base === "string" ? base : wrapLanguageModel({ model: base as Exclude<LanguageModel, string>, middleware });

  let stopAtStep: number | null = null;
  const stopAfterExplanation: StopCondition<ToolSet> = ({ steps }) => stopAtStep !== null && steps.length > stopAtStep;

  const result = streamText({
    model,
    instructions: SYSTEM_PROMPT,
    messages: [...history, userMsg],
    tools,
    // Live models retry 429 / 5xx themselves (ai/retry.ts: AI_MAX_RETRIES, backoff + jitter, Retry-After).
    maxRetries: SDK_MAX_RETRIES,
    stopWhen: [isStepCount(MAX_TOOL_STEPS + 1), stopAfterExplanation],
    prepareStep: ({ stepNumber }) => {
      if (ctx.stop.requested && stopAtStep === null) stopAtStep = stepNumber;
      // After REFUSE / COOLING, or once 8 tool rounds are used: text only.
      if (stopAtStep !== null || stepNumber >= MAX_TOOL_STEPS) return { activeTools: [], toolChoice: "none" as const };
      return {};
    },
    ...(o.abortSignal ? { abortSignal: o.abortSignal } : {}),
  });

  const payeeNames = new Map(payees.map((p) => [p.id, p.name]));
  const uiStream = result
    .toUIMessageStream({
      messageMetadata: ({ part }) => (part.type === "start" ? { replay: o.mode === "REPLAY" && !o.model } : undefined),
      onError: (e) => (e instanceof Error && "code" in e ? `${(e as { code: string }).code}: ${e.message}` : "The assistant could not answer. Please try again."),
    })
    .pipeThrough(rehydrateStream(redactor, payeeNames));

  const done = (async (): Promise<TurnSummary> => {
    // responseMessages = every step's assistant + tool messages (result.response is the last step only).
    const [responseMessages, steps, text] = await Promise.all([result.responseMessages, result.steps, result.text]);
    await o.store.saveMessages([userMsg, ...responseMessages]);
    await o.store.savePlaceholders(redactor.drainNew());
    const recordedTo = recorder ? recorder.save(o.scenario ?? redactedText, redactedText, recordedWith) : null;
    return {
      steps: steps.length,
      toolCalls: steps.flatMap((s) => s.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input }))),
      stopped: stopAtStep !== null,
      text,
      recordedTo,
    };
  })();
  // Avoid unhandled rejections when the caller only consumes the stream; errors surface via the stream.
  done.catch(() => undefined);
  return { uiStream, done, ctx };
}

export { PLACEHOLDER_RE };
