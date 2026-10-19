import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { UIMessageChunk } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { timeoutMiddleware, turnBudget, TurnTimeoutError, type TurnBudget } from "../../src/modules/agent/budget.ts";
import { FINAL_ANSWER_PROMPT, startTurn } from "../../src/modules/agent/loop.ts";
import { stepChunks, type RecordedStep } from "../../src/modules/agent/replay.ts";
import { fallbackAnswer } from "../../src/modules/agent/summary.ts";
import { aiStreamMaxRetries } from "../../src/modules/ai/retry.ts";

import { drain, fakePorts, memoryStore, textOf } from "./fakes.ts";

/*
 * A turn always ends with an answer within its time budget (agent/budget.ts): a model that stalls, thinks without
 * answering, loops on tools or writes nothing is cut, then answered by a final text-only call, or by code.
 */

type Behaviour = RecordedStep | "stall" | "think" | "empty" | { slowTools: RecordedStep } | { whenTools: RecordedStep; otherwise: RecordedStep };

/** A model that plays `script`, one entry per model call (calls past the end stall). Stalls end only by abort. */
function scripted(script: Behaviour[]) {
  let i = 0;
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    provider: "test",
    modelId: "scripted",
    doStream: async (options) => {
      calls.push(options);
      const n = i++;
      const entry = script[n] ?? "stall";
      // A model that keeps calling tools while it has them.
      const b = typeof entry === "object" && "whenTools" in entry ? ((options.tools ?? []).length > 0 ? entry.whenTools : entry.otherwise) : entry;
      const signal = options.abortSignal;
      let timer: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(ctl) {
          const abort = () => {
            clearInterval(timer);
            try {
              ctl.error(signal?.reason ?? new Error("aborted"));
            } catch {
              // closed
            }
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (b === "stall") {
            ctl.enqueue({ type: "stream-start", warnings: [] });
            return;
          }
          if (b === "think") {
            // Reasoning chunks keep coming (no idle gap) but no answer ever does.
            ctl.enqueue({ type: "stream-start", warnings: [] });
            ctl.enqueue({ type: "reasoning-start", id: `r${n}` });
            timer = setInterval(() => ctl.enqueue({ type: "reasoning-delta", id: `r${n}`, delta: "hmm " }), 20);
            return;
          }
          if (b === "empty") {
            for (const c of stepChunks({}, n)) ctl.enqueue(c);
            ctl.close();
            return;
          }
          if ("slowTools" in b) {
            // The tool call arrives, then the stream hangs before its finish (the tool still runs).
            for (const c of stepChunks(b.slowTools, n).filter((c) => c.type !== "finish")) ctl.enqueue(c);
            return;
          }
          for (const c of stepChunks(b, n)) ctl.enqueue(c);
          ctl.close();
        },
      });
      return { stream };
    },
  });
  return { model, calls };
}

const FAST: Partial<TurnBudget> = { turnMs: 1_500, stepMs: 400, idleMs: 300, finalMs: 500, wrapUpMs: 300 };

async function runTurn(script: Behaviour[], budget: Partial<TurnBudget> = FAST, opts: Parameters<typeof fakePorts>[0] = {}) {
  const { ports, log } = fakePorts(opts);
  const { model, calls } = scripted(script);
  const emitted: UIMessageChunk[] = [];
  const store = memoryStore();
  const t0 = Date.now();
  const h = await startTurn({ ports, store, text: "Can I afford rent and tuition, cheapest way?", mode: "LIVE", model, emit: (c) => emitted.push(c), budget });
  const chunks = await drain(h.uiStream);
  const summary = await h.done;
  return { chunks, summary, calls, emitted, store, log, ms: Date.now() - t0 };
}

const OBLIGATIONS: RecordedStep = { toolCalls: [{ toolName: "get_obligations", input: {} }] };
const BALANCES: RecordedStep = { toolCalls: [{ toolName: "get_balances", input: {} }] };
const PROPOSE: RecordedStep = { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "payee_1", amountMinor: 240000, currency: "EUR", purpose: "Tuition" } }] };

function assertWellFormed(chunks: UIMessageChunk[]) {
  expect(chunks[0]?.type).toBe("start");
  expect(chunks.at(-1)?.type).toBe("finish");
  expect(chunks.filter((c) => c.type === "start" || c.type === "finish")).toHaveLength(2);
  expect(chunks.some((c) => c.type === "error" || c.type === "abort")).toBe(false);
  // Every text and tool part that was opened is closed (the app would show "Working on it" forever otherwise).
  const openText = new Set<string>();
  const openTools = new Set<string>();
  for (const c of chunks) {
    if (c.type === "text-start") openText.add(c.id);
    if (c.type === "text-end") openText.delete(c.id);
    if (c.type === "tool-input-start" || c.type === "tool-input-available") openTools.add(c.toolCallId);
    if (c.type === "tool-output-available" || c.type === "tool-output-error" || c.type === "tool-input-error") openTools.delete(c.toolCallId);
  }
  expect([...openText]).toEqual([]);
  expect([...openTools]).toEqual([]);
}

describe("turn time budget (agent/budget.ts)", () => {
  it("a stream that stalls after the tools is cut, and the final answer call answers from the tool results", async () => {
    const r = await runTurn([OBLIGATIONS, BALANCES, "stall", { text: "Rent and tuition come to more than your KZT balance covers." }]);
    expect(r.summary).toMatchObject({ answeredBy: "final-step", cutoff: "idle" });
    expect(textOf(r.chunks)).toContain("more than your KZT balance covers");
    expect(r.ms).toBeLessThan(1_500 + 300);
    // The final call has no tools, sees the tool results and is told to answer now.
    const final = r.calls[3]!;
    expect(final.tools ?? []).toEqual([]);
    expect(JSON.stringify(final.prompt)).toContain("Time is up for this turn");
    expect(JSON.stringify(final.prompt)).toContain("homeTotalMinor");
    assertWellFormed(r.chunks);
    // History: user, the two tool rounds (call + result each), the answer. The cut call left nothing behind.
    expect(r.store.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  });

  it("a model that only thinks is cut at stepMs even though reasoning keeps streaming", async () => {
    const r = await runTurn([OBLIGATIONS, "think", { text: "Your tuition is the big bill this month." }]);
    expect(r.summary).toMatchObject({ answeredBy: "final-step", cutoff: "step" });
    expect(textOf(r.chunks)).toContain("tuition is the big bill");
    assertWellFormed(r.chunks);
  });

  it("when the final answer call stalls too, code writes the summary before the deadline", async () => {
    const r = await runTurn([OBLIGATIONS, BALANCES, "stall", "stall"]);
    expect(r.summary).toMatchObject({ answeredBy: "summary", cutoff: "idle" });
    const text = textOf(r.chunks);
    expect(text).toContain("I ran out of time");
    // Names are rehydrated for the user; the stored text keeps placeholders.
    expect(text).toContain("Budapest University of Technology");
    expect(text).toContain("EUR 2,400.00");
    expect(text).toContain("Balances: KZT 900,000.00");
    expect(JSON.stringify(r.store.messages.at(-1))).toContain("payee_1");
    expect(JSON.stringify(r.store.messages)).not.toContain("Budapest University");
    expect(r.ms).toBeLessThan(1_500 + 300);
    assertWellFormed(r.chunks);
  });

  it("a model that loops on tools gets no tools after the wrap-up point and answers in the same loop", async () => {
    const slowBalances = { ...FAST, turnMs: 3_000, finalMs: 800, wrapUpMs: 1_000 };
    // Each tool round takes ~250 ms; tool rounds are allowed until 1.2 s.
    const { ports } = fakePorts();
    const balances = ports.balances;
    ports.balances = async () => {
      await new Promise((res) => setTimeout(res, 250));
      return balances();
    };
    const steps: Behaviour[] = Array.from({ length: 9 }, () => ({ whenTools: BALANCES, otherwise: { text: "You have KZT 900,000.00." } }));
    const { model, calls } = scripted(steps);
    const h = await startTurn({ ports, store: memoryStore(), text: "balances?", mode: "LIVE", model, emit: () => undefined, budget: slowBalances });
    const chunks = await drain(h.uiStream);
    const summary = await h.done;
    expect(summary).toMatchObject({ answeredBy: "model", cutoff: null });
    const textOnly = calls.findIndex((c) => (c.tools ?? []).length === 0);
    expect(textOnly).toBeGreaterThan(0);
    expect(textOnly).toBeLessThan(6);
    expect(JSON.stringify(calls[textOnly]!.prompt)).toContain(FINAL_ANSWER_PROMPT.slice(0, 30));
    // The loop ended after the text-only step.
    expect(calls).toHaveLength(textOnly + 1);
    expect(textOf(chunks)).not.toBe("");
    assertWellFormed(chunks);
  });

  it("a proposal made before the cut keeps its card and is named in the answer", async () => {
    const r = await runTurn([OBLIGATIONS, PROPOSE, "stall", "stall"]);
    expect(r.log.proposeOrder).toHaveLength(1);
    expect(r.emitted.map((c) => c.type)).toContain("data-proposal");
    expect(r.summary.answeredBy).toBe("summary");
    expect(textOf(r.chunks)).toContain("Payment proposal: Ask: €2,400.00 to Budapest University of Technology");
    expect(textOf(r.chunks)).toContain("waiting for your approval with your passkey");
  });

  it("a tool call in a step that was cut before it finished does not run", async () => {
    const r = await runTurn([OBLIGATIONS, { slowTools: PROPOSE }, { text: "Tuition is EUR 2,400.00, due 31 October." }]);
    expect(r.log.proposeOrder).toHaveLength(0);
    expect(r.summary).toMatchObject({ answeredBy: "final-step", cutoff: "idle" });
    // Its tool part, if the app saw one, is closed.
    assertWellFormed(r.chunks);
  });

  it("the final answer call is told about this turn's proposals (redacted)", async () => {
    const r = await runTurn([OBLIGATIONS, PROPOSE, "stall", { text: "I drafted the tuition payment; please review it." }]);
    expect(r.summary).toMatchObject({ answeredBy: "final-step", cutoff: "idle" });
    const prompt = JSON.stringify(r.calls[3]!.prompt);
    expect(prompt).toContain("Payment proposals created in this turn");
    expect(prompt).toContain("Ask: €2,400.00 to payee_1");
    expect(prompt).not.toContain("Budapest University");
    expect(textOf(r.chunks)).toContain("I drafted the tuition payment");
    assertWellFormed(r.chunks);
  });

  it("an empty answer after the tools gets a final answer call", async () => {
    const r = await runTurn([OBLIGATIONS, "empty", { text: "Two bills are due: tuition and rent." }]);
    expect(r.summary).toMatchObject({ answeredBy: "final-step", cutoff: "no-text" });
    expect(textOf(r.chunks)).toContain("Two bills are due");
    assertWellFormed(r.chunks);
  });

  it("a stall on the very first call still answers (no tool results: a short apology)", async () => {
    const r = await runTurn(["stall", "stall"]);
    expect(r.summary).toMatchObject({ answeredBy: "summary", cutoff: "idle", steps: 0 });
    expect(textOf(r.chunks)).toContain("could not finish this answer in time");
    assertWellFormed(r.chunks);
  });

  it("a normal turn is unchanged", async () => {
    const r = await runTurn([OBLIGATIONS, { text: "Tuition is due on 31 October." }], { turnMs: 20_000 });
    expect(r.summary).toMatchObject({ answeredBy: "model", cutoff: null });
    expect(r.calls).toHaveLength(2);
    assertWellFormed(r.chunks);
  });
});

describe("timeoutMiddleware", () => {
  it("rejects the opening of a call that never returns, with the step timeout", async () => {
    const mw = timeoutMiddleware({ stepMs: 50, idleMs: 1_000, deadline: () => Date.now() + 10_000 });
    let seen: AbortSignal | undefined;
    const model = {
      doStream: (o: LanguageModelV4CallOptions) => {
        seen = o.abortSignal;
        return new Promise<never>(() => undefined);
      },
    } as unknown as Parameters<NonNullable<typeof mw.wrapStream>>[0]["model"];
    const err = await Promise.resolve(mw.wrapStream!({ doStream: async () => Promise.reject(new Error("unused")), doGenerate: async () => Promise.reject(new Error("unused")), params: { prompt: [] }, model })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnTimeoutError);
    expect((err as TurnTimeoutError).kind).toBe("step");
    // The provider request is aborted too (and with it the retry middleware's backoff sleep).
    expect(seen?.aborted).toBe(true);
  });
});

describe("budget configuration", () => {
  it("reads the environment, ignores junk, and derives the final-answer and wrap-up reserves", () => {
    expect(turnBudget({}, {})).toEqual({ turnMs: 75_000, stepMs: 30_000, idleMs: 20_000, finalMs: 15_000, wrapUpMs: 18_750 });
    expect(turnBudget({}, { AGENT_TURN_TIMEOUT_MS: "60000", AGENT_STEP_TIMEOUT_MS: "x", AGENT_CHUNK_TIMEOUT_MS: "10" }).turnMs).toBe(60_000);
    expect(turnBudget({}, { AGENT_STEP_TIMEOUT_MS: "x" }).stepMs).toBe(30_000);
    expect(turnBudget({}, { AGENT_CHUNK_TIMEOUT_MS: "10" }).idleMs).toBe(20_000);
  });

  it("streamed calls retry at most twice by default, never more than AI_MAX_RETRIES", () => {
    expect(aiStreamMaxRetries({})).toBe(2);
    expect(aiStreamMaxRetries({ AI_STREAM_MAX_RETRIES: "4" })).toBe(4);
    expect(aiStreamMaxRetries({ AI_STREAM_MAX_RETRIES: "4", AI_MAX_RETRIES: "1" })).toBe(1);
  });

  it("the code-written summary says nothing was found when no tool ran", () => {
    expect(fallbackAnswer([], [], { timedOut: false })).toContain("could not write an answer");
  });
});
