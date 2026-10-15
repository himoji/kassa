import { currencyExponent, OnboardingProfileDraft, type OnboardingHistoryRequest, type OnboardingMessageResponse } from "@kassa/shared";
import type { ModelMessage } from "ai";

import { getDb } from "../../db/client.ts";
import { onboardingDrafts } from "../../db/schema.intel.ts";
import { appendHistory, claimConversation, loadPlaceholders, savePlaceholders } from "../agent/history.ts";
import { Redactor } from "../agent/redact.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
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

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(minor / 10 ** currencyExponent(currency));
const month = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleString("en", { month: "short", year: "numeric", timeZone: "UTC" }) : "?");
const CATEGORY_LABEL = (c: string) => c.replace(/_/g, " ");

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
  const top = h.spendingByCategory.filter((c) => c.category !== "transfers").slice(0, 5);
  const lines: string[] = [];
  lines.push(`Period: ${month(h.from)} – ${month(h.to)} (${h.months} months), ${h.counts.rows} transactions from ${req.files.length} statement(s): ${banks}.`);
  lines.push(`Spending: about ${money(h.monthlySpendingHomeMinor, h.homeCurrency)} a month. Biggest: ${top.map((c) => `${CATEGORY_LABEL(c.category)} ${money(c.monthlyHomeMinor, h.homeCurrency)}`).join(", ") || "none"}.`);
  const transfers = h.spendingByCategory.find((c) => c.category === "transfers");
  if (transfers) lines.push(`Transfers to other people: about ${money(transfers.monthlyHomeMinor, h.homeCurrency)} a month.`);
  if (h.incomes.length) lines.push(`Money in: ${h.incomes.slice(0, 4).map((i) => `${i.source} about ${money(i.amount.amountMinor, i.amount.currency)} a month`).join("; ")}.`);
  if (h.recurring.length) lines.push(`Regular payments: ${h.recurring.slice(0, 4).map((r) => `${r.name} ${money(r.amount.amountMinor, r.amount.currency)} (next ${r.nextDate})`).join("; ")}.`);
  if (h.fees.totalHomeMinor > 0) lines.push(`Bank and conversion fees: ${money(h.fees.totalHomeMinor, h.homeCurrency)} over the period${h.fees.fxMarkupBps !== null ? `; foreign purchases cost about ${(h.fees.fxMarkupBps / 100).toFixed(1)}% over the mid rate` : ""}.`);
  if (h.counts.ownTransfers) lines.push(`${h.counts.ownTransfers} transfers between the user's own accounts were left out.`);
  const summary = lines.join("\n");
  const forModel = `Bank history imported (aggregates computed by Kassa from the statements; the draft was prefilled with these suggestions):\n${redactor.redactText(summary)}`;
  const reply = [
    `I read **${h.counts.rows} transactions** from ${banks} (${month(h.from)} – ${month(h.to)}). Here is what I learned:`,
    ...lines.slice(1).map((l) => `- ${l}`),
    "",
    "I put the regular money in, the bills and a budget per category into your draft. Nothing is set until you review it and sign with your passkey. **Does this look right?** Tell me what to change.",
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
