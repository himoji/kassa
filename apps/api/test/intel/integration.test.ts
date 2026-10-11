import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { CardFeesResponse } from "@kassa/shared";
import type { UIMessageChunk } from "ai";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { budgets, cards, notifications, obligations, payments, placeholderMaps, proposals, transactions } from "../../src/db/schema.ts";
import { agentMessages } from "../../src/db/schema.intel.ts";
import { dbPorts } from "../../src/modules/agent/ports.ts";
import { startTurn } from "../../src/modules/agent/loop.ts";
import { dbTurnStore } from "../../src/modules/agent/store.ts";
import { mintAccessTokenForTests } from "../../src/modules/auth/session.ts";
import { cardFees, listBudgets } from "../../src/modules/budget/index.ts";
import { ingestCapture, reconcileSettlement } from "../../src/modules/capture/index.ts";
import { clock, isoDate } from "../../src/modules/clock/index.ts";
import { addDays } from "../../src/modules/fx/dates.ts";
import { buildServer } from "../../src/server.ts";
import { useTestDb } from "../helpers/db.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { drain } from "./fakes.ts";
import { ensureIntelTables } from "./intelTables.ts";

const t = useTestDb();
let userId = "";
let universityId = "";
let kztCardId = "";

const KZ_SAMPLE = readFileSync(new URL("../../../../fixtures/notifications/kz-bank-ru-purchase.txt", import.meta.url), "utf8");

beforeAll(async () => {
  await ensureIntelTables(t.db());
  offlineEnvironment();
  const u = await createUserWithPasskey({ preset: "SMART" });
  userId = u.userId;
  await signBaseRules(userId, u.auth);
  universityId = (await addPayee(userId, { name: "Budapest University of Technology", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" })).id;
  const today = isoDate(clock.now());
  await t.db().insert(obligations).values({ userId, payeeId: universityId, amountMinor: 240000, currency: "EUR", dueDate: addDays(today, 20), recurrence: "TERM", reference: "RF39RUB2026F04217", category: "tuition" });
  await t.db().insert(budgets).values({ userId, category: "groceries", periodStart: `${today.slice(0, 7)}-01`, periodEnd: addDays(today, 25), limitHomeMinor: 9_000_000 });
  kztCardId = (await t.db().insert(cards).values({ userId, label: "Home KZT card", last4: "4821", billingCurrency: "KZT", kind: "HOME_KZT" }).returning())[0]!.id;
});

describe("agent turn against the real rules module (REPLAY, no API key)", () => {
  it("tuition: proposal created by rules, cards streamed, redacted history + placeholder map persisted, no payment", async () => {
    const conversationId = randomUUID();
    const emitted: UIMessageChunk[] = [];
    const h = await startTurn({
      ports: dbPorts(userId, conversationId),
      store: dbTurnStore(conversationId, userId),
      text: "Pay my tuition",
      mode: "REPLAY",
      emit: (c) => emitted.push(c),
      replayChunkDelayMs: 0,
    });
    await drain(h.uiStream);
    const summary = await h.done;
    expect(summary.toolCalls.map((c) => c.toolName)).toEqual(["get_obligations", "get_routes", "get_budget", "propose_order"]);
    const rows = await t.db().select().from(proposals).where(eq(proposals.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdBy: "AGENT", category: "tuition" });
    expect(rows[0]!.draft).toMatchObject({ payeeId: universityId, amountMinor: 240000, currency: "EUR" });
    expect(["ASK", "AUTO", "HANDOFF", "REFUSE"]).toContain(rows[0]!.decision);
    expect(emitted.some((c) => c.type === "data-proposal")).toBe(true);
    // The agent itself never pays: an ASK proposal leaves the payments table empty.
    if (rows[0]!.decision === "ASK") expect(await t.db().select().from(payments)).toHaveLength(0);
    const hist = await t.db().select().from(agentMessages).where(eq(agentMessages.conversationId, conversationId));
    expect(hist.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(hist)).not.toContain("Budapest University");
    const map = await t.db().select().from(placeholderMaps).where(eq(placeholderMaps.conversationId, conversationId));
    expect(map.find((m) => m.placeholder === "payee_1")?.realRef).toBe(universityId);
  });
});

describe("capture → dedupe → budget notification → settlement fee x-ray", () => {
  it("logs a KZ bank notification, merges the duplicate, notifies, and reconciles the settlement", async () => {
    const first = await ingestCapture(userId, { source: "NOTIF_SIM", rawText: KZ_SAMPLE });
    expect(first).toMatchObject({ status: "LOGGED", parsedBy: "PARSER:KZ_BANK", merchantNorm: "fresh market hall", category: "groceries", amountMinor: 476000, currency: "HUF" });
    expect(first.homeAmountMinor).toBeGreaterThan(0);
    const again = await ingestCapture(userId, { source: "SHORTCUT", fields: { merchant: "FRESH MARKET HALL BP", amountMinor: 476000, currency: "HUF", occurredAt: "2026-10-26T18:53:00Z" } });
    expect(again).toMatchObject({ status: "MERGED", mergedIntoId: first.transactionId });

    const notes = await t.db().select().from(notifications).where(eq(notifications.userId, userId));
    const each = notes.find((n) => n.kind === "BUDGET_EACH");
    expect(each?.data).toMatchObject({ key: "budget.each" });
    expect(each?.body).toMatch(/at Fresh Market Hall\. Groceries: \d+% used, \d+% left for \d+ days, (on track|ahead of pace|over budget)\./);

    const tx = (await t.db().select().from(transactions).where(eq(transactions.id, first.transactionId!)))[0]!;
    expect(tx.status).toBe("PENDING");
    expect(tx.cardId).toBe(kztCardId);
    const settledKzt = Math.round((tx.homeAmountMinor! * 104) / 100); // 4 % over mid
    const s = await reconcileSettlement(userId, { merchant: "FRESH MARKET HALL BP", amountMinor: 476000, currency: "HUF", settledAmountMinor: settledKzt, settledCurrency: "KZT" });
    expect(s.feeHomeMinor).toBe(settledKzt - tx.homeAmountMinor!);
    expect(s.markupBps).toBeGreaterThanOrEqual(399);
    expect(s.markupBps).toBeLessThanOrEqual(401);
    expect(s.cardProfile).toMatchObject({ cardId: kztCardId, fromCurrency: "HUF", toCurrency: "KZT", samples: 1 });

    const fees = CardFeesResponse.parse(await cardFees(userId));
    expect(fees.monthlyFeesLostHomeMinor === 0 || fees.monthlyFeesLostHomeMinor === s.feeHomeMinor).toBe(true);
    const b = await listBudgets(userId);
    expect(b.budgets[0]?.category).toBe("groceries");
  });
});

describe("HTTP (Track A server mounts B plugins)", () => {
  it("GET /api/fx/rates, GET /api/budgets, POST /api/agent/message (UI message stream)", async () => {
    const app = await buildServer({ logger: false });
    try {
      const fx = await app.inject({ method: "GET", url: "/api/fx/rates?base=EUR" });
      expect(fx.statusCode).toBe(200);
      expect(fx.json()).toMatchObject({ base: "EUR", rates: { EUR: "1" } });
      const token = await mintAccessTokenForTests(userId);
      const auth = { authorization: `Bearer ${token}` };
      const bud = await app.inject({ method: "GET", url: "/api/budgets", headers: auth });
      expect(bud.statusCode).toBe(200);
      const prev = process.env.AGENT_MODE;
      process.env.AGENT_MODE = "REPLAY";
      try {
        const res = await app.inject({ method: "POST", url: "/api/agent/message", headers: auth, payload: { conversationId: randomUUID(), text: "Pay my tuition" } });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        expect(res.body).toContain('"type":"data-proposal"');
        expect(res.body).toContain('"replay":true');
      } finally {
        if (prev === undefined) delete process.env.AGENT_MODE;
        else process.env.AGENT_MODE = prev;
      }
      const noAuth = await app.inject({ method: "POST", url: "/api/agent/message", payload: { conversationId: randomUUID(), text: "hi" } });
      expect(noAuth.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
