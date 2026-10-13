import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";

import type { DataChoices } from "@kassa/shared";

import { answerText, answersOf, ChoiceError, matchChoice, pendingChoice } from "../../src/modules/agent/choices.ts";
import { startTurn } from "../../src/modules/agent/loop.ts";
import { fxRate } from "../../src/modules/agent/tools.ts";
import { toUIMessages } from "../../src/modules/agent/ui-history.ts";
import { drain, fakePorts, memoryStore } from "./fakes.ts";

/*
 * get_fx_rate (read-only) and the ask_* pickers, offline: REPLAY recordings (fixtures/agent-recordings/fx-rate.json)
 * drive the real tool loop; rates come from the static ECB / NBK table (NODE_ENV=test).
 */

async function replayTurn(text: string, store = memoryStore()) {
  const { ports, log } = fakePorts();
  const emitted: UIMessageChunk[] = [];
  const h = await startTurn({ ports, store, text, mode: "REPLAY", scenario: "fx-rate", replayChunkDelayMs: 0, emit: (c) => emitted.push(c) });
  const chunks = await drain(h.uiStream);
  const summary = await h.done;
  return { ports, log, emitted, chunks, summary, store };
}

const textOf = (chunks: UIMessageChunk[]) => chunks.map((c) => (c.type === "text-delta" ? c.delta : "")).join("");

describe("get_fx_rate", () => {
  it("returns rate, converted amount, source and asOf from fx/rates.ts", async () => {
    const r = await fxRate({ from: "EUR", to: "KZT", amountMinor: 10_000, date: "2026-10-09" });
    expect(r).toMatchObject({ from: "EUR", to: "KZT", amountMinor: 10_000, source: "static" });
    expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Exact rational conversion: 100.00 EUR × rate, in KZT minor units.
    expect(r.convertedMinor).toBe(Math.round(Number(r.rate) * 10_000));
    expect((await fxRate({ from: "EUR", to: "EUR" })).rate).toBe("1");
  });

  it("REPLAY: a conversion question calls get_fx_rate, never proposes, and answers in markdown", async () => {
    const r = await replayTurn("what's 100 EUR in KZT?");
    expect(r.summary.toolCalls.map((c) => c.toolName)).toEqual(["get_fx_rate"]);
    expect(r.log.proposeOrder).toHaveLength(0);
    expect(r.emitted).toHaveLength(0);
    const out = JSON.stringify(r.store.messages);
    expect(out).toContain('"convertedMinor"');
    expect(out).toContain('"source":"static"');
    expect(textOf(r.chunks)).toContain("**€100.00");
  });
});

describe("pickers (ask_*)", () => {
  it("ask_choice emits a data-choices part and ends the turn", async () => {
    const r = await replayTurn("which currency should I keep my savings in?");
    expect(r.summary.steps).toBe(1);
    expect(textOf(r.chunks)).not.toContain("never reached");
    const part = r.emitted.find((c) => c.type === "data-choices") as { data: DataChoices } | undefined;
    expect(part?.data).toMatchObject({ kind: "choice", prompt: "Savings currency", options: [{ id: "kzt" }, { id: "eur" }, { id: "huf" }] });
    expect(part?.data.id).toMatch(/^ch_/);
    expect(pendingChoice(r.store.messages)?.id).toBe(part?.data.id);
  });

  it("answers are validated against the stored part; free text and speech are matched server-side", async () => {
    const r = await replayTurn("which currency should I keep my savings in?");
    const id = pendingChoice(r.store.messages)!.id;
    expect(answerText(r.store.messages, "x", { id, optionId: "eur" })).toBe("Euro (EUR)");
    expect(() => answerText(r.store.messages, "x", { id, optionId: "usd" })).toThrow(ChoiceError);
    expect(() => answerText(r.store.messages, "x", { id: "ch_forged", optionId: "eur" })).toThrow(ChoiceError);
    expect(() => answerText(r.store.messages, "x", { id, optionIds: ["eur", "kzt"] })).toThrow(ChoiceError);
    expect(answerText(r.store.messages, "euros", undefined)).toBe("Euro (EUR)");
    expect(answerText(r.store.messages, "something else entirely", undefined)).toBe("something else entirely");
  });

  it("matchChoice: exact, then synonym, then unambiguous fuzzy", () => {
    const part = {
      options: [
        { id: "yes", label: "Yes", value: "yes", spoken: ["yeah", "sure"] },
        { id: "no", label: "No", value: "no", spoken: ["nope"] },
        { id: "monthly", label: "Monthly", value: "monthly" },
      ],
    };
    expect(matchChoice("YES", part)?.id).toBe("yes");
    expect(matchChoice("sure", part)?.id).toBe("yes");
    expect(matchChoice("montly", part)?.id).toBe("monthly");
    expect(matchChoice("weekly", part)).toBeNull();
    expect(matchChoice("", part)).toBeNull();
  });

  it("history view: text before cards, answered pickers carry their answer", async () => {
    const store = memoryStore();
    const first = await replayTurn("which currency should I keep my savings in?", store);
    store.messages.push({ role: "user", content: "Euro (EUR)" }, { role: "assistant", content: [{ type: "text", text: "Noted." }] });
    const ui = await toUIMessages("conv-1", store.messages, store.entries, first.ports);
    expect(ui.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(ui[1]!.parts.map((p) => p.type)).toEqual(["text", "data-choices"]);
    expect((ui[1]!.parts[1] as unknown as { data: DataChoices }).data.answer).toEqual({ optionIds: ["eur"], label: "Euro (EUR)" });
    expect(answersOf(store.messages).size).toBe(1);
  });
});
