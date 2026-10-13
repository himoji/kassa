import type { ModelMessage } from "ai";
import { distance } from "fastest-levenshtein";

import type { ChoiceAnswer, DataChoices } from "@kassa/shared";

import { choicePart, UI_TOOLS } from "./tools.ts";

/*
 * Choices (agent-triggered UI): the `data-choices` part an ask_* tool emitted is rebuilt from stored history (the
 * tool call input + the choiceId in its result), so the client can never invent options. Typed or spoken answers
 * are matched to an option server-side (matchChoice: exact, then synonym, then fuzzy).
 */

export class ChoiceError extends Error {
  constructor(
    readonly code: "CHOICE_NOT_FOUND" | "CHOICE_INVALID",
    message: string,
  ) {
    super(message);
  }
}

type StoredChoice = { part: DataChoices; index: number };

/** Every picker in a conversation's stored messages, in order, with the index of the message that showed it. */
export function storedChoices(messages: readonly ModelMessage[]): StoredChoice[] {
  const calls = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  const out: StoredChoice[] = [];
  messages.forEach((m, index) => {
    if (!Array.isArray(m.content)) return;
    for (const c of m.content as Array<Record<string, unknown>>) {
      if (m.role === "assistant" && c.type === "tool-call" && UI_TOOLS.includes(c.toolName as never)) {
        calls.set(String(c.toolCallId), { toolName: String(c.toolName), input: (c.input ?? {}) as Record<string, unknown> });
      }
      if (m.role === "tool" && c.type === "tool-result") {
        const call = calls.get(String(c.toolCallId));
        const output = c.output as { type?: string; value?: { choiceId?: unknown } } | undefined;
        const choiceId = output?.value?.choiceId;
        if (!call || typeof choiceId !== "string") continue;
        try {
          const part = choicePart(call.toolName, call.input, choiceId);
          if (part) out.push({ part, index });
        } catch {
          // a malformed stored input is not a picker
        }
      }
    }
  });
  return out;
}

/** The picker the user has not answered yet (shown in the last assistant turn, no user message after it). */
export function pendingChoice(messages: readonly ModelMessage[]): DataChoices | null {
  const all = storedChoices(messages);
  const last = all.at(-1);
  if (!last) return null;
  return messages.slice(last.index + 1).some((m) => m.role === "user") ? null : last.part;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Match free text or a speech transcript to one option: exact (label / id / value), then a synonym, then fuzzy. */
export function matchChoice(text: string, part: Pick<DataChoices, "options">): DataChoices["options"][number] | null {
  const t = norm(text);
  if (!t) return null;
  const exact = part.options.find((o) => [o.label, o.id, o.value].some((x) => norm(x) === t));
  if (exact) return exact;
  const synonym = part.options.find((o) => (o.spoken ?? []).some((x) => norm(x) === t));
  if (synonym) return synonym;
  // Fuzzy: the closest label / synonym within ~25 % edits, and only when it is unambiguous.
  let best: { o: DataChoices["options"][number]; d: number } | null = null;
  let tie = false;
  for (const o of part.options) {
    for (const cand of [o.label, ...(o.spoken ?? [])]) {
      const c = norm(cand);
      const d = distance(c, t);
      if (d > Math.max(1, Math.floor(Math.max(c.length, t.length) * 0.25))) continue;
      if (!best || d < best.d) {
        best = { o, d };
        tie = false;
      } else if (d === best.d && best.o.id !== o.id) tie = true;
    }
  }
  return best && !tie ? best.o : null;
}

/** Validate an explicit pick against the stored part → the canonical answer the model sees. */
export function resolveAnswer(part: DataChoices, answer: ChoiceAnswer): NonNullable<DataChoices["answer"]> {
  if (part.kind === "amount") {
    const v = answer.value ?? "";
    if (!/^\d{1,15}$/.test(v)) throw new ChoiceError("CHOICE_INVALID", "amount must be integer minor units");
    const n = Number(v);
    const a = part.amount;
    if ((a?.minMinor !== undefined && n < a.minMinor) || (a?.maxMinor !== undefined && n > a.maxMinor)) throw new ChoiceError("CHOICE_INVALID", "amount out of range");
    return { optionIds: [], value: v, label: `${v} ${a?.currency ?? ""} (minor units)`.trim() };
  }
  if (part.kind === "date") {
    const v = answer.value ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new ChoiceError("CHOICE_INVALID", "date must be YYYY-MM-DD");
    if ((part.date?.min && v < part.date.min) || (part.date?.max && v > part.date.max)) throw new ChoiceError("CHOICE_INVALID", "date out of range");
    return { optionIds: [], value: v, label: v };
  }
  const ids = answer.optionIds ?? (answer.optionId ? [answer.optionId] : []);
  if (ids.length === 0 || (ids.length > 1 && !part.multi)) throw new ChoiceError("CHOICE_INVALID", "pick one option");
  const picked = ids.map((id) => part.options.find((o) => o.id === id));
  if (picked.some((o) => !o)) throw new ChoiceError("CHOICE_INVALID", "unknown option");
  const opts = picked as DataChoices["options"];
  return { optionIds: opts.map((o) => o.id), label: opts.map((o) => o.label).join(", ") };
}

/**
 * The text the model sees for this user message. An explicit pick must name the pending picker and a valid option;
 * free text (typed or spoken) is matched against the pending picker, and kept as typed when nothing matches.
 */
export function answerText(history: readonly ModelMessage[], text: string, choice: ChoiceAnswer | undefined): string {
  if (choice) {
    const part = storedChoices(history).find((c) => c.part.id === choice.id)?.part;
    if (!part) throw new ChoiceError("CHOICE_NOT_FOUND", "No such picker in this conversation");
    return resolveAnswer(part, choice).label;
  }
  const pending = pendingChoice(history);
  if (!pending || pending.options.length === 0) return text;
  return matchChoice(text, pending)?.label ?? text;
}

/** The answer of each picker: the next user message's text matched against it (history views, read-only cards). */
export function answersOf(messages: readonly ModelMessage[]): Map<string, NonNullable<DataChoices["answer"]>> {
  const out = new Map<string, NonNullable<DataChoices["answer"]>>();
  for (const { part, index } of storedChoices(messages)) {
    const next = messages.slice(index + 1).find((m) => m.role === "user");
    if (!next) continue;
    const raw = typeof next.content === "string" ? next.content : next.content.map((c) => ("text" in c ? c.text : "")).join("");
    const text = raw.replace(/^Current draft \(JSON\):[\s\S]*?\n\nUser: /, "");
    const o = part.options.length ? matchChoice(text, part) : null;
    out.set(part.id, o ? { optionIds: [o.id], label: o.label } : { optionIds: [], label: text });
  }
  return out;
}
