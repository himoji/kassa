import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, type UIMessageChunk } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { DataChoices, RouteDto } from "@kassa/shared";

import { maxPayablePerRoute } from "../../src/modules/agent/capacity.ts";
import { startTurn } from "../../src/modules/agent/loop.ts";
import type { AgentPorts } from "../../src/modules/agent/ports.ts";
import { SYSTEM_PROMPT } from "../../src/modules/agent/prompt.ts";
import { stepChunks, type RecordedStep } from "../../src/modules/agent/replay.ts";
import { MAX_TOOL_CALLS, moneyText } from "../../src/modules/agent/tools.ts";
import { toUIMessages } from "../../src/modules/agent/ui-history.ts";
import { getRoutes, type RouteRequest } from "../../src/modules/fx/routes.ts";
import { RatesService } from "../../src/modules/fx/rates.ts";

import { drain, fakePorts, LANDLORD, memoryStore, UNI } from "./fakes.ts";
import { toolResults, type ToolResultSeen } from "../helpers/planner.ts";

/*
 * Three problems found in the live agent: amounts read 100× too large (raw minor units), slow turns (get_routes probed
 * for the largest payable amount, unbounded tool calls, reasoning streamed to the browser), and placeholders
 * (payee_2, iban_1) on live picker cards.
 */

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

/** A planner whose step n is `script(n, seen)`; records every call's prompt and options (tools offered). */
function planner(script: (step: number, seen: ToolResultSeen[]) => RecordedStep | LanguageModelV4StreamPart[]) {
  let step = 0;
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    provider: "test",
    modelId: "scripted",
    doStream: async (options) => {
      calls.push(options);
      const s = script(step, toolResults(options.prompt));
      const chunks = Array.isArray(s) ? s : stepChunks(s, step);
      step++;
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 0 }) };
    },
  });
  return { model, calls };
}

async function turn(ports: AgentPorts, model: MockLanguageModelV4, store = memoryStore()) {
  const emitted: UIMessageChunk[] = [];
  const h = await startTurn({ ports, store, text: "How much can I pay?", mode: "LIVE", model, emit: (c) => emitted.push(c) });
  const chunks = await drain(h.uiStream);
  const summary = await h.done;
  return { emitted, chunks, summary, store, ctx: h.ctx };
}

describe("A) money the model reads is formatted in major units", () => {
  it("moneyText uses the currency's exponent: 2 decimals for KZT, none for JPY", () => {
    expect(moneyText(99000, "KZT")).toBe("KZT 990.00");
    expect(moneyText(237699, "KZT")).toBe("KZT 2,376.99");
    expect(moneyText(77100000, "KZT")).toBe("KZT 771,000.00");
    expect(moneyText(1200, "JPY")).toBe("JPY 1,200");
    expect(moneyText(5, "EUR")).toBe("EUR 0.05");
    expect(moneyText(-150, "USD")).toBe("USD -1.50");
    expect(moneyText(100, "XYZ")).toBeNull();
    expect(moneyText(1.5, "EUR")).toBeNull();
  });

  it("tool results in the planner's prompt carry formatted amounts next to every *Minor field (KZT and JPY)", async () => {
    const { ports } = fakePorts();
    const jpyRoute: RouteDto = { routeId: "kzt-mock-bank:KZT", label: "Mock bank transfer", fundingCurrency: "KZT", rail: "BANK_TRANSFER", feeFixedMinor: 99000, feeCurrency: "KZT", markupBps: 55, settlementDays: 1, arrivalDate: "2026-10-28", costHomeMinor: 237699, savingsVsWorstHomeMinor: 77100000 };
    ports.obligations = async () => [{ id: "77777777-7777-4777-8777-777777777777", payeeId: UNI, amountMinor: 120000, currency: "JPY", dueDate: "2026-10-31", recurrence: "ONCE", reference: null, category: "tuition" }];
    ports.toHome = async (a, c) => (c === "JPY" ? a * 350 : a);
    ports.routes = async () => ({ homeCurrency: "KZT", routes: [jpyRoute] });
    ports.maxPayable = async () => [{ routeId: "kzt-mock-bank:KZT", label: "Mock bank transfer", fundingCurrency: "KZT", balanceMinor: 90000000, maxAmountMinor: 254321 }];
    const { model, calls } = planner((step) =>
      step === 0
        ? { toolCalls: [{ toolName: "get_obligations", input: {} }, { toolName: "get_routes", input: { fromCurrency: "KZT", toCurrency: "JPY", amountMinor: 120000 } }, { toolName: "get_balances", input: {} }] }
        : { text: "Done." },
    );
    const r = await turn(ports, model);
    expect(r.summary.toolCalls).toHaveLength(3);
    const seen = toolResults(calls[1]!.prompt);
    const obligations = seen.find((s) => s.toolName === "get_obligations")!.value as { obligations: Array<Record<string, unknown>> };
    expect(obligations.obligations[0]).toMatchObject({ amountMinor: 120000, amount: "JPY 120,000", homeAmountMinor: 42000000, homeAmount: "KZT 420,000.00" });
    const routes = seen.find((s) => s.toolName === "get_routes")!.value as { amount: string; routes: Array<Record<string, unknown>>; maxPayable: Array<Record<string, unknown>> };
    expect(routes.amount).toBe("JPY 120,000");
    expect(routes.routes[0]).toMatchObject({ feeFixedMinor: 99000, feeFixed: "KZT 990.00", costHome: "KZT 2,376.99", savingsVsWorstHome: "KZT 771,000.00", maxPayable: "JPY 254,321" });
    expect(routes.maxPayable).toEqual([
      { fundingCurrency: "KZT", balanceMinor: 90000000, balance: "KZT 900,000.00", maxAmountMinor: 254321, maxAmount: "JPY 254,321", bestRouteId: "kzt-mock-bank:KZT", routes: [{ routeId: "kzt-mock-bank:KZT", label: "Mock bank transfer", maxAmountMinor: 254321, maxAmount: "JPY 254,321" }] },
    ]);
    const balances = seen.find((s) => s.toolName === "get_balances")!.value;
    expect(balances).toMatchObject({ homeTotal: "KZT 900,000.00", balances: [{ amount: "KZT 900,000.00", homeAmount: "KZT 900,000.00" }] });
    // The route card keeps the plain route (no model-only fields).
    const card = r.emitted.find((c) => c.type === "data-routes") as { data: { routes: RouteDto[] } } | undefined;
    expect(card?.data.routes).toEqual([jpyRoute]);
  });

  it("the system prompt tells the planner to quote the formatted strings and states the tool budget", () => {
    expect(SYSTEM_PROMPT).toContain('amount "KZT 990.00"');
    expect(SYSTEM_PROMPT).toContain(`${MAX_TOOL_CALLS} tool calls`);
    expect(SYSTEM_PROMPT).toContain("maxPayable");
  });
});

describe("B) bounded turns", () => {
  it("maxPayablePerRoute finds the exact largest amount under the balance, rail caps and missing routes included", async () => {
    // r1: 5 funding minor per bill minor + 990 fee; r2: same, capped at 1000; r3: fee above the balance.
    const price = async (a: number) => [
      { routeId: "r1", totalDebitFundingMinor: a * 5 + 990 },
      ...(a <= 1000 ? [{ routeId: "r2", totalDebitFundingMinor: a * 5 }] : []),
      { routeId: "r3", totalDebitFundingMinor: a + 200000 },
    ];
    const m = await maxPayablePerRoute(price, 100000);
    expect(Object.fromEntries(m)).toEqual({ r1: Math.floor((100000 - 990) / 5), r2: 1000 });
    expect((await maxPayablePerRoute(price, 0)).size).toBe(0);
  });

  it("with the real route optimizer, the found amount is payable and one minor unit more is not", async () => {
    const svc = new RatesService({ offline: true });
    const balance = 90000000; // KZT 900,000.00
    const req = (amountMinor: number, b: number): RouteRequest => ({ amountMinor, toCurrency: "EUR", homeCurrency: "KZT", today: "2026-10-27", balances: [{ currency: "KZT", amountMinor: b }], top: 99 });
    const m = await maxPayablePerRoute(async (a) => getRoutes(req(a, Number.MAX_SAFE_INTEGER), svc), balance);
    expect(m.size).toBeGreaterThan(0);
    for (const [routeId, max] of m) {
      expect((await getRoutes(req(max, balance), svc)).map((r) => r.routeId)).toContain(routeId);
      expect((await getRoutes(req(max + 1, balance), svc)).map((r) => r.routeId)).not.toContain(routeId);
    }
  });

  it(`caps a turn at ${MAX_TOOL_CALLS} tool calls; calls past it do not run and the next step gets no tools`, async () => {
    const { ports } = fakePorts();
    let routeCalls = 0;
    const routes = ports.routes;
    ports.routes = async (a) => {
      routeCalls++;
      return routes(a);
    };
    // A planner that keeps probing get_routes, 5 parallel calls per step.
    const probe = (step: number) => Array.from({ length: 5 }, (_, i) => ({ toolName: "get_routes", input: { fromCurrency: "KZT", toCurrency: "EUR", amountMinor: 100000 + step * 10 + i } }));
    const { model, calls } = planner((step, seen) => (seen.some((s) => s.value.error === "TOOL_CALL_LIMIT") ? { text: "Here is what I found." } : { toolCalls: probe(step) }));
    const r = await turn(ports, model);
    expect(routeCalls).toBe(MAX_TOOL_CALLS);
    expect(r.ctx.toolCalls).toEqual({ count: MAX_TOOL_CALLS, refused: 15 - MAX_TOOL_CALLS });
    const last = calls.at(-1)!;
    expect(last.toolChoice?.type === "none" || (last.tools ?? []).length === 0).toBe(true);
    expect(r.summary.text).toContain("Here is what I found.");
  });

  it("never forwards the model's reasoning to the client stream", async () => {
    const { ports } = fakePorts();
    const { model } = planner(() => [
      { type: "stream-start", warnings: [] },
      { type: "reasoning-start", id: "r0" },
      { type: "reasoning-delta", id: "r0", delta: "Let me think about payee_2 at length. ".repeat(50) },
      { type: "reasoning-end", id: "r0" },
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "You can pay it." },
      { type: "text-end", id: "t0" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
    ]);
    const r = await turn(ports, model);
    expect(r.chunks.filter((c) => c.type.startsWith("reasoning"))).toEqual([]);
    expect(r.chunks.some((c) => c.type === "text-delta" && c.delta.includes("You can pay it."))).toBe(true);
  });
});

describe("C) live picker cards never show placeholders", () => {
  it("ask_confirm / ask_choice prompts and labels are shown with names and masked accounts; the model's input stays redacted", async () => {
    const { ports } = fakePorts();
    const store = memoryStore();
    store.entries.push({ placeholder: "payee_2", kind: "PAYEE", realRef: LANDLORD }, { placeholder: "iban_1", kind: "IBAN", realRef: "HU42117730161111101800000000" });
    const prompt = "Pay the rent to your landlord account payee_2? I will not use iban_1.";
    const { model } = planner((step) =>
      step === 0
        ? {
            toolCalls: [
              { toolName: "ask_confirm", input: { prompt, yesLabel: "Pay payee_2" } },
              { toolName: "ask_choice", input: { prompt: "Which account?", options: [{ id: "a", label: "payee_2" }, { id: "b", label: "Not iban_1" }] } },
            ],
          }
        : { text: "unreached" },
    );
    const r = await turn(ports, model, store);
    const cards = r.emitted.filter((c) => c.type === "data-choices").map((c) => (c as { data: DataChoices }).data);
    expect(cards).toHaveLength(2);
    const shown = JSON.stringify(cards);
    expect(shown).not.toMatch(/\b(payee|iban)_\d/);
    expect(cards[0]!.prompt).toBe("Pay the rent to your landlord account Kovács Péter? I will not use HU…0000.");
    expect(cards[0]!.options[0]!.label).toBe("Pay Kovács Péter");
    expect(cards[1]!.options.map((o) => o.label)).toEqual(["Kovács Péter", "Not HU…0000"]);
    // What the model wrote (and what answers are matched against) is unchanged.
    expect(JSON.stringify(r.store.messages)).toContain(prompt);

    // The history view shows the same text.
    const ui = await toUIMessages("conv-1", r.store.messages, r.store.entries, ports);
    const history = ui.flatMap((m) => m.parts).filter((p) => p.type === "data-choices");
    expect(JSON.stringify(history)).not.toMatch(/\b(payee|iban)_\d/);
    expect((history[1] as unknown as { data: DataChoices }).data.options.map((o) => o.label)).toEqual(["Kovács Péter", "Not HU…0000"]);
  });
});
