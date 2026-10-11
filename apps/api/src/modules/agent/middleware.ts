import type { LanguageModelMiddleware } from "ai";
import type { LanguageModelV4Prompt, LanguageModelV4ToolResultOutput } from "@ai-sdk/provider";

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
