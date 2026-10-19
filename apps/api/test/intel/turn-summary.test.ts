/*
 * (2026-10-19) The reply's text as a channel joins it: separate model steps are separate paragraphs (a judge read
 * "first.**Rent paid**" and a heading mid-line), and the order line is appended as text only for a channel without
 * cards (the app shows it once, on the card).
 */
import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";

import { orderFactsStream, orderFactsText, stepBreakStream } from "../../src/modules/agent/turn-summary.ts";

async function run(chunks: UIMessageChunk[], ...ts: TransformStream<UIMessageChunk, UIMessageChunk>[]): Promise<string> {
  let s: ReadableStream<UIMessageChunk> = new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
  for (const t of ts) s = s.pipeThrough(t);
  let text = "";
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    if (value.type === "text-delta") text += value.delta;
  }
  return text;
}

const part = (id: string, ...deltas: string[]): UIMessageChunk[] => [{ type: "text-start", id }, ...deltas.map((delta) => ({ type: "text-delta" as const, id, delta })), { type: "text-end", id }];

describe("stepBreakStream", () => {
  it("separates the text of consecutive steps with a paragraph break, even when the provider reuses the part id", async () => {
    const text = await run([...part("0", "Let me check your bills ", "first."), { type: "start-step" } as UIMessageChunk, ...part("0", "**Rent paid**"), ...part("1", "### Money from home\n- ok")], stepBreakStream());
    expect(text).toBe("Let me check your bills first.\n\n**Rent paid**\n\n### Money from home\n- ok");
  });

  it("adds nothing before the first text, for empty parts, or when the step already starts on a new line", async () => {
    expect(await run([...part("a"), ...part("b", "Hello")], stepBreakStream())).toBe("Hello");
    expect(await run([...part("a", "One."), ...part("b", "\n\nTwo.")], stepBreakStream())).toBe("One.\n\nTwo.");
  });
});

describe("orderFactsStream (channels without cards)", () => {
  it("appends the turn's order lines once, before finish", async () => {
    const lines = ["Order to sign: EUR 10.00 to X, by bank transfer."];
    const text = await run([...part("0", "Done."), { type: "finish" } as UIMessageChunk], stepBreakStream(), orderFactsStream({ orderLines: lines }));
    expect(text).toBe(`Done.${orderFactsText(lines)}`);
  });
});
