import { jcs, jcsHash, type BudgetsSetRequest, type BudgetsSetResponse } from "@kassa/shared";
import { and, eq, gte, lte } from "drizzle-orm";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { budgets, ruleChanges } from "../../db/schema.ts";
import { auditAssertionFailure } from "../../http/audit.ts";
import { HttpProblem } from "../../http/problem.ts";
import { putGated, takeGated } from "../auth/challenges.ts";
import { clock, isoDate } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { assertionOptions, verifyRulesAssertion } from "../rules/webauthn.ts";

/*
 * PUT /budgets (the chat's budgets card, ask_budgets): this month's limit per category. Budgets feed the rules (a
 * category's remaining budget is part of the risk score, rules/risk.ts), so changing one is a rule change (I8):
 *  - a new category or a lower limit tightens: applied at once (rule_changes TIGHTEN, RULES_TIGHTENED);
 *  - a higher limit loosens: needs a passkey assertion over hash(change) (428 round trip), then applies at once
 *    too (rule_changes LOOSEN carrying the assertion, RULES_LOOSENED). No 24 h wait, like raised caps (DECISIONS).
 */

const KIND = "BUDGETS";

type Limits = Record<string, number>;

function currentPeriod(now: Date): { periodStart: string; periodEnd: string; today: string } {
  const today = isoDate(now);
  const [y, m] = today.split("-").map(Number) as [number, number];
  return { today, periodStart: `${today.slice(0, 7)}-01`, periodEnd: isoDate(new Date(Date.UTC(y, m, 0))) };
}

async function activeLimits(db: DbOrTx, userId: string, today: string): Promise<Map<string, { id: string; limit: number }>> {
  const rows = await db
    .select({ id: budgets.id, category: budgets.category, limit: budgets.limitHomeMinor })
    .from(budgets)
    .where(and(eq(budgets.userId, userId), lte(budgets.periodStart, today), gte(budgets.periodEnd, today)));
  return new Map(rows.map((r) => [r.category, { id: r.id, limit: r.limit }]));
}

/** Writes `after` into the budgets active today (a missing category gets this month's row). */
async function writeLimits(tx: DbOrTx, userId: string, after: Limits, now: Date): Promise<void> {
  const { today, periodStart, periodEnd } = currentPeriod(now);
  const existing = await activeLimits(tx, userId, today);
  for (const [category, limitHomeMinor] of Object.entries(after)) {
    const row = existing.get(category);
    if (row) await tx.update(budgets).set({ limitHomeMinor }).where(eq(budgets.id, row.id));
    else await tx.insert(budgets).values({ userId, category, periodStart, periodEnd, limitHomeMinor });
  }
}

export async function setBudgets(userId: string, body: BudgetsSetRequest): Promise<BudgetsSetResponse> {
  const db = getDb();
  const now = clock.now();
  const existing = await activeLimits(db, userId, isoDate(now));
  const tighten: { before: Limits; after: Limits } = { before: {}, after: {} };
  const loosen: { before: Limits; after: Limits } = { before: {}, after: {} };
  for (const b of body.budgets) {
    const cur = existing.get(b.category)?.limit;
    if (cur === b.limitHomeMinor) continue;
    const side = cur !== undefined && b.limitHomeMinor > cur ? loosen : tighten;
    if (cur !== undefined) side.before[b.category] = cur;
    side.after[b.category] = b.limitHomeMinor;
  }
  const hasLoosen = Object.keys(loosen.after).length > 0;
  const loosenCore = hasLoosen ? { v: 1, kind: KIND, userId, before: loosen.before, after: loosen.after } : null;

  let assertion: unknown = null;
  let changeHash = "";
  if (loosenCore) {
    if (!body.challengeId || !body.assertion) {
      const hash = jcsHash(loosenCore);
      const challengeId = putGated({ userId, purpose: "budgets", hash, payload: loosenCore });
      throw new HttpProblem(428, "PASSKEY_REQUIRED", "Raising a budget needs your passkey", {
        reasonCodes: ["PASSKEY_REQUIRED", "LOOSEN_PENDING"],
        details: { challengeId, webauthnOptions: await assertionOptions(db, userId, hash) },
      });
    }
    const gated = takeGated(body.challengeId, userId, "budgets");
    if (!gated || jcs(gated.payload) !== jcs(loosenCore)) {
      throw new HttpProblem(409, "CHALLENGE_MISMATCH", "The signed change differs from this request; start again");
    }
    const check = await verifyRulesAssertion(db, { userId, assertion: body.assertion, expectedChallenge: gated.hash, challengeReason: "ASSERTION_INVALID" });
    if (!check.ok) {
      await auditAssertionFailure(userId, "budgets", check.reason);
      throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
    }
    assertion = body.assertion;
    changeHash = gated.hash;
  }

  await db.transaction(async (tx) => {
    if (Object.keys(tighten.after).length > 0) {
      await writeLimits(tx, userId, tighten.after, now);
      const row = await tx
        .insert(ruleChanges)
        .values({
          userId,
          kind: KIND,
          before: tighten.before,
          after: tighten.after,
          direction: "TIGHTEN",
          changeHash: jcsHash({ v: 1, kind: KIND, userId, ...tighten }),
          effectiveAt: now,
          appliedAt: now,
          createdAt: now,
        })
        .returning({ id: ruleChanges.id });
      await ledger.append("RULES_TIGHTENED", { userId, ruleChangeId: row[0]!.id, kind: KIND, after: tighten.after }, tx);
    }
    if (loosenCore) {
      await writeLimits(tx, userId, loosen.after, now);
      const row = await tx
        .insert(ruleChanges)
        .values({ userId, kind: KIND, before: loosen.before, after: loosen.after, direction: "LOOSEN", assertion: assertion as never, changeHash, effectiveAt: now, appliedAt: now, createdAt: now })
        .returning({ id: ruleChanges.id });
      await ledger.append("RULES_LOOSENED", { userId, ruleChangeId: row[0]!.id, kind: KIND, changeHash, after: loosen.after }, tx);
    }
  });
  return { applied: [...Object.keys(tighten.after), ...Object.keys(loosen.after)] };
}
