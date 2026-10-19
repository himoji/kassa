import { simulateReadableStream, type UIMessageChunk } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { startTurn } from "../../src/modules/agent/loop.ts";
import { stripToolMarkup, ToolMarkupFilter } from "../../src/modules/agent/middleware.ts";
import { stepChunks, type RecordedStep } from "../../src/modules/agent/replay.ts";

import { drain, fakePorts, memoryStore } from "./fakes.ts";

/*
 * The committed live run (docs/evidence/live-agent.json, "rent") answered with DeepSeek tool-call markup as text:
 * on a text-only step the model still "called" get_payments. That markup must never reach the user.
 */

const DSML = '\n\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="get_payments">\n\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';
const DSML_FN = '<｜DSML｜function_calls>\n<｜DSML｜invoke name="get_payments">\n<｜DSML｜parameter name="limit" string="false">5</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';

/** Feeds `text` to a filter cut at every position, so a tag split across deltas is still caught. */
function everySplit(text: string): string[] {
  const outs: string[] = [];
  for (let i = 0; i <= text.length; i++) {
    const f = new ToolMarkupFilter();
    outs.push(f.push(text.slice(0, i)) + f.push(text.slice(i)) + f.flush());
  }
  return outs;
}

describe("tool-call markup in model text", () => {
  it("drops a markup-only reply (the live 'rent' turn)", () => {
    expect(stripToolMarkup(DSML).trim()).toBe("");
    expect(stripToolMarkup(DSML_FN)).toBe("");
  });

  it("keeps the text around the markup, however the deltas are cut", () => {
    for (const out of everySplit(`Rent is due on 21 Oct. ${DSML_FN} Pay it now?`)) expect(out).toBe("Rent is due on 21 Oct.  Pay it now?");
    for (const out of everySplit(`Before ${DSML} after`)) expect(out).toBe("Before \n\n after");
  });

  it("leaves ordinary text with < and > alone", () => {
    for (const out of everySplit("Fee < KZT 1,000 and > 0. Use <b>bold</b>.")) expect(out).toBe("Fee < KZT 1,000 and > 0. Use <b>bold</b>.");
  });

  it("drops an unclosed block to the end", () => {
    expect(stripToolMarkup('Checking. <｜DSML｜function_calls><｜DSML｜invoke name="x">')).toBe("Checking. ");
  });

  it("a turn whose only text is markup is answered by the final-answer call instead", async () => {
    const { ports } = fakePorts();
    let step = 0;
    const steps: RecordedStep[] = [{ toolCalls: [{ toolName: "get_obligations", input: {} }] }, { text: DSML }, { text: "Your rent for October is already paid." }];
    const model = new MockLanguageModelV4({
      provider: "test",
      modelId: "scripted",
      doStream: async () => {
        const s = steps[Math.min(step, steps.length - 1)]!;
        const chunks = stepChunks(s, step);
        step++;
        return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 0 }) };
      },
    });
    const h = await startTurn({ ports, store: memoryStore(), text: "Pay this month's rent.", mode: "LIVE", model, emit: () => undefined });
    const chunks: UIMessageChunk[] = await drain(h.uiStream);
    const summary = await h.done;
    const shown = chunks.flatMap((c) => (c.type === "text-delta" ? [c.delta] : [])).join("");
    expect(shown).not.toContain("DSML");
    expect(summary.text).not.toContain("DSML");
    expect(summary.answeredBy).toBe("final-step");
    expect(shown).toContain("already paid");
  });
});
