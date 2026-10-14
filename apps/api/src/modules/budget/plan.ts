import {
  FIXED_BUDGET_CATEGORIES,
  formatMoney,
  planOutcome,
  trimBudgetsForGoal,
  withBudgetChanges,
  type PlanAdviceRequest,
  type PlanAdviceResponse,
} from "@kassa/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
import { generateStructured, getPlannerModel } from "../ai/index.ts";
import { currentAgentMode } from "../ai/mode.ts";
import { aiProcessingAllowedFor } from "../privacy/notice.ts";

/*
 * POST /plan/advice (the "your rules" planner): where a savings goal lands, and which budgets to trim if it does not
 * fit. Advice only, never applied here: the app shows it and the user applies it to the sliders (and signs the rules
 * as usual). The numbers are always computed here (shared/plan.ts); the planner model may pick the trims and write
 * the summary when the user allows AI processing and Kassa runs LIVE, and its trims are clamped (existing
 * categories only, never raised, never below half). Anything else, or any model failure, falls back to the rule.
 * Only amounts and category ids reach the model: no names, no merchants.
 */

const AiAdvice = z.object({
  summary: z.string().min(1).max(400),
  budgets: z.array(z.object({ category: z.string(), limitHomeMinor: z.number().int() })).max(20),
});

const INSTRUCTIONS = `You help a student fit a savings goal into their monthly budget.
You get JSON with the currency, monthly income, fixed bills, monthly budgets per category (minor units: 100 = 1.00) and the goal.
Suggest lower limits ONLY for flexible categories (never ${[...FIXED_BUDGET_CATEGORIES].join(", ")}), each at most halved, so the goal fits if possible.
Prefer trimming eating out, shopping, fun and subscriptions before groceries and transport. Leave categories that need no change out of "budgets".
"summary": one or two short, friendly sentences in plain English saying what to trim and whether the goal fits; if it cannot fit, say how many months it would take instead. Amounts in major units with the currency code.`;

function money(minor: number, currency: string): string {
  return formatMoney(minor, currency, "en");
}

function rulesSummary(req: PlanAdviceRequest, changes: { category: string; limitHomeMinor: number }[]): string {
  const after = planOutcome({ ...req, budgets: withBudgetChanges(req.budgets, changes) });
  const c = req.currency;
  const months = req.goal.months;
  const before = planOutcome(req);
  if (changes.length === 0 && before.goalReached) {
    return `You're on track: ${money(before.monthlyLeftMinor, c)} left each month, about ${money(before.projectedMinor, c)} in ${months} months.`;
  }
  const trims = changes
    .map((ch) => {
      const was = req.budgets.find((b) => b.category === ch.category)!.limitHomeMinor;
      return `${ch.category.replace(/_/g, " ")} by ${money(was - ch.limitHomeMinor, c)}`;
    })
    .join(", ");
  const lead = trims ? `Trim ${trims} a month. ` : "";
  if (after.goalReached) return `${lead}That leaves ${money(after.monthlyLeftMinor, c)} a month, enough for ${money(req.goal.amountMinor, c)} in ${months} months.`;
  if (after.monthsToGoal) return `${lead}Even then the goal takes about ${after.monthsToGoal} months at ${money(after.monthlyLeftMinor, c)} a month; raise income or extend the goal.`;
  return `${lead}Bills and budgets already use all your income, so nothing is left to save yet.`;
}

/** The model's trims, kept only where they are a real, allowed cut. */
function clampAi(req: PlanAdviceRequest, budgets: z.infer<typeof AiAdvice>["budgets"]): { category: string; limitHomeMinor: number }[] {
  const current = new Map(req.budgets.map((b) => [b.category, b.limitHomeMinor]));
  const out: { category: string; limitHomeMinor: number }[] = [];
  for (const b of budgets) {
    const was = current.get(b.category);
    if (was === undefined || FIXED_BUDGET_CATEGORIES.has(b.category)) continue;
    const limit = Math.max(Math.ceil(was / 2), Math.min(was, Math.round(b.limitHomeMinor)));
    if (limit < was && !out.some((o) => o.category === b.category)) out.push({ category: b.category, limitHomeMinor: limit });
  }
  return out;
}

async function aiAllowed(userId: string): Promise<boolean> {
  if ((await currentAgentMode()) === "REPLAY") return false;
  const u = (
    await getDb()
      .select({ aiConsentAt: users.aiConsentAt, piplConsentAt: users.piplConsentAt, restrictedAt: users.restrictedAt, region: users.region })
      .from(users)
      .where(eq(users.id, userId))
  )[0];
  return !!u && aiProcessingAllowedFor(u);
}

function respond(req: PlanAdviceRequest, source: PlanAdviceResponse["source"], summary: string, changes: { category: string; limitHomeMinor: number }[]): PlanAdviceResponse {
  const o = planOutcome({ ...req, budgets: withBudgetChanges(req.budgets, changes) });
  return { source, summary, budgets: changes, monthlyLeftMinor: o.monthlyLeftMinor, projectedMinor: o.projectedMinor, monthsToGoal: o.monthsToGoal };
}

export async function planAdvice(userId: string, req: PlanAdviceRequest): Promise<PlanAdviceResponse> {
  if (await aiAllowed(userId)) {
    try {
      const { output } = await generateStructured({
        model: getPlannerModel(),
        schema: AiAdvice,
        instructions: INSTRUCTIONS,
        messages: [{ role: "user", content: JSON.stringify({ ...req, ...planOutcome(req) }) }],
        description: "Submit the summary and the suggested budget limits.",
      });
      return respond(req, "AI", output.summary, clampAi(req, output.budgets));
    } catch {
      // No key, provider down, invalid answer: the rule below still answers.
    }
  }
  const changes = trimBudgetsForGoal(req);
  return respond(req, "RULES", rulesSummary(req, changes), changes);
}
