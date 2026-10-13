import { wrapLanguageModel, type LanguageModel, type ModelMessage } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { randomUUID } from "node:crypto";

import { OnboardingProfileDraft, type AgentMode, type ChoiceAnswer, type DataChoices, type OnboardingConversationResponse, type OnboardingMessageResponse } from "@kassa/shared";

import { getDb } from "../../db/client.ts";
import { budgets, cards, obligations, payees, profiles, users, type IncomeJson } from "../../db/schema.ts";
import { onboardingDrafts } from "../../db/schema.intel.ts";
import { aiProviderFailure } from "../ai/errors.ts";
import { getPlannerModel, plannerSpec } from "../ai/models.ts";
import { generateStructured } from "../ai/structured.ts";
import { clock, isoDate } from "../clock/index.ts";
import { ChoiceError, matchChoice, resolveAnswer } from "../agent/choices.ts";
import { appendHistory, claimConversation, loadAllMessages, loadHistory, loadPlaceholders, savePlaceholders } from "../agent/history.ts";
import { redactionMiddleware } from "../agent/middleware.ts";
import { Redactor, type PlaceholderEntry } from "../agent/redact.ts";
import { replayModel, selectTurn, StepRecorder } from "../agent/replay.ts";
import { ledger } from "../ledger/index.ts";
import { sealPii } from "../privacy/keys.ts";
import { screenName } from "../screening/index.ts";
import { budgetsPicker, fallbackPicker } from "./pickers.ts";

/*
 * Onboarding chat (spec §8 POST /onboarding/message): one planner call per turn with structured output
 * {reply, draft, complete, ask}. `draft` is update_draft (the whole structured draft every turn) and `ask` is the
 * ask_choice / ask_amount picker, rendered with the agent chat's ChoiceCard. Structured output (not a free tool
 * loop) keeps ai/structured.ts's native → forced tool → JSON fallback for models without tool or schema support;
 * the response stays non-streaming. User text is redacted before the call (I11); placeholders in the model's
 * draft are restored server-side. Confirmation (passkey-signed base rules) is Track A's
 * /onboarding/confirm, which calls getOnboardingDraft / applyOnboardingDraft below.
 */

export const ONBOARDING_INSTRUCTIONS = `You are Kassa's onboarding assistant for a student finance app. Have a short, friendly chat to learn:
home currency (ISO 4217), region (EU or CN), incomes (source, currency, amount, cadence, next date), recurring bills (payee name, kind, amount, currency, due date, recurrence, category), monthly budgets per category in the home currency, cards (label, last 4 digits, billing currency, kind), preferred preset (ASK_ME, SMART, AUTOPILOT), money mode and notification mode (EACH, THRESHOLDS, DIGEST).
Rules:
- Update "draft" with every fact the user states; keep facts from the current draft unless the user corrects them. Never invent values: leave unknown fields null or lists empty.
- Amounts are integer minor units (cents): ₸600,000 = 60000000 KZT; €2,400 = 240000 EUR.
- Placeholders like person_1 or iban_1 stand for personal data; copy them as they are.
- Ask one or two questions per reply. Set "complete" true only when home currency, region, preset, notification mode, at least one income and at least one budget are known.
- When the answer is one of a few options (home currency, region, income cadence, rent yes/no, preset, money mode, notification mode), ALWAYS set "ask" to a picker: kind "choice" with 2-8 options (id, label, spoken synonyms). Preset options: Ask me, Smart, Autopilot. Notification options: Each payment, Above thresholds, Daily digest.
- For one amount set "ask" to kind "amount" with a currency. When you suggest monthly budgets, set "ask" to kind "amounts" with "currency" (the home currency) and one item per category (id like "groceries", label, one emoji, amount in MAJOR units, e.g. 150000 for ₸150,000): the user adjusts every category at once with sliders, so do not ask them to adjust categories one by one.
- Otherwise set "ask" to null.
- Keep "reply" short; markdown bold is fine.`;

const AskOption = z.object({ id: z.string().regex(/^[a-z0-9_-]{1,32}$/), label: z.string().min(1).max(60), spoken: z.array(z.string()).nullish() });
const AskAmountsItem = z.object({ id: z.string().min(1).max(32), label: z.string().min(1).max(60), emoji: z.string().max(16).nullish(), amount: z.number().nonnegative() });
/** ask_choice / ask_amount / several amounts at once (budgets) as structured output (see the header comment). */
const Ask = z.object({
  kind: z.enum(["choice", "amount", "amounts"]),
  prompt: z.string().min(1).max(200),
  options: z.array(AskOption).max(8).nullish(),
  multi: z.boolean().nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  items: z.array(AskAmountsItem).max(12).nullish(),
});

const TurnOutput = z.object({
  reply: z.string(),
  draft: OnboardingProfileDraft,
  complete: z.boolean(),
  ask: Ask.nullish(),
});

/** The picker a turn's `ask` describes (server-minted id), or null when it is unusable. */
function askPart(ask: z.infer<typeof Ask> | null | undefined, id: string): DataChoices | null {
  if (!ask) return null;
  if (ask.kind === "amount") return ask.currency ? { id, kind: "amount", prompt: ask.prompt, options: [], amount: { currency: ask.currency } } : null;
  if (ask.kind === "amounts") return ask.currency ? budgetsPicker(id, ask.prompt, ask.currency, ask.items ?? []) : null;
  const options = (ask.options ?? []).map((o) => ({ id: o.id, label: o.label, value: o.id, ...(o.spoken?.length ? { spoken: o.spoken } : {}) }));
  if (options.length < 2) return null;
  return { id, kind: "choice", prompt: ask.prompt, options, ...(ask.multi ? { multi: true } : {}) };
}

/** Stored assistant turn: the structured answer plus the pickers it showed (`ui`). */
function parseAssistant(content: ModelMessage["content"]): { reply: string; ui: DataChoices[] } | null {
  if (typeof content !== "string") return null;
  try {
    const j = JSON.parse(content) as { reply?: unknown; ui?: unknown };
    return { reply: typeof j.reply === "string" ? j.reply : "", ui: Array.isArray(j.ui) ? (j.ui as DataChoices[]) : [] };
  } catch {
    return null;
  }
}

/** Free text or a pick → the text the model sees, validated against the last turn's picker. */
function onboardingAnswer(history: ModelMessage[], text: string, choice: ChoiceAnswer | undefined): string {
  const last = [...history].reverse().find((m) => m.role === "assistant");
  const ui = last ? (parseAssistant(last.content)?.ui ?? []) : [];
  if (choice) {
    const part = ui.find((p) => p.id === choice.id);
    if (!part) throw new ChoiceError("CHOICE_NOT_FOUND", "No such picker in this conversation");
    return resolveAnswer(part, choice).label;
  }
  const pending = ui.find((p) => p.options.length > 0);
  return (pending && matchChoice(text, pending)?.label) || text;
}

export function emptyDraft(): OnboardingProfileDraft {
  return { displayName: null, homeCurrency: null, region: null, preset: null, moneyMode: null, notificationMode: null, incomes: [], obligations: [], budgets: [], cards: [] };
}

export function isComplete(d: OnboardingProfileDraft): boolean {
  return !!(d.homeCurrency && d.region && d.preset && d.notificationMode && d.incomes.length > 0 && d.budgets.length > 0);
}

/** Restore names hidden by redaction inside the draft (strings only). */
function restore<T>(value: T, entries: PlaceholderEntry[]): T {
  const byP = new Map(entries.filter((e) => e.kind === "PERSON").map((e) => [e.placeholder, e.realRef]));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(/\bperson_\d+\b/g, (p) => byP.get(p) ?? p);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export async function getOnboardingDraft(userId: string, conversationId: string): Promise<OnboardingProfileDraft | null> {
  const r = await getDb()
    .select({ draft: onboardingDrafts.draft })
    .from(onboardingDrafts)
    .where(and(eq(onboardingDrafts.conversationId, conversationId), eq(onboardingDrafts.userId, userId)));
  return r[0]?.draft ?? null;
}

export async function onboardingTurn(o: {
  userId: string;
  conversationId: string;
  text: string;
  mode: AgentMode;
  record?: boolean;
  model?: LanguageModel;
  choice?: ChoiceAnswer | undefined;
}): Promise<OnboardingMessageResponse> {
  const db = getDb();
  // One owner, one channel (history.ts): another user's id, or the caller's agent-chat id, is refused.
  await claimConversation(o.conversationId, o.userId, "onboarding");
  const u = (await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, o.userId)))[0];
  const current = (await getOnboardingDraft(o.userId, o.conversationId)) ?? emptyDraft();
  const existing = await loadPlaceholders(o.conversationId, o.userId);
  const redactor = new Redactor({ existing, names: u ? [{ name: u.displayName, kind: "PERSON", ref: u.displayName, personal: true }] : [] });
  const history = await loadHistory(o.conversationId, o.userId);
  const text = onboardingAnswer(history, o.text, o.choice);
  const userMsg: ModelMessage = {
    role: "user",
    content: `Current draft (JSON): ${JSON.stringify(redactor.redactValue(current))}\n\nUser: ${redactor.redactText(text)}`,
  };

  // Model: injected (tests) → REPLAY (the "onboarding" recording, for ANY user: exact text, keywords,
  // else the turn index, so it never depends on who is onboarding) → live planner from the registry.
  let base: LanguageModel;
  let recordedWith = "injected";
  const recorder = o.record && o.mode === "LIVE" && !o.model ? new StepRecorder() : null;
  if (o.model) base = o.model;
  else if (o.mode === "REPLAY") {
    base = replayModel(selectTurn(redactor.redactText(text), { scenario: "onboarding", priorUserTurns: history.filter((m) => m.role === "user").length }).turn);
    recordedWith = "replay";
  } else {
    base = getPlannerModel();
    recordedWith = plannerSpec().id;
  }
  const model = typeof base === "string" ? base : wrapLanguageModel({ model: base as Exclude<LanguageModel, string>, middleware: redactionMiddleware(redactor) });

  // Structured output via ai/structured.ts (native → forced schema-carrier tool → JSON text), validated
  // with TurnOutput. Provider failures become a typed AI_PROVIDER_UNAVAILABLE (route → 503), not a 500.
  let out: z.infer<typeof TurnOutput>;
  try {
    out = (await generateStructured({ model, schema: TurnOutput, instructions: ONBOARDING_INSTRUCTIONS, messages: [...history, userMsg], description: "Submit this turn's reply, updated draft and completeness." })).output;
  } catch (e) {
    throw aiProviderFailure(e, "planner");
  }
  // History keeps the answer as plain assistant JSON whatever the mode (a tool-mode call would leave an
  // orphan tool call in the next turn's prompt). This is also the recording format replay serves.
  const answer = JSON.stringify(out);
  const askId = `ob_${randomUUID().slice(0, 8)}`;
  // The model's own picker, else the buttons its reply calls for (pickers.ts): it often asks in prose only.
  const part = askPart(out.ask, askId) ?? fallbackPicker(out.reply, out.draft, askId);
  const ui = part ? [{ ...part, prompt: redactor.rehydrateForUser(part.prompt) }] : [];
  // The stored turn also carries the picker it showed, so the next answer is validated against it.
  const responseMessages: ModelMessage[] = [{ role: "assistant", content: ui.length ? JSON.stringify({ ...out, ui: part ? [part] : [] }) : answer }];
  recorder?.steps.push({ text: answer });
  const entries = [...redactor.entries()];
  const draft = OnboardingProfileDraft.parse(restore(out.draft, entries));
  const complete = out.complete && isComplete(draft);
  const now = clock.now();
  await db
    .insert(onboardingDrafts)
    .values({ conversationId: o.conversationId, userId: o.userId, draft, complete, updatedAt: now })
    .onConflictDoUpdate({ target: onboardingDrafts.conversationId, set: { draft, complete, updatedAt: now } });
  await appendHistory(o.conversationId, o.userId, "onboarding", [userMsg, ...responseMessages]);
  await savePlaceholders(o.conversationId, o.userId, redactor.drainNew());
  if (recorder) recorder.save("onboarding", redactor.redactText(text), recordedWith);
  return { reply: redactor.rehydrateForUser(out.reply), draft, complete, ui };
}

/** GET /onboarding/conversation: the caller's latest onboarding draft and its turns (rehydrated for the user). */
export async function latestOnboardingConversation(userId: string): Promise<OnboardingConversationResponse> {
  const row = (
    await getDb()
      .select({ conversationId: onboardingDrafts.conversationId, draft: onboardingDrafts.draft, complete: onboardingDrafts.complete })
      .from(onboardingDrafts)
      .where(eq(onboardingDrafts.userId, userId))
      .orderBy(desc(onboardingDrafts.updatedAt))
      .limit(1)
  )[0];
  if (!row) return { conversationId: null, draft: null, complete: false, turns: [] };
  const [messages, placeholders] = await Promise.all([loadAllMessages(row.conversationId, userId), loadPlaceholders(row.conversationId, userId)]);
  const redactor = new Redactor({ existing: placeholders });
  const turns: OnboardingConversationResponse["turns"] = [];
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") turns.push({ role: "user", text: redactor.rehydrateForUser(m.content.replace(/^Current draft \(JSON\):[\s\S]*?\n\nUser: /, "")), ui: [] });
    if (m.role === "assistant") {
      const a = parseAssistant(m.content);
      if (a) turns.push({ role: "assistant", text: redactor.rehydrateForUser(a.reply), ui: a.ui.map((p) => ({ ...p, prompt: redactor.rehydrateForUser(p.prompt) })) });
    }
  }
  // Answered pickers turn read-only: the next user turn is the answer.
  turns.forEach((t, i) => {
    const next = turns.slice(i + 1).find((x) => x.role === "user");
    if (!next) return;
    t.ui = t.ui.map((p) => {
      const o = p.options.length ? matchChoice(next.text, p) : null;
      return { ...p, answer: o ? { optionIds: [o.id], label: o.label } : { optionIds: [], label: next.text } };
    });
  });
  return { conversationId: row.conversationId, draft: row.draft, complete: row.complete, turns };
}

/**
 * ISO 3166-1 alpha-2 "ZZ" (user-assigned range, conventionally "unknown"): the chat captures no payee country; it
 * comes with the account details.
 */
const UNKNOWN_COUNTRY = "ZZ";

/**
 * Called by Track A's POST /onboarding/confirm after the passkey-signed base rules are stored: writes
 * the non-rule parts of the draft (incomes, budgets for the current month, cards, display name) and
 * the bills (DECISIONS 2026-10-13). A bill's payee is re-used by name + kind, else created as a
 * placeholder: COOLING, no account (accountEnc/accountHash NULL), no coolingUntil. Such a payee is never
 * payable (rules: PAYEE_ACCOUNT_MISSING; approve/payments: account hash mismatch; verify callback: 409)
 * until account details exist. Payee names are sanctions-screened like POST /payees (I9); a hit skips the
 * bill. Bills without a due date are skipped (they cannot be placed on the calendar).
 */
export async function applyOnboardingDraft(userId: string, draft: OnboardingProfileDraft): Promise<void> {
  const db = getDb();
  const now = clock.now();
  const today = isoDate(now);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const periodStart = `${today.slice(0, 7)}-01`;
  const periodEnd = isoDate(new Date(Date.UTC(y, m, 0)));
  await db.transaction(async (tx) => {
    if (draft.displayName) await tx.update(users).set({ displayName: draft.displayName }).where(eq(users.id, userId));
    if (draft.incomes.length > 0) {
      const incomes: IncomeJson[] = draft.incomes.map((i) => ({ source: i.source, currency: i.currency, amountMinor: i.amountMinor, cadence: i.cadence, nextDate: i.nextDate ?? today }));
      await tx.update(profiles).set({ incomes }).where(eq(profiles.userId, userId));
    }
    const existingBudgets = await tx.select({ category: budgets.category }).from(budgets).where(and(eq(budgets.userId, userId), eq(budgets.periodStart, periodStart)));
    for (const b of draft.budgets) {
      if (existingBudgets.some((e) => e.category === b.category)) continue;
      await tx.insert(budgets).values({ userId, category: b.category, periodStart, periodEnd, limitHomeMinor: b.limitHomeMinor });
    }
    const existingCards = await tx.select({ last4: cards.last4 }).from(cards).where(eq(cards.userId, userId));
    for (const c of draft.cards) {
      if (existingCards.some((e) => e.last4 === c.last4)) continue;
      await tx.insert(cards).values({ userId, label: c.label, last4: c.last4, billingCurrency: c.billingCurrency, kind: c.kind });
    }

    const userPayees = await tx.select({ id: payees.id, name: payees.name, kind: payees.kind }).from(payees).where(eq(payees.userId, userId));
    const userBills = await tx
      .select({ payeeId: obligations.payeeId, dueDate: obligations.dueDate, amountMinor: obligations.amountMinor, currency: obligations.currency })
      .from(obligations)
      .where(eq(obligations.userId, userId));
    for (const o of draft.obligations) {
      if (!o.dueDate) continue;
      const name = o.payeeName.trim();
      let payee = userPayees.find((p) => p.name === name && p.kind === o.payeeKind);
      if (!payee) {
        const screening = screenName(name);
        if (screening.hit) {
          await ledger.append(
            "PAYEE_SCREENING_HIT",
            { userId, reasonCodes: ["REFUSE_SANCTIONS"], entryId: screening.entryId, score: Math.round(screening.score * 10_000) / 10_000, source: "onboarding", ...(await sealPii(userId, { name }, tx)) },
            tx,
          );
          continue;
        }
        const inserted = (
          await tx
            .insert(payees)
            .values({ userId, name, kind: o.payeeKind, accountEnc: null, accountHash: null, country: UNKNOWN_COUNTRY, currency: o.currency, status: "COOLING", verifiedAt: null, coolingUntil: null, createdAt: now })
            .returning({ id: payees.id, name: payees.name, kind: payees.kind })
        )[0]!;
        await ledger.append("PAYEE_CREATED", { userId, payeeId: inserted.id, status: "COOLING", coolingUntil: null, accountMissing: true, replacesPayeeId: null, source: "onboarding" }, tx);
        userPayees.push(inserted);
        payee = inserted;
      }
      const payeeId = payee.id;
      if (userBills.some((b) => b.payeeId === payeeId && b.dueDate === o.dueDate && b.amountMinor === o.amountMinor && b.currency === o.currency)) continue;
      await tx.insert(obligations).values({ userId, payeeId, amountMinor: o.amountMinor, currency: o.currency, dueDate: o.dueDate, recurrence: o.recurrence, reference: null, category: o.category });
      userBills.push({ payeeId, dueDate: o.dueDate, amountMinor: o.amountMinor, currency: o.currency });
    }
  });
}
