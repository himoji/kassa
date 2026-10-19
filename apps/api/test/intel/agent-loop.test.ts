import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { UIMessageChunk } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { startTurn } from "../../src/modules/agent/loop.ts";
import { SYSTEM_PROMPT } from "../../src/modules/agent/prompt.ts";
import { replayModel, type RecordedStep } from "../../src/modules/agent/replay.ts";
import { buildTools, MAX_TOOL_STEPS, READ_TOOLS, UI_TOOLS, WRITE_TOOLS } from "../../src/modules/agent/tools.ts";
import { Redactor } from "../../src/modules/agent/redact.ts";
import { verifyExtraction } from "../../src/modules/reader/reader.ts";
import { buildIban } from "@kassa/shared";

import { drain, fakePorts, LANDLORD, memoryStore, textOf, UNI, UNI_IBAN } from "./fakes.ts";

const SWAPPED = buildIban("HU", "117730169999999900000000");

const turn = (steps: RecordedStep[]) => ({ userText: "x", match: [], steps });

async function run(steps: RecordedStep[], opts: Parameters<typeof fakePorts>[0] = {}, text = "Pay my tuition please, Dana here") {
  const { ports, log } = fakePorts(opts);
  const model = replayModel(turn(steps)) as unknown as MockLanguageModelV4;
  const emitted: UIMessageChunk[] = [];
  const store = memoryStore();
  const h = await startTurn({ ports, store, text, mode: "LIVE", model, emit: (c) => emitted.push(c) });
  const chunks = await drain(h.uiStream);
  const summary = await h.done;
  return { log, model, emitted, chunks, summary, store, ctx: h.ctx };
}

describe("agent tool surface (I1)", () => {
  it("exposes exactly the 11 spec tools plus the read-only READ_TOOLS and the ask_* UI tools; propose_order is the only write tool", () => {
    const { ports } = fakePorts();
    const tools = buildTools({ ports, redactor: new Redactor(), emit: () => undefined, readDocs: new Map(), stop: { requested: false, reason: null }, proposals: [] });
    expect(Object.keys(tools).sort()).toEqual(
      [
        "forecast_coverage",
        "get_balances",
        "get_budget",
        "get_obligations",
        "get_payee_facts",
        "get_profile_summary",
        "get_routes",
        "log_expense",
        "propose_order",
        "read_document",
        "search_catalog",
        ...READ_TOOLS,
        ...UI_TOOLS,
      ].sort(),
    );
    expect(WRITE_TOOLS).toEqual(["propose_order"]);
    expect(READ_TOOLS).toEqual(["get_fx_rate", "get_spending_summary", "get_money_history", "get_payments"]);
  });

  it("(2026-10-19) get_payments is read-only, in the shared read-tool schemas, and the prompt tells the planner when to use it", async () => {
    const { READ_TOOL_INPUT_SCHEMAS } = await import("@kassa/shared");
    expect(Object.keys(READ_TOOL_INPUT_SCHEMAS).sort()).toEqual([...READ_TOOLS].sort());
    expect(WRITE_TOOLS).not.toContain("get_payments");
    // The judge's findings, as prompt rules: plan without paying, check before calling something unpaid, no promises
    // the code does not keep, and "signed" only after the passkey.
    expect(SYSTEM_PROMPT).toMatch(/plan, compare, check or prioritise[^\n]*do not call propose_order/);
    expect(SYSTEM_PROMPT).toMatch(/get_payments/);
    expect(SYSTEM_PROMPT).toMatch(/Never promise future behaviour that the code does not enforce/);
    expect(SYSTEM_PROMPT).toMatch(/"signed" only after the user signed it/);
    expect(SYSTEM_PROMPT).not.toMatch(/signedOrder/);
  });

  it("agent/** never imports payments, rails or ledger/internal (static import scan)", () => {
    const dir = fileURLToPath(new URL("../../src/modules/agent/", import.meta.url));
    const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const s of specs) expect(s, `${f} imports ${s}`).not.toMatch(/(^|\/)(payments|rails)(\/|$)|ledger\/internal/);
    }
  });
});

describe("get_money_history (what the statements showed)", () => {
  it("gives the planner the history computed by code, with the people who send money as placeholders", async () => {
    const { ImportHistory } = await import("@kassa/shared");
    const moneyHistory = ImportHistory.parse({
      homeCurrency: "KZT",
      from: "2025-11-01",
      to: "2026-10-31",
      months: 12,
      counts: { rows: 120, spending: 100, incoming: 6, ownTransfers: 2, refunds: 0 },
      spendingByCategory: [{ category: "groceries", monthlyHomeMinor: 8000000, totalHomeMinor: 96000000, count: 48 }],
      monthlySpendingHomeMinor: 10000000,
      monthlyIncomeHomeMinor: 9000000,
      incomes: [
        {
          source: "Нұрлан Сейтқали",
          amount: { amountMinor: 8300000, currency: "KZT" },
          cadence: "MONTHLY",
          count: 6,
          lastDate: "2026-09-10",
          regularity: "irregular",
          monthsReceived: 5,
          monthsCovered: 12,
          minMonthlyMinor: 20000000,
          maxMonthlyMinor: 20000000,
          medianMonthlyMinor: 20000000,
          trend: "flat",
          stopped: false,
          largest: { date: "2026-08-13", amountMinor: 100000000, paidFor: "DORM DEPOSIT" },
        },
      ],
      recurring: [],
      fees: { totalHomeMinor: 0, count: 0, fxMarkupBps: null, fxSamples: 0, fxCostHomeMinor: 0 },
      topMerchants: [],
      currencies: [],
    });
    const { ports } = fakePorts();
    const base = ports.profile;
    ports.profile = async () => ({ ...(await base()), moneyHistory });
    const model = replayModel(turn([{ toolCalls: [{ toolName: "get_money_history", input: {} }] }, { text: "person_1 sends money in some months; I plan with the average." }])) as unknown as MockLanguageModelV4;
    const h = await startTurn({ ports, store: memoryStore(), text: "Will I have enough in December?", mode: "LIVE", model, emit: () => undefined });
    await drain(h.uiStream);
    await h.done;
    const seen = JSON.stringify(model.doStreamCalls.map((c) => c.prompt));
    expect(seen).toContain("plannedMonthly");
    expect(seen).toContain("8300000");
    expect(seen).toContain("came in 5 of 12 months");
    const at = seen.indexOf("Нұрлан");
    expect(at === -1 ? "" : seen.slice(Math.max(0, at - 120), at + 60)).toBe("");
    expect(seen).toMatch(/person_\d/);
  });
});

describe("agent loop", () => {
  it("runs the tool loop and proposes only through rules.proposeOrder, resolving placeholders server-side", async () => {
    const r = await run([
      { toolCalls: [{ toolName: "get_obligations", input: {} }] },
      { toolCalls: [{ toolName: "get_routes", input: { fromCurrency: "KZT", toCurrency: "EUR", amountMinor: 240000 } }] },
      { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "payee_1", amountMinor: 240000, currency: "EUR", purpose: "Tuition" } }] },
      { text: "Drafted the payment to payee_1. Please review and sign." },
    ]);
    expect(r.log.proposeOrder).toHaveLength(1);
    expect(r.log.proposeOrder[0]).toMatchObject({ userId: expect.any(String), createdBy: "AGENT", payeeId: UNI, amountMinor: 240000, currency: "EUR", category: "tuition" });
    expect(r.emitted.map((c) => c.type)).toEqual(["data-routes", "data-proposal"]);
    // The user sees real names; the model never did.
    expect(textOf(r.chunks)).toContain("Budapest University of Technology");
    const prompts = JSON.stringify(r.model.doStreamCalls.map((c) => c.prompt));
    for (const secret of ["Budapest University", "Dana", "Kovács"]) expect(prompts).not.toContain(secret);
    expect(prompts).toContain("payee_1");
    // History holds only redacted messages.
    expect(JSON.stringify(r.store.messages)).not.toContain("Dana");
    expect(r.store.entries.find((e) => e.placeholder === "payee_1")?.realRef).toBe(UNI);
  });

  it("an unknown or non-payee reference never reaches the rules module", async () => {
    const r = await run([
      { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "iban_7", amountMinor: 100, currency: "EUR", purpose: "x" } }] },
      { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "11111111-1111-4111-8111-111111111111", amountMinor: 100, currency: "EUR", purpose: "x" } }] },
      { text: "I could not find that payee." },
    ]);
    expect(r.log.proposeOrder).toHaveLength(0);
  });

  it("REFUSE stops the agent: next step has no tools, further tool calls are not executed", async () => {
    const r = await run(
      [
        { toolCalls: [{ toolName: "get_obligations", input: {} }] },
        { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "payee_1", amountMinor: 240000, currency: "EUR", purpose: "Tuition" } }] },
        // A misbehaving model tries again after the refusal:
        { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "payee_2", amountMinor: 240000, currency: "EUR", purpose: "retry" } }] },
        { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "payee_2", amountMinor: 240000, currency: "EUR", purpose: "retry" } }] },
      ],
      { decision: "REFUSE", reasonCodes: ["REFUSE_SOURCE_MISMATCH"] },
    );
    expect(r.log.proposeOrder).toHaveLength(1);
    expect(r.summary.stopped).toBe(true);
    const third = r.model.doStreamCalls[2]!;
    expect(third.tools ?? []).toEqual([]);
    // The text-only step wrote no text (only a tool call that did not run): one more text-only call for the answer,
    // and when that writes nothing either, a code-written summary that names the refusal.
    expect(r.model.doStreamCalls).toHaveLength(4);
    expect(r.model.doStreamCalls[3]!.tools ?? []).toEqual([]);
    expect(r.summary).toMatchObject({ answeredBy: "summary", cutoff: "no-text" });
    expect(textOf(r.chunks)).toContain("refused, no money was sent");
  });

  it("a COOLING payee stops the agent too (I7)", async () => {
    const r = await run([
      { toolCalls: [{ toolName: "get_obligations", input: {} }] },
      // payee_2 = landlord (2nd obligation); the new account is a separate cooling payee.
      { toolCalls: [{ toolName: "get_payee_facts", input: { payeeRef: "payee_2" } }] },
      { text: "The landlord's new account is still cooling." },
    ]);
    expect(r.summary.stopped).toBe(false);
    const facts = r.store.messages.find((m) => m.role === "tool" && JSON.stringify(m).includes("pendingReplacement"));
    expect(JSON.stringify(facts)).toContain("COOLING");
    expect(r.store.entries.find((e) => e.placeholder === "payee_2")?.realRef).toBe(LANDLORD);
  });

  it(`caps the loop at ${MAX_TOOL_STEPS} tool rounds, then forces a text-only step`, async () => {
    const forever: RecordedStep[] = Array.from({ length: 20 }, () => ({ toolCalls: [{ toolName: "get_balances", input: {} }] }));
    const r = await run(forever);
    // 8 tool rounds, the text-only step, and (as that wrote no text) the final answer call, also without tools.
    expect(r.model.doStreamCalls).toHaveLength(MAX_TOOL_STEPS + 2);
    expect(r.model.doStreamCalls[MAX_TOOL_STEPS]!.tools ?? []).toEqual([]);
    expect(r.model.doStreamCalls[MAX_TOOL_STEPS + 1]!.tools ?? []).toEqual([]);
    expect(r.summary.answeredBy).toBe("summary");
    expect(textOf(r.chunks)).toContain("Balances: KZT 900,000.00");
  });

  it("reader mismatches travel to rules as readerChecks (I10 → rules step 3)", async () => {
    const swapped = verifyExtraction(
      "invoice",
      {
        payeeName: { value: "Budapest University of Technology", evidence: "Budapest University of Technology" },
        accountNumber: { value: SWAPPED, evidence: SWAPPED },
        reference: { value: null, evidence: null },
        amount: { value: "2400.00", evidence: "€2,400.00" },
        currency: { value: "EUR", evidence: "€2,400.00" },
        dueDate: { value: null, evidence: null },
      },
      "Budapest University of Technology\nHU42117730161111101800000000\n€2,400.00",
      "text",
      "t",
    );
    const r = await run(
      [
        { toolCalls: [{ toolName: "read_document", input: { docId: "doc-1" } }] },
        { toolCalls: [{ toolName: "get_obligations", input: {} }] },
        { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "payee_1", amountMinor: 240000, currency: "EUR", purpose: "Tuition" } }] },
        { text: "done" },
      ],
      { docs: { "doc-1": swapped } },
    );
    // The invoice's account differs from the verified university account → account mismatch.
    expect(UNI_IBAN).not.toBe(SWAPPED);
    expect(r.log.proposeOrder[0]?.readerChecks).toMatchObject({ account: "UNVERIFIED" });
  });

  it("log_expense only logs (I6) and never proposes", async () => {
    const r = await run([{ toolCalls: [{ toolName: "log_expense", input: { text: "coffee 1200 HUF" } }] }, { text: "Logged." }], {}, "coffee 1200 HUF");
    expect(r.log.proposeOrder).toHaveLength(0);
    expect(r.log.logExpense[0]).toEqual({ source: "TEXT", fields: { merchant: "coffee", amountMinor: 120000, currency: "HUF" } });
  });
});

describe("replay (AGENT_MODE=REPLAY) with the hand-written tuition recording", () => {
  it("runs the full tool loop with no API key and no injected model", async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const { ports, log } = fakePorts();
      const emitted: UIMessageChunk[] = [];
      const h = await startTurn({ ports, store: memoryStore(), text: "Pay my tuition", mode: "REPLAY", emit: (c) => emitted.push(c), replayChunkDelayMs: 0 });
      const chunks = await drain(h.uiStream);
      await h.done;
      expect(log.proposeOrder).toHaveLength(1);
      expect(log.proposeOrder[0]).toMatchObject({ payeeId: UNI, amountMinor: 240000, currency: "EUR", rail: "BANK_TRANSFER" });
      expect(emitted.some((c) => c.type === "data-routes")).toBe(true);
      expect(emitted.some((c) => c.type === "data-proposal")).toBe(true);
      const start = chunks.find((c) => c.type === "start");
      expect(start && "messageMetadata" in start ? start.messageMetadata : null).toEqual({ replay: true });
      expect(textOf(chunks)).toContain("Budapest University of Technology");
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });
});
