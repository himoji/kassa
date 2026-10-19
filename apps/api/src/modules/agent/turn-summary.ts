import type { UIMessageChunk } from "ai";

import type { ToolContext } from "./tools.ts";

/*
 * (added 2026-10-18) The orders of a turn as text, appended to the assistant's reply in code, for channels that do not
 * render proposal cards.
 *
 * A judge saw the planner say "pay straight from your EUR balance, fee EUR 0.50" while the order it proposed (and the
 * user signed) was funded from HUF 35,327.45 via huf-mock-bank. The model's paraphrase can drift from the order; the
 * order cannot. So every order proposed in the turn has one sentence built from its canonical order (shared
 * orderLineEn, collected in ctx.orderLines by propose_order). The proposal card carries it (ProposalSummary.orderLine,
 * and in the app's language from orderFacts), so it survives a reload of the chat.
 *
 * (2026-10-19) The app renders that card, and a second judge read the same sentence twice (the card's block and this
 * text part). The text part is now only for a channel without cards (TurnOptions.cardless); the app gets the card only.
 * Each line is worded by the order's state ("Order to sign: …", "Paid under your mandate: …"; refused orders have none).
 *
 * (2026-10-19) Text of separate model steps arrived as separate text parts with nothing between them, so a client or
 * channel that joins the stream's text (the Shortcut reply, a raw reader) got "first.**Rent paid**" and headings
 * mid-line. stepBreakStream starts every text part after the first with a paragraph break.
 */

/** The text appended for these order lines ("" for none). */
export function orderFactsText(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `\n\n${lines.map((l) => `> ${l}`).join("\n>\n")}`;
}

/** Passes the turn's UI stream through, adding one text part with the turn's orders right before `finish`. */
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

/**
 * Every text part after the first one that had text begins with a paragraph break ("\n\n"), unless its own text already
 * starts with a line break. Parts that stay empty change nothing.
 */
export function stepBreakStream(): TransformStream<UIMessageChunk, UIMessageChunk> {
  let wroteText = false;
  const pending = new Set<string>();
  const started = new Set<string>();
  return new TransformStream({
    transform(chunk, ctl) {
      if (chunk.type === "text-start") {
        started.delete(chunk.id);
        if (wroteText) pending.add(chunk.id);
      } else if (chunk.type === "text-delta" && chunk.delta.length > 0) {
        if (pending.has(chunk.id) && !started.has(chunk.id)) {
          pending.delete(chunk.id);
          started.add(chunk.id);
          wroteText = true;
          ctl.enqueue(/^\s*\n/.test(chunk.delta) ? chunk : { ...chunk, delta: `\n\n${chunk.delta.replace(/^[ \t]+/, "")}` });
          return;
        }
        started.add(chunk.id);
        wroteText = true;
      } else if (chunk.type === "text-end") {
        pending.delete(chunk.id);
      }
      ctl.enqueue(chunk);
    },
  });
}
