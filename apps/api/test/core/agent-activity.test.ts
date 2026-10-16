/*
 * GET /agent/activity: the Home card's "what Kassa did". Only the agent's and the scheduler's proposals, in the
 * window, each with its outcome; the user's own sends are not listed. Fictitious payees only.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { proposals } from "../../src/db/schema.ts";
import { clock, DAY_MS } from "../../src/modules/clock/index.ts";
import { agentOutcome } from "../../src/modules/orders/routes.ts";
import { createPayee } from "../../src/modules/payees/service.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

type Row = typeof proposals.$inferInsert;

describe("GET /agent/activity", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("maps every status to the user's terms", () => {
    expect(agentOutcome({ decision: "AUTO", status: "EXECUTED" })).toBe("PAID_AUTO");
    expect(agentOutcome({ decision: "ASK", status: "EXECUTED" })).toBe("PAID_APPROVED");
    expect(agentOutcome({ decision: "ASK", status: "PENDING_APPROVAL" })).toBe("WAITING");
    expect(agentOutcome({ decision: "REFUSE", status: "REFUSED" })).toBe("HELD");
    expect(agentOutcome({ decision: "ASK", status: "REJECTED" })).toBe("DECLINED");
    expect(agentOutcome({ decision: "ASK", status: "EXPIRED" })).toBe("OTHER");
  });

  it("lists the agent's and the scheduler's proposals of the last 7 days with outcomes, counts and payee names", async () => {
    const { userId } = await createUserWithPasskey({ counter: 1 });
    const other = await createUserWithPasskey({ counter: 1 });
    const payee = await createPayee(userId, { name: "Landlord in Budapest", kind: "LANDLORD", account: "HU42117730161111101800000000", country: "HU", currency: "HUF" });
    const now = clock.now();
    const base = (over: Partial<Row>): Row => ({
      userId,
      createdBy: "AGENT",
      draft: { payeeId: payee.id, amountMinor: 18_000_000, currency: "HUF", purpose: "Rent" },
      decision: "ASK",
      riskScore: 0.1,
      status: "PENDING_APPROVAL",
      category: "rent",
      createdAt: now,
      ...over,
    });
    await getDb().insert(proposals).values([
      base({ createdBy: "SCHEDULER", decision: "AUTO", status: "EXECUTED", canonicalOrder: { payeeName: "Landlord in Budapest" } as never }),
      base({}),
      base({ decision: "REFUSE", status: "REFUSED", reasonCodes: ["PAYEE_COOLING"] }),
      base({ createdBy: "USER", status: "EXECUTED" }),
      base({ createdAt: new Date(now.getTime() - 9 * DAY_MS) }),
      base({ userId: other.userId }),
    ]);
    const res = await app().inject({ method: "GET", url: "/api/agent/activity", headers: await bearer(userId) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { counts: Record<string, number>; items: Array<{ outcome: string; payeeName: string; reasonCodes: string[] }> };
    expect(body.counts).toEqual({ PAID_AUTO: 1, PAID_APPROVED: 0, WAITING: 1, HELD: 1, DECLINED: 0, OTHER: 0 });
    expect(body.items).toHaveLength(3);
    expect(body.items.every((i) => i.payeeName === "Landlord in Budapest")).toBe(true);
    expect(body.items.find((i) => i.outcome === "HELD")?.reasonCodes).toEqual(["PAYEE_COOLING"]);
    expect((await app().inject({ method: "GET", url: "/api/agent/activity" })).statusCode).toBe(401);
  });
});
