import { wrapLanguageModel, type LanguageModel, type ModelMessage } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { OnboardingProfileDraft, type AgentMode, type OnboardingMessageResponse } from "@kassa/shared";

import { getDb } from "../../db/client.ts";
import { budgets, cards, obligations, payees, profiles, users, type IncomeJson } from "../../db/schema.ts";
import { onboardingDrafts } from "../../db/schema.intel.ts";
import { aiProviderFailure } from "../ai/errors.ts";
import { getPlannerModel, plannerSpec } from "../ai/models.ts";
import { generateStructured } from "../ai/structured.ts";
import { clock, isoDate } from "../clock/index.ts";
import { appendHistory, loadHistory, loadPlaceholders, savePlaceholders } from "../agent/history.ts";
import { redactionMiddleware } from "../agent/middleware.ts";
import { Redactor, type PlaceholderEntry } from "../agent/redact.ts";
import { replayModel, selectTurn, StepRecorder } from "../agent/replay.ts";
import { ledger } from "../ledger/index.ts";
import { sealPii } from "../privacy/keys.ts";
import { screenName } from "../screening/index.ts";

/*
 * Onboarding chat (spec §8 POST /onboarding/message): one planner call per turn with structured output
 * {reply, draft, complete}. User text is redacted before the call (I11); placeholders in the model's
 * draft are restored server-side. Confirmation (passkey-signed base rules) is Track A's
 * /onboarding/confirm, which calls getOnboardingDraft / applyOnboardingDraft below.
 */

export const ONBOARDING_INSTRUCTIONS = `You are Kassa's onboarding assistant for a student finance app. Have a short, friendly chat to learn:
home currency (ISO 4217), region (EU or CN), incomes (source, currency, amount, cadence, next date), recurring bills (payee name, kind, amount, currency, due date, recurrence, category), monthly budgets per category in the home currency, cards (label, last 4 digits, billing currency, kind), preferred preset (ASK_ME, SMART, AUTOPILOT), money mode and notification mode (EACH, THRESHOLDS, DIGEST).
Rules:
- Update "draft" with every fact the user states; keep facts from the current draft unless the user corrects them. Never invent values: leave unknown fields null or lists empty.
- Amounts are integer minor units (cents): ₸600,000 = 60000000 KZT; €2,400 = 240000 EUR.
- Placeholders like person_1 or iban_1 stand for personal data; copy them as they are.
- Ask one or two questions per reply. Set "complete" true only when home currency, region, preset, notification mode, at least one income and at least one budget are known.`;

const TurnOutput = z.object({
  reply: z.string(),
  draft: OnboardingProfileDraft,
  complete: z.boolean(),
});

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
}): Promise<OnboardingMessageResponse> {
  const db = getDb();
  const owner = (await db.select({ userId: onboardingDrafts.userId }).from(onboardingDrafts).where(eq(onboardingDrafts.conversationId, o.conversationId)))[0];
  if (owner && owner.userId !== o.userId) throw Object.assign(new Error("conversation belongs to another user"), { code: "CONVERSATION_FORBIDDEN" });
  const u = (await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, o.userId)))[0];
  const current = (await getOnboardingDraft(o.userId, o.conversationId)) ?? emptyDraft();
  const existing = await loadPlaceholders(o.conversationId);
  const redactor = new Redactor({ existing, names: u ? [{ name: u.displayName, kind: "PERSON", ref: u.displayName, personal: true }] : [] });
  const history = await loadHistory(o.conversationId, o.userId);
  const userMsg: ModelMessage = {
    role: "user",
    content: `Current draft (JSON): ${JSON.stringify(redactor.redactValue(current))}\n\nUser: ${redactor.redactText(o.text)}`,
  };

  // Model: injected (tests) → REPLAY (the "onboarding" recording, for ANY user: exact text, keywords,
  // else the turn index, so it never depends on who is onboarding) → live planner from the registry.
  let base: LanguageModel;
  let recordedWith = "injected";
  const recorder = o.record && o.mode === "LIVE" && !o.model ? new StepRecorder() : null;
  if (o.model) base = o.model;
  else if (o.mode === "REPLAY") {
    base = replayModel(selectTurn(redactor.redactText(o.text), { scenario: "onboarding", priorUserTurns: history.filter((m) => m.role === "user").length }).turn);
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
  const responseMessages: ModelMessage[] = [{ role: "assistant", content: answer }];
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
  await savePlaceholders(o.conversationId, redactor.drainNew());
  if (recorder) recorder.save("onboarding", redactor.redactText(o.text), recordedWith);
  return { reply: redactor.rehydrateForUser(out.reply), draft, complete };
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
