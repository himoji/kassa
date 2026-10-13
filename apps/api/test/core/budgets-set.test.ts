/*
 * PUT /budgets (the chat's budgets card): a new or lower limit applies at once; a higher one is a loosening (I8):
 * 428 → passkey → pending 24 h → applied by the scheduler.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { budgets, ruleChanges } from "../../src/db/schema.ts";
import { clock, isoDate } from "../../src/modules/clock/index.ts";
import { applyDueRuleChanges } from "../../src/modules/users/settings.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { ledgerOf } from "../helpers/attacks.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

/** The limits active today on the test clock (a raise applied across a month end lands in the new month). */
async function limits(userId: string): Promise<Record<string, number>> {
  const today = isoDate(clock.now());
  const rows = (await getDb().select().from(budgets).where(eq(budgets.userId, userId))).filter((r) => r.periodStart <= today && today <= r.periodEnd);
  return Object.fromEntries(rows.map((r) => [r.category, r.limitHomeMinor]));
}

describe("PUT /budgets", () => {
  beforeEach(async () => {
    await t.reset();
    clock.setOffsetInMemoryForTests(0);
  });

  it("new and lower limits apply at once; a raise needs the passkey and waits 24 h", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const h = await bearer(userId);
    const put = (payload: Record<string, unknown>) => app().inject({ method: "PUT", url: "/api/budgets", headers: h, payload });

    const first = await put({ budgets: [{ category: "groceries", limitHomeMinor: 15_000_000 }, { category: "fun", limitHomeMinor: 4_000_000 }] });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ applied: ["groceries", "fun"], pending: [] });
    expect(await limits(userId)).toEqual({ groceries: 15_000_000, fun: 4_000_000 });

    const body = { budgets: [{ category: "groceries", limitHomeMinor: 20_000_000 }, { category: "fun", limitHomeMinor: 3_000_000 }] };
    const gate = await put(body);
    expect(gate.statusCode).toBe(428);
    expect(await limits(userId)).toEqual({ groceries: 15_000_000, fun: 4_000_000 }); // nothing applied without the passkey
    const { challengeId, webauthnOptions } = gate.json().details;

    const signed = await put({ ...body, challengeId, assertion: auth.assert(webauthnOptions.challenge) });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json().applied).toEqual(["fun"]);
    expect(signed.json().pending).toMatchObject([{ category: "groceries", limitHomeMinor: 20_000_000 }]);
    expect(await limits(userId)).toEqual({ groceries: 15_000_000, fun: 3_000_000 });
    expect(await ledgerOf("RULES_LOOSEN_PENDING")).toHaveLength(1);

    clock.setOffsetInMemoryForTests(23 * 3_600_000);
    expect(await applyDueRuleChanges()).toBe(0);
    clock.setOffsetInMemoryForTests(24 * 3_600_000 + 1000);
    expect(await applyDueRuleChanges()).toBe(1);
    expect((await limits(userId)).groceries).toBe(20_000_000);
    const applied = await getDb().select().from(ruleChanges).where(and(eq(ruleChanges.userId, userId), eq(ruleChanges.direction, "LOOSEN")));
    expect(applied[0]!.appliedAt).not.toBeNull();
  });

  it("a signature over another change is refused", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const h = await bearer(userId);
    const put = (payload: Record<string, unknown>) => app().inject({ method: "PUT", url: "/api/budgets", headers: h, payload });
    await put({ budgets: [{ category: "groceries", limitHomeMinor: 100 }] });
    const gate = (await put({ budgets: [{ category: "groceries", limitHomeMinor: 200 }] })).json().details;
    const res = await put({ budgets: [{ category: "groceries", limitHomeMinor: 999_999 }], challengeId: gate.challengeId, assertion: auth.assert(gate.webauthnOptions.challenge) });
    expect(res.statusCode).toBe(409);
    expect((await limits(userId)).groceries).toBe(100);
  });
});
