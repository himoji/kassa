/*
 * Demo routes (spec §8, §15), only when DEMO_ENABLED=true (server.ts does not even register them otherwise;
 * production refuses to start with DEMO_ENABLED unless DEMO_ADMIN_TOKEN has ≥ 32 characters, env.ts).
 * Admin calls need header x-kassa-demo-token = DEMO_ADMIN_TOKEN, compared in constant time over SHA-256
 * digests (equal length, so neither content nor length leaks through timing). Without a configured token
 * admin calls are refused, except under NODE_ENV=test. GET /demo/clock is public so mock-world can follow
 * the demo clock (coordination doc).
 */
import {
  DEMO_TOKEN_HEADER,
  DemoAgentModeRequest,
  DemoClockAdvanceRequest,
  DemoClockModeRequest,
  DemoScenario,
  DemoStateResponse,
  ReaderDocType,
  SettlementEventRequest,
  SettlementEventResponse,
  sha256Base64url,
} from "@kassa/shared";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { cards, demoState, devices, transactions, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { HttpProblem } from "../../http/problem.ts";
import { clock, isoDate } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { notify } from "../notifications/service.ts";
import { mockWorld } from "../rails/http.ts";
import { ingestCapture, reconcileSettlement, SettlementError } from "../capture/service.ts";
import { DocumentError, storeDocument } from "../reader/index.ts";
import { forecastTick } from "../business/scheduler.ts";
import { proposeDue, tick } from "../scheduler/index.ts";
import { dueHorizon } from "../scheduler/window.ts";
import { judgeModeActive } from "../auth/dev.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { bankMode } from "../rails/bankApi.ts";
import { MONEY_FROM_HOME_DAILY_MAX, moneyFromHomeToday, sendMoneyFromHome } from "./judgeCopy.ts";
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
  return { now: clock.now().toISOString(), clockOffsetMs: clock.offsetMs(), clockMode: clock.mode(), agentMode: ds?.agentMode ?? env().AGENT_MODE };
}

async function demoUserId(): Promise<string> {
  const ds = (await getDb().select().from(demoState).where(eq(demoState.id, 1)))[0];
  if (ds?.demoUserId) return ds.demoUserId;
  const u = (await getDb().select({ id: users.id }).from(users).limit(1))[0];
  if (!u) throw new HttpProblem(409, "DEMO_NOT_SEEDED", "Run the seed first");
  return u.id;
}

/**
 * D-CN2 "a spending day in Shanghai": the two Chinese wallet notices (Alipay-style, WeChat Pay-style; no card)
 * and the Kazakh bank's notice of a CNY purchase on the home KZT card (*4821), from fixtures/notifications.
 */
export const CN_SPENDING_DAY_SAMPLES = ["alipay-cn-purchase.txt", "wechat-pay-cn-purchase.txt", "kz-bank-ru-cny-purchase.txt"] as const;
const NOTIFICATIONS_DIR = new URL("../../../../../fixtures/notifications/", import.meta.url);

/** Scenario triggers (spec §15). Triggers only create events/drafts — never approvals (I6). */
async function trigger(scenario: DemoScenario): Promise<Record<string, unknown>> {
  const userId = await demoUserId();
  const db = getDb();
  switch (scenario) {
    case "settlement": {
      // Settle the oldest pending foreign purchase on the home card (+~4% example markup) via Track B capture.
      // Only charges on a card billed in the home currency: a wallet payment (no card, e.g. the Alipay/WeChat
      // samples of cn-spending-day) never settles in KZT on a card statement.
      const u = (await db.select().from(users).where(eq(users.id, userId)))[0]!;
      const homeCards = (await db.select({ id: cards.id }).from(cards).where(and(eq(cards.userId, userId), eq(cards.billingCurrency, u.homeCurrency)))).map((c) => c.id);
      if (homeCards.length === 0) return { settled: false, reason: "no card billed in the home currency" };
      const t = (
        await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.userId, userId),
              eq(transactions.status, "PENDING"),
              ne(transactions.currency, u.homeCurrency),
              inArray(transactions.cardId, homeCards),
            ),
          )
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
      // €2,400 from any single balance (B2, docs/architecture/decisions.md 2026-10-11 "demo story").
      return { mock: await mockWorld("POST", "/remittance/incoming", { userId, amountMinor: 100_000_000, currency: "KZT" }).catch((e: Error) => ({ error: e.message })) };
    case "pos-low-dough":
      // The Budapest pizzeria's till reports dough balls running low. Shape = mock-world PosBody (routes/events.ts):
      // an uppercase SKU, an integer level in `unit`, the storeId (= merchants.slug). A trigger only logs (I6).
      return {
        mock: await mockWorld("POST", "/pos/emit", { sku: "DOUGH-BALL", level: 12, unit: "pcs", storeId: "bud" }).catch((e: Error) => ({ error: e.message })),
      };
    case "cn-spending-day": {
      // Capture only logs (I6): each notice is parsed, logged in CNY, converted to the home currency at the
      // purchase-date rate and budgeted; nothing is proposed or paid.
      const captured = [];
      for (const file of CN_SPENDING_DAY_SAMPLES) {
        const rawText = await readFile(new URL(file, NOTIFICATIONS_DIR), "utf8");
        captured.push({ sample: file, ...(await ingestCapture(userId, { source: "NOTIF_SIM", rawText })) });
      }
      return { captured };
    }
    case "business-forecast":
      // The business forecast tick (scheduler job business.forecastTick) now, for every business owner: stock short by
      // the end of tomorrow -> a DRAFT purchase order + the owner's shortage notice. Drafts only; signing is the owner's (I6).
      return { drafted: await forecastTick(clock.now()) };
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

/**
 * Demo Stage (mock-world /mock/stage, docs/architecture/decisions.md 2026-10-13 "Demo Stage"): the "outside world" acts for the
 * demo user the way a device or a statement would. Same admin token as the triggers; each route reuses the user-facing
 * code path (Shortcut device token, settlement reconcile, document store) and, like every trigger, only logs or
 * stores: nothing here proposes, approves or pays (I6).
 */
const StageDocumentBody = z.object({
  filename: z.string().min(1).max(120),
  mediaType: z.enum(["application/pdf", "text/plain"]),
  kind: ReaderDocType.optional(),
  /** RFC 4648 §4 base64; stays under the 1 MiB JSON body limit. */
  dataB64: z.string().min(4).max(900_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

/**
 * (added 2026-10-18) "Money from home" for the signed-in user's own wallet: the judge build (JUDGE_MODE, every reviewer
 * on a private copy) and dev sign-in sessions only. The admin trigger above credits the seeded demo user; a reviewer has
 * no admin token and must only ever move money into their own copy, so the profile comes from the session and nothing
 * in the request names one. Like the trigger it only adds simulated money and the signed remittance notice (I6):
 * nothing is proposed or paid. One amount per home currency, about EUR 2,000 (Dana's parents send KZT 1,000,000, the
 * demo story: then tuition can be paid).
 */
export { MONEY_FROM_HOME_MINOR } from "./judgeCopy.ts";
const MoneyFromHomeResponse = z.object({
  currency: z.string().length(3),
  amountMinor: z.number().int().positive(),
  balanceAfterMinor: z.number().int().nonnegative(),
  simulated: z.literal(true),
});

/** Own-account demo actions: the judge build (every reviewer on a private copy) or a dev sign-in session, never Lite. */
function assertOwnDemoAllowed(req: FastifyRequest, what: string): void {
  assertDemoEnabled();
  if (req.session?.scope === "lite") throw new HttpProblem(403, "LITE_SESSION", "A KassaLite device cannot do this");
  if (!judgeModeActive() && req.session?.dev !== true) {
    throw new HttpProblem(403, "NOT_DEMO_SESSION", `${what} is a demo action for the judge build and dev sign-in sessions`);
  }
}

function assertOwnMoneyAllowed(req: FastifyRequest): void {
  assertOwnDemoAllowed(req, "Money from home");
  if (bankMode() !== "mock") throw new HttpProblem(409, "NOT_MOCK_BANK", "Money from home needs the simulated bank");
}

/**
 * (added 2026-10-19) "Run today's scheduled payments" for the signed-in user's OWN account: the scheduler's due-bills
 * pass (scheduler/index.ts proposeDue) for this user only, at the Clock's date (never moved, never overridden). Bills
 * due within the window (scheduler/window.ts) get their proposal now instead of at the next tick: a bill covered by a
 * signed mandate is paid without a prompt (T1), anything else waits for the passkey. Same code, same rules and payments
 * checks as the 15 s job; a judge copy's mandate-covered rent is due within the window from sign-in (demo/judgeCopy.ts).
 */
const RunDuePaymentsResponse = z.object({
  today: z.string(),
  dueBy: z.string(),
  results: z.array(
    z.object({
      obligationId: z.string().uuid(),
      category: z.string(),
      dueDate: z.string(),
      outcome: z.enum(["PROPOSED", "PAID", "PENDING", "TRIED"]),
      proposalId: z.string().uuid().nullable(),
      decision: z.enum(["AUTO", "ASK", "REFUSE", "HANDOFF"]).nullable(),
      reasonCodes: z.array(z.string()),
      paymentStatus: z.string().nullable(),
    }),
  ),
});

/** Admin check before body parsing/validation (no schema hints to callers without the token). */
const admin = { onRequest: async (req: FastifyRequest) => assertAdmin(req) };

const routes: FastifyPluginAsyncZod = async (app) => {
  // logLevel warn: mock-world polls this endpoint, keep it out of the request log.
  app.get("/demo/clock", { logLevel: "warn", schema: { response: { 200: DemoStateResponse } } }, async () => {
    assertDemoEnabled();
    return state();
  });

  app.post("/demo/clock/advance", { ...admin, schema: { body: DemoClockAdvanceRequest, response: { 200: DemoStateResponse } } }, async (req) => {
    await clock.advanceHours(req.body.hours);
    await ledger.append("DEMO_CLOCK_ADVANCED", { hours: req.body.hours, now: clock.now().toISOString() });
    await tick((msg, err) => req.log.error({ err }, msg));
    return state();
  });

  // Real or demo time. Switching to DEMO resumes the stored demo offset; REAL keeps it for later.
  app.post("/demo/clock/mode", { ...admin, schema: { body: DemoClockModeRequest, response: { 200: DemoStateResponse } } }, async (req) => {
    await clock.load();
    await clock.setMode(req.body.mode);
    await ledger.append("DEMO_CLOCK_MODE", { mode: req.body.mode, now: clock.now().toISOString() });
    await tick((msg, err) => req.log.error({ err }, msg));
    return state();
  });

  app.post("/demo/reset", { ...admin, schema: { response: { 200: DemoStateResponse } } }, async (req) => {
    // The reset keeps the clock mode the Stage chose (real time stays real).
    await clock.load();
    await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true, clockMode: clock.mode() });
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

  app.post(
    "/demo/money-from-home",
    { preHandler: requireUser, schema: { body: z.object({}).strict().optional(), response: { 200: MoneyFromHomeResponse } } },
    async (req) => {
      assertOwnMoneyAllowed(req);
      const userId = userIdOf(req);
      const u = (await getDb().select({ id: users.id }).from(users).where(eq(users.id, userId)))[0];
      if (!u) throw new HttpProblem(404, "NOT_FOUND", "User not found");
      // A demo button, not a money printer: a few presses per account per day.
      if ((await moneyFromHomeToday(userId)) >= MONEY_FROM_HOME_DAILY_MAX) {
        throw new HttpProblem(429, "DEMO_MONEY_DAILY_LIMIT", `Parents can send money ${MONEY_FROM_HOME_DAILY_MAX} times a day in the demo. Try again tomorrow.`, {
          details: { maxPerDay: MONEY_FROM_HOME_DAILY_MAX },
        });
      }
      try {
        const r = await sendMoneyFromHome(userId);
        return { ...r, simulated: true as const };
      } catch (err) {
        req.log.warn({ err }, "money from home: mock world refused");
        throw new HttpProblem(503, "BANK_UNAVAILABLE", "The simulated bank is not answering; try again shortly");
      }
    },
  );

  app.post(
    "/demo/run-due-payments",
    { preHandler: requireUser, schema: { body: z.object({}).strict().optional(), response: { 200: RunDuePaymentsResponse } } },
    async (req) => {
      assertOwnDemoAllowed(req, "Running the scheduled payments");
      const userId = userIdOf(req);
      await clock.load();
      const now = clock.now();
      const results = await proposeDue({ userId });
      await ledger.append("DEMO_TRIGGER", { scenario: "run-due-payments", userId, self: true, proposed: results.filter((r) => r.outcome === "PROPOSED").length });
      return {
        today: isoDate(now),
        dueBy: dueHorizon(now),
        results: results.map((r) => ({
          obligationId: r.obligationId,
          category: r.category,
          dueDate: r.dueDate,
          outcome: r.outcome,
          proposalId: r.proposal?.proposalId ?? null,
          decision: r.proposal?.decision ?? null,
          reasonCodes: r.proposal?.reasonCodes ?? [],
          paymentStatus: r.proposal?.paymentStatus ?? null,
        })),
      };
    },
  );

  // Stage: an iOS Shortcut device token for the demo user (same shape as POST /devices/shortcut, I13: only the hash is stored).
  app.post(
    "/demo/stage/shortcut-token",
    { ...admin, schema: { body: z.object({}).strict(), response: { 201: z.object({ deviceId: z.string().uuid(), token: z.string() }) } } },
    async (_req, reply) => {
      const userId = await demoUserId();
      const token = `ksc_${randomBytes(32).toString("base64url")}`;
      const rows = await getDb()
        .insert(devices)
        .values({ userId, kind: "IOS_SHORTCUT", tokenHash: sha256Base64url(token) })
        .returning({ id: devices.id });
      await ledger.append("DEVICE_TOKEN_CREATED", { userId, deviceId: rows[0]!.id, kind: "IOS_SHORTCUT", via: "demo-stage" });
      return reply.status(201).send({ deviceId: rows[0]!.id, token });
    },
  );

  // Stage: a card statement line for the demo user (as POST /capture/settlement; DCC receipts carry the local price).
  app.post(
    "/demo/stage/settlement",
    { ...admin, schema: { body: SettlementEventRequest, response: { 200: SettlementEventResponse } } },
    async (req) => {
      try {
        return await reconcileSettlement(await demoUserId(), req.body);
      } catch (e) {
        if (e instanceof SettlementError) throw new HttpProblem(e.code === "SETTLEMENT_NO_MATCH" ? 404 : 409, e.code, e.message);
        throw e;
      }
    },
  );

  // Stage: "Forward to Kassa" from the simulated mail app. Stored like POST /agent/documents (untrusted data for the
  // Reader, I10); the user is told about it and decides in the app.
  app.post(
    "/demo/stage/document",
    { ...admin, schema: { body: StageDocumentBody, response: { 200: z.object({ docId: z.string().uuid() }) } } },
    async (req) => {
      const userId = await demoUserId();
      let docId: string;
      try {
        docId = await storeDocument(userId, {
          data: new Uint8Array(Buffer.from(req.body.dataB64, "base64")),
          mediaType: req.body.mediaType,
          filename: req.body.filename,
          kind: req.body.kind ?? null,
        });
      } catch (e) {
        if (e instanceof DocumentError) throw new HttpProblem(e.code === "DOC_TOO_LARGE" ? 413 : e.code === "DOC_UNSUPPORTED_TYPE" ? 415 : 400, e.code, e.message);
        throw e;
      }
      await notify(userId, {
        kind: "INBOX_NEW_EMAIL",
        title: "Forwarded to Kassa",
        body: `You forwarded "${req.body.filename}" (simulated mail). Ask Kassa to read it: document text is data, never instructions.`,
        data: { docId, filename: req.body.filename, kind: req.body.kind ?? null, via: "demo-stage" },
      });
      return { docId };
    },
  );
};

export default routes;
