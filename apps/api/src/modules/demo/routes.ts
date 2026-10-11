/*
 * Demo routes (spec §8, §15), only when DEMO_ENABLED=true (server.ts does not even register them otherwise;
 * production refuses to start with DEMO_ENABLED unless DEMO_ADMIN_TOKEN has ≥ 32 characters, env.ts).
 * Admin calls need header x-kassa-demo-token = DEMO_ADMIN_TOKEN, compared in constant time over SHA-256
 * digests (equal length, so neither content nor length leaks through timing). Without a configured token
 * admin calls are refused, except under NODE_ENV=test. GET /demo/clock is public so mock-world can follow
 * the demo clock (coordination doc).
 */
import { DEMO_TOKEN_HEADER, DemoAgentModeRequest, DemoClockAdvanceRequest, DemoScenario, DemoStateResponse } from "@kassa/shared";
import { and, asc, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { demoState, transactions, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { HttpProblem } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { notify } from "../notifications/service.ts";
import { mockWorld } from "../rails/http.ts";
import { tick } from "../scheduler/index.ts";
import { loadSeedData, seedDatabase } from "./seed.ts";

function assertDemoEnabled(): void {
  if (!env().DEMO_ENABLED) throw new HttpProblem(404, "NOT_FOUND", "Demo mode is disabled");
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time token check (both sides hashed to 32 bytes first). */
export function demoTokenMatches(got: unknown, expected: string): boolean {
  return timingSafeEqual(digest(typeof got === "string" ? got : ""), digest(expected));
}

function assertAdmin(req: FastifyRequest): void {
  assertDemoEnabled();
  const expected = env().DEMO_ADMIN_TOKEN;
  if (!expected) {
    if (env().NODE_ENV === "test") return; // unit tests without a token
    throw new HttpProblem(403, "FORBIDDEN", "DEMO_ADMIN_TOKEN not configured (bun run env:setup)");
  }
  if (!demoTokenMatches(req.headers[DEMO_TOKEN_HEADER], expected)) throw new HttpProblem(403, "FORBIDDEN", "Bad demo admin token");
}

async function state() {
  await clock.load();
  const ds = (await getDb().select().from(demoState).where(eq(demoState.id, 1)))[0];
  return { now: clock.now().toISOString(), clockOffsetMs: clock.offsetMs(), agentMode: ds?.agentMode ?? env().AGENT_MODE };
}

async function demoUserId(): Promise<string> {
  const ds = (await getDb().select().from(demoState).where(eq(demoState.id, 1)))[0];
  if (ds?.demoUserId) return ds.demoUserId;
  const u = (await getDb().select({ id: users.id }).from(users).limit(1))[0];
  if (!u) throw new HttpProblem(409, "DEMO_NOT_SEEDED", "Run the seed first");
  return u.id;
}

/** Scenario triggers (spec §15). Triggers only create events/drafts — never approvals (I6). */
async function trigger(scenario: DemoScenario): Promise<Record<string, unknown>> {
  const userId = await demoUserId();
  const db = getDb();
  switch (scenario) {
    case "settlement": {
      // Settle the oldest pending foreign purchase on the home card (+~4% example markup) via Track B capture.
      const u = (await db.select().from(users).where(eq(users.id, userId)))[0]!;
      const t = (
        await db
          .select()
          .from(transactions)
          .where(and(eq(transactions.userId, userId), eq(transactions.status, "PENDING"), ne(transactions.currency, u.homeCurrency)))
          .orderBy(asc(transactions.occurredAt))
          .limit(1)
      )[0];
      if (!t || t.homeAmountMinor === null) return { settled: false, reason: "no pending foreign purchase" };
      const path = new URL("../capture/index.ts", import.meta.url).href;
      const capture = (await import(/* @vite-ignore */ path)) as {
        reconcileSettlement?: (userId: string, ev: Record<string, unknown>) => Promise<unknown>;
      };
      if (!capture.reconcileSettlement) return { settled: false, reason: "capture module missing" };
      const result = await capture.reconcileSettlement(userId, {
        transactionId: t.id,
        amountMinor: t.amountMinor,
        currency: t.currency,
        settledAmountMinor: Math.round((t.homeAmountMinor * 10_400) / 10_000),
        settledCurrency: u.homeCurrency,
      });
      return { settled: true, result };
    }
    case "money-from-home":
      // A ₸1,000,000 transfer from the parents, sent early for tuition: the seeded wallet cannot fund
      // €2,400 from any single balance (B2, docs/DECISIONS.md 2026-10-11 "demo story").
      return { mock: await mockWorld("POST", "/remittance/incoming", { userId, amountMinor: 100_000_000, currency: "KZT" }).catch((e: Error) => ({ error: e.message })) };
    case "pos-low-dough":
      return { mock: await mockWorld("POST", "/pos/emit", { sku: "dough", level: "low" }).catch((e: Error) => ({ error: e.message })) };
    case "landlord-iban-email":
      await notify(userId, {
        kind: "INBOX_NEW_EMAIL",
        title: "New email",
        body: "Your inbox has a new message about your rent (simulated). Ask Kassa to read it.",
        data: { scenario },
      });
      return { inbox: "delivered" };
  }
}

/** Admin check before body parsing/validation (no schema hints to callers without the token). */
const admin = { onRequest: async (req: FastifyRequest) => assertAdmin(req) };

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/demo/clock", { schema: { response: { 200: DemoStateResponse } } }, async () => {
    assertDemoEnabled();
    return state();
  });

  app.post("/demo/clock/advance", { ...admin, schema: { body: DemoClockAdvanceRequest, response: { 200: DemoStateResponse } } }, async (req) => {
    await clock.advanceHours(req.body.hours);
    await ledger.append("DEMO_CLOCK_ADVANCED", { hours: req.body.hours, now: clock.now().toISOString() });
    await tick((msg, err) => req.log.error({ err }, msg));
    return state();
  });

  app.post("/demo/reset", { ...admin, schema: { response: { 200: DemoStateResponse } } }, async (req) => {
    await seedDatabase(getDb(), await loadSeedData(), { reset: true });
    // Mock world keeps its own in-memory state (wallet, transfers, QR codes): reset it too (best effort).
    await mockWorld("POST", "/reset", {}).catch((err: Error) => req.log.warn({ err }, "mock-world reset failed"));
    return state();
  });

  app.post("/demo/agent-mode", { ...admin, schema: { body: DemoAgentModeRequest, response: { 200: DemoStateResponse } } }, async (req) => {
    await getDb()
      .insert(demoState)
      .values({ id: 1, agentMode: req.body.mode })
      .onConflictDoUpdate({ target: demoState.id, set: { agentMode: req.body.mode } });
    await ledger.append("DEMO_AGENT_MODE", { mode: req.body.mode });
    return state();
  });

  app.post(
    "/demo/trigger/:scenario",
    { ...admin, schema: { params: z.object({ scenario: DemoScenario }), response: { 200: DemoStateResponse.extend({ result: z.unknown() }) } } },
    async (req) => {
      const result = await trigger(req.params.scenario);
      await ledger.append("DEMO_TRIGGER", { scenario: req.params.scenario });
      return { ...(await state()), result };
    },
  );
};

export default routes;
