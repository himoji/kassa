import type { ModelMessage } from "ai";

import { RouteDto, type DataChoices, type StoredUIMessage } from "@kassa/shared";

import { answersOf, storedChoices } from "./choices.ts";
import type { AgentPorts } from "./ports.ts";
import { Redactor, type PlaceholderEntry } from "./redact.ts";
import { choicesForUser } from "./tools.ts";

/*
 * Stored (redacted, model-facing) messages → AI SDK UIMessages for the owner's chat view: text rehydrated for the
 * user (names back, accounts masked), plus the cards the turn showed, rebuilt from tool results (proposal and budget
 * impact re-read from the server, routes from the tool output, pickers with their answer). Never sent to a model.
 */

type Part = StoredUIMessage["parts"][number];
type Content = Array<Record<string, unknown>>;

const USER_PREFIX = /^Current draft \(JSON\):[\s\S]*?\n\nUser: /;

export async function toUIMessages(
  conversationId: string,
  messages: readonly ModelMessage[],
  placeholders: PlaceholderEntry[],
  ports: Pick<AgentPorts, "payees" | "proposalCard">,
): Promise<StoredUIMessage[]> {
  const redactor = new Redactor({ existing: placeholders });
  const names = new Map((await ports.payees()).map((p) => [p.id, p.name]));
  const forUser = (s: string) => redactor.rehydrateForUser(s, names);
  const answers = answersOf(messages);
  const choicesById = new Map<string, DataChoices>(storedChoices(messages).map((c) => [c.part.id, c.part]));
  const inputs = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  const out: StoredUIMessage[] = [];
  let current: StoredUIMessage | null = null;
  const assistant = (i: number): StoredUIMessage => {
    if (!current) {
      current = { id: `${conversationId}-${i}`, role: "assistant", parts: [] };
      out.push(current);
    }
    return current;
  };

  for (const [i, m] of messages.entries()) {
    if (m.role === "user") {
      current = null;
      const raw = typeof m.content === "string" ? m.content : (m.content as unknown as Content).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
      out.push({ id: `${conversationId}-${i}`, role: "user", parts: [{ type: "text", text: forUser(raw.replace(USER_PREFIX, "")) }] });
      continue;
    }
    if (m.role === "system") continue;
    const msg = assistant(i);
    const content: Content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown as Content);
    const texts: Part[] = [];
    const cards: Part[] = [];
    for (const c of content) {
      if (m.role === "assistant" && c.type === "text" && typeof c.text === "string" && c.text.trim()) texts.push({ type: "text", text: forUser(c.text) });
      if (m.role === "assistant" && c.type === "tool-call") inputs.set(String(c.toolCallId), { toolName: String(c.toolName), input: (c.input ?? {}) as Record<string, unknown> });
      if (m.role === "tool" && c.type === "tool-result") {
        const call = inputs.get(String(c.toolCallId));
        const value = (c.output as { value?: Record<string, unknown> } | undefined)?.value;
        if (!call || !value || typeof value !== "object") continue;
        if (call.toolName === "propose_order" && typeof value.proposalId === "string") {
          const card = await ports.proposalCard(value.proposalId).catch(() => null);
          if (card?.summary) cards.push({ type: "data-proposal", id: value.proposalId, data: card.summary });
          if (card?.budgetImpact) cards.push({ type: "data-budget-impact", id: `impact-${value.proposalId}`, data: card.budgetImpact });
        }
        if (call.toolName === "get_routes" && Array.isArray(value.routes) && value.routes.length > 0) {
          // The tool output also carries model-only text (formatted amounts, maxPayable): the card gets the route fields.
          const routes = (value.routes as unknown[]).map((r) => {
            const p = RouteDto.safeParse(r);
            return p.success ? p.data : r;
          });
          cards.push({ type: "data-routes", data: { toCurrency: call.input.toCurrency, amountMinor: call.input.amountMinor, homeCurrency: value.homeCurrency, routes } });
        }
        if (typeof value.choiceId === "string") {
          const part = choicesById.get(value.choiceId);
          if (part) {
            const answer = answers.get(part.id);
            cards.push({ type: "data-choices", id: part.id, data: await choicesForUser({ ...part, ...(answer ? { answer } : {}) }, forUser) });
          }
        }
      }
    }
    // Text first, cards after it (the chat renders them in this order).
    msg.parts.push(...texts, ...cards);
  }
  return out.filter((m) => m.parts.length > 0);
}
