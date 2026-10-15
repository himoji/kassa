import { OnboardingProfileDraft, type OnboardingHistoryRequest, type OnboardingMessageResponse } from "@kassa/shared";
import type { ModelMessage } from "ai";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { onboardingDrafts } from "../../db/schema.intel.ts";
import { profiles } from "../../db/schema.ts";
import { appendHistory, claimConversation, loadPlaceholders, savePlaceholders } from "../agent/history.ts";
import { Redactor } from "../agent/redact.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { historyLines } from "../dataport/notes.ts";
import { emptyDraft, getOnboardingDraft, isComplete } from "./service.ts";

/*
 * Bank history in the onboarding chat (IMPORT_PLAN S11). The app reads the user's statements with POST /import/file,
 * imports the spending with POST /import/commit, and hands the preview's history here. This step is code, not a model:
 *  - the suggestions (incomes, bills, budgets, cards) are merged into the draft only where the draft has nothing yet
 *    or the item is new; nothing is applied until the user signs the reviewed draft with the passkey;
 *  - the reply that tells the user what Kassa learned is written from the numbers, so no model can misstate them;
 *  - the conversation keeps a user turn with the aggregates only (redacted: people are person_N), which is all the
 *    model sees on its next turn. No transaction, account number or statement text enters the conversation.
 */

/** Merge the history's suggestions into a draft (see the header comment). */
export function mergeHistory(draft: OnboardingProfileDraft, items: OnboardingHistoryRequest["items"]): OnboardingProfileDraft {
  const next = structuredClone(draft);
  for (const i of items.incomes) {
    if (!next.incomes.some((x) => x.source.toLowerCase() === i.source.toLowerCase() && x.currency === i.currency)) next.incomes.push(i);
  }
  for (const b of items.bills) {
    if (!next.obligations.some((x) => x.payeeName.toLowerCase() === b.payeeName.toLowerCase())) next.obligations.push(b);
  }
  // Budgets the user already stated win; history only fills categories they have not set.
  for (const b of items.budgets) if (!next.budgets.some((x) => x.category === b.category)) next.budgets.push(b);
  for (const c of items.cards) if (!next.cards.some((x) => x.last4 === c.last4)) next.cards.push(c);
  return OnboardingProfileDraft.parse(next);
}

/** The aggregates as the model may see them (redacted names), and the reply as the user sees it. */
export function historyTexts(req: OnboardingHistoryRequest, redactor: Redactor): { forModel: string; reply: string } {
  const h = req.history;
  const banks = [...new Set(req.files.map((f) => f.bank ?? f.name))].join(", ");
  const lines = historyLines(h);
  const forModel = `Bank history imported (computed by Kassa from the statements, not by a model; the draft was prefilled: money in at the planned amounts, budgets from everyday spending). Where money in is irregular, say so and plan with the average, not the best month:\n${redactor.redactText(lines.join("\n"))}`;
  const reply = [
    `I read **${h.counts.rows} transactions** from ${banks}. Here is what they show:`,
    ...lines.map((l) => `- ${l}`),
    "",
    "I put the money in at the planned amounts, the bills and a budget per category into your draft. Nothing is set until you review it and sign with your passkey. **Does this look right?** Tell me what to change.",
  ].join("\n");
  return { forModel, reply };
}

/** POST /onboarding/history: merge, record the turn, answer (see the header comment). */
export async function onboardingHistoryTurn(userId: string, req: OnboardingHistoryRequest): Promise<OnboardingMessageResponse> {
  await claimConversation(req.conversationId, userId, "onboarding");
  const current = (await getOnboardingDraft(userId, req.conversationId)) ?? emptyDraft();
  const draft = mergeHistory(current, req.items);
  const complete = isComplete(draft);
  // People in the history (the sources of money in) become person_N for the model, like any personal name.
  const people = [...req.history.incomes.map((i) => i.source), ...req.history.recurring.map((r) => r.name)].filter((n) => /\p{L}{2,}/u.test(n));
  const redactor = new Redactor({ existing: await loadPlaceholders(req.conversationId, userId), names: people.map((name) => ({ name, kind: "PERSON" as const, ref: name })) });
  const { forModel, reply } = historyTexts(req, redactor);
  const now = clock.now();
  await getDb()
    .insert(onboardingDrafts)
    .values({ conversationId: req.conversationId, userId, draft, complete, updatedAt: now })
    .onConflictDoUpdate({ target: onboardingDrafts.conversationId, set: { draft, complete, updatedAt: now } });
  const messages: ModelMessage[] = [
    { role: "user", content: `Current draft (JSON): ${redactor.redactText(JSON.stringify(draft))}\n\nUser: ${forModel}` },
    { role: "assistant", content: redactor.redactText(JSON.stringify({ reply, draft, complete, ask: null })) },
  ];
  await appendHistory(req.conversationId, userId, "onboarding", messages);
  // The agent reads the same analysis later (get_money_history).
  await getDb().update(profiles).set({ moneyHistory: req.history }).where(eq(profiles.userId, userId));
  await savePlaceholders(req.conversationId, userId, redactor.drainNew());
  await ledger.append("ONBOARDING_HISTORY_MERGED", {
    userId,
    files: req.files.length,
    rows: req.history.counts.rows,
    incomes: req.items.incomes.length,
    bills: req.items.bills.length,
    budgets: req.items.budgets.length,
    cards: req.items.cards.length,
  });
  return { reply, draft, complete, ui: [], replay: false };
}
