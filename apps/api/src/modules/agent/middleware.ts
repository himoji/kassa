import type { LanguageModelMiddleware } from "ai";
import type { LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4ToolResultOutput } from "@ai-sdk/provider";

import type { Redactor } from "./redact.ts";

/*
 * Defence in depth for I11: redaction runs inside the model call itself, on every user text part and
 * every tool result in the prompt, so nothing un-redacted can reach any provider even if a tool forgot.
 * (Tools already redact their outputs; redaction is idempotent because placeholders are not detected.)
 */

function redactOutput(o: LanguageModelV4ToolResultOutput, r: Redactor): LanguageModelV4ToolResultOutput {
  switch (o.type) {
    case "text":
    case "error-text":
      return { ...o, value: r.redactText(o.value) };
    case "json":
    case "error-json":
      return { ...o, value: r.redactValue(o.value) };
    case "content":
      return { ...o, value: o.value.map((p) => (p.type === "text" ? { ...p, text: r.redactText(p.text) } : p)) };
    default:
      return o;
  }
}

export function redactPrompt(prompt: LanguageModelV4Prompt, r: Redactor): LanguageModelV4Prompt {
  return prompt.map((m) => {
    if (m.role === "user") return { ...m, content: m.content.map((p) => (p.type === "text" ? { ...p, text: r.redactText(p.text) } : p)) };
    if (m.role === "tool") return { ...m, content: m.content.map((p) => (p.type === "tool-result" ? { ...p, output: redactOutput(p.output, r) } : p)) };
    if (m.role === "assistant") {
      return {
        ...m,
        content: m.content.map((p) =>
          p.type === "text" ? { ...p, text: r.redactText(p.text) } : p.type === "tool-result" ? { ...p, output: redactOutput(p.output, r) } : p,
        ),
      };
    }
    return m;
  });
}

export function redactionMiddleware(r: Redactor): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => ({ ...params, prompt: redactPrompt(params.prompt, r) }),
  };
}

/*
 * Some models (DeepSeek's DSML) write a tool call as plain text when no tool may run, e.g. on a text-only step after
 * REFUSE: `<｜DSML｜function_calls><｜DSML｜invoke name="get_payments">…</｜DSML｜function_calls>`. That markup is
 * never an answer: it is dropped from the text, and a reply left empty is answered by the final-answer call.
 */
const MARKUP_OPEN = /<[｜|]\s*DSML\s*[｜|]/;
const MARKUP_CLOSE = /<\/[｜|]\s*DSML\s*[｜|]\s*(?:function_)?calls\s*>/;
/** A "<" this close to the end with no ">" yet may be the start of a tag: held until the next delta. */
const HOLD = 16;

/** Drops tool-call markup from text that arrives in pieces. */
export class ToolMarkupFilter {
  private buf = "";
  private inBlock = false;

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      if (this.inBlock) {
        const m = MARKUP_CLOSE.exec(this.buf);
        if (!m) {
          const lt = this.buf.lastIndexOf("<");
          this.buf = lt >= 0 ? this.buf.slice(lt) : "";
          return out;
        }
        this.buf = this.buf.slice(m.index + m[0].length);
        this.inBlock = false;
        continue;
      }
      const m = MARKUP_OPEN.exec(this.buf);
      if (m) {
        out += this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        this.inBlock = true;
        continue;
      }
      const lt = this.buf.lastIndexOf("<");
      const hold = lt >= 0 && this.buf.length - lt < HOLD && !this.buf.includes(">", lt) ? lt : this.buf.length;
      out += this.buf.slice(0, hold);
      this.buf = this.buf.slice(hold);
      return out;
    }
  }

  /** The rest of the text; an unclosed block is dropped. */
  flush(): string {
    const rest = this.inBlock ? "" : this.buf;
    this.buf = "";
    this.inBlock = false;
    return rest;
  }
}

export function stripToolMarkup(text: string): string {
  const f = new ToolMarkupFilter();
  return f.push(text) + f.flush();
}

export function toolMarkupMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const r = await doGenerate();
      return { ...r, content: r.content.map((p) => (p.type === "text" ? { ...p, text: stripToolMarkup(p.text) } : p)) };
    },
    wrapStream: async ({ doStream }) => {
      const r = await doStream();
      const filters = new Map<string, ToolMarkupFilter>();
      const strip = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(chunk, ctl) {
          if (chunk.type === "text-start") filters.set(chunk.id, new ToolMarkupFilter());
          if (chunk.type === "text-delta") {
            const f = filters.get(chunk.id);
            const delta = f ? f.push(chunk.delta) : chunk.delta;
            if (delta) ctl.enqueue({ ...chunk, delta });
            return;
          }
          if (chunk.type === "text-end") {
            const rest = filters.get(chunk.id)?.flush();
            filters.delete(chunk.id);
            if (rest) ctl.enqueue({ type: "text-delta", id: chunk.id, delta: rest });
          }
          ctl.enqueue(chunk);
        },
        flush(ctl) {
          // A stream that ends without text-end still gets its held-back text.
          for (const [id, f] of filters) {
            const rest = f.flush();
            if (rest) ctl.enqueue({ type: "text-delta", id, delta: rest });
          }
        },
      });
      return { ...r, stream: r.stream.pipeThrough(strip) };
    },
  };
}
