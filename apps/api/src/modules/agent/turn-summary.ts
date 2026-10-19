import type { UIMessageChunk } from "ai";

import type { ToolContext } from "./tools.ts";

/*
 * (added 2026-10-18) The signed orders of a turn, appended to the assistant's reply in code.
 *
 * A judge saw the planner say "pay straight from your EUR balance, fee EUR 0.50" while the order it proposed (and the
 * user signed) was funded from HUF 35,327.45 via huf-mock-bank. The model's paraphrase can drift from the order; the
 * order cannot. So every order proposed in the turn gets one sentence built from its canonical order (shared
 * orderLineEn, collected in ctx.orderLines by propose_order) as a final text part, after the model's own text and
 * before the stream finishes. Deterministic and always on: no text matching against the model's wording.
 * The proposal card carries the same sentence (ProposalSummary.orderLine), so it survives a reload of the chat.
 */

/** The text appended for these order lines ("" for none). */
export function orderFactsText(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `\n\n${lines.map((l) => `> ${l}`).join("\n>\n")}`;
}

/** Passes the turn's UI stream through, adding one text part with the signed orders right before `finish`. */
export function orderFactsStream(ctx: Pick<ToolContext, "orderLines">): TransformStream<UIMessageChunk, UIMessageChunk> {
  let added = false;
  return new TransformStream({
    transform(chunk, ctl) {
      if (chunk.type === "finish" && !added) {
        added = true;
        const text = orderFactsText(ctx.orderLines ?? []);
        if (text) {
          const id = "kassa-signed-orders";
          ctl.enqueue({ type: "text-start", id });
          ctl.enqueue({ type: "text-delta", id, delta: text });
          ctl.enqueue({ type: "text-end", id });
        }
      }
      ctl.enqueue(chunk);
    },
  });
}
