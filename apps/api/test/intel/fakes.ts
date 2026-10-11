import { buildIban, type ProposalSummary, type RouteDto } from "@kassa/shared";
import type { ModelMessage, UIMessageChunk } from "ai";

import type { AgentPorts, PayeeRow } from "../../src/modules/agent/ports.ts";
import type { PlaceholderEntry } from "../../src/modules/agent/redact.ts";
import type { TurnStore } from "../../src/modules/agent/loop.ts";
import type { ReaderResult } from "../../src/modules/reader/index.ts";
import type { ProposeOrderInput, ProposeOrderResult } from "../../src/modules/rules/index.ts";

export const USER_ID = "00000000-0000-4000-8000-000000000001";
export const UNI = "11111111-1111-4111-8111-111111111111";
export const LANDLORD = "22222222-2222-4222-8222-222222222222";
export const NEW_LANDLORD = "33333333-3333-4333-8333-333333333333";
export const UNI_IBAN = buildIban("HU", "117730161111101800000000");

export const PAYEES: PayeeRow[] = [
  { id: UNI, name: "Budapest University of Technology", kind: "UNIVERSITY", status: "VERIFIED", verifiedAt: "2026-09-01T00:00:00.000Z", coolingUntil: null, accountHash: `hash:${UNI_IBAN}`, replacesPayeeId: null },
  { id: LANDLORD, name: "Kovács Péter", kind: "LANDLORD", status: "VERIFIED", verifiedAt: "2026-09-01T00:00:00.000Z", coolingUntil: null, accountHash: "hash:landlord", replacesPayeeId: null },
  { id: NEW_LANDLORD, name: "Kovács Péter", kind: "LANDLORD", status: "COOLING", verifiedAt: null, coolingUntil: "2026-10-28T09:00:00.000Z", accountHash: "hash:new", replacesPayeeId: LANDLORD },
];

export interface FakeLog {
  proposeOrder: ProposeOrderInput[];
  logExpense: unknown[];
  reads: string[];
}

export function fakePorts(opts: { decision?: ProposeOrderResult["decision"]; reasonCodes?: ProposeOrderResult["reasonCodes"]; docs?: Record<string, ReaderResult> } = {}): { ports: AgentPorts; log: FakeLog } {
  const log: FakeLog = { proposeOrder: [], logExpense: [], reads: [] };
  const routes: RouteDto[] = [
    { routeId: "kzt-mock-bank:KZT", label: "Mock bank transfer", fundingCurrency: "KZT", rail: "BANK_TRANSFER", feeFixedMinor: 99000, feeCurrency: "KZT", markupBps: 55, settlementDays: 1, arrivalDate: "2026-10-28", costHomeMinor: 907368, savingsVsWorstHomeMinor: 4972000 },
  ];
  const ports: AgentPorts = {
    userId: USER_ID,
    conversationId: "conv-1",
    profile: async () => ({ displayName: "Dana Nurlanovna", homeCurrency: "KZT", region: "EU", preset: "SMART", moneyMode: "CAPPED_WALLET", notificationMode: "EACH", incomes: [] }),
    payees: async () => PAYEES,
    balances: async () => [{ currency: "KZT", amountMinor: 90000000 }],
    toHome: async (a, c) => (c === "EUR" ? a * 612 : a),
    budgets: async () => [],
    obligations: async () => [
      { id: "44444444-4444-4444-8444-444444444444", payeeId: UNI, amountMinor: 240000, currency: "EUR", dueDate: "2026-10-31", recurrence: "TERM", reference: "RF39RUB2026F04217", category: "tuition" },
      { id: "55555555-5555-4555-8555-555555555555", payeeId: LANDLORD, amountMinor: 18000000, currency: "HUF", dueDate: "2026-11-01", recurrence: "MONTHLY", reference: "HF-APT4B-RENT", category: "rent" },
    ],
    paymentCount: async () => 2,
    catalog: async () => ({ items: [] }),
    routes: async () => ({ homeCurrency: "KZT", routes }),
    forecast: async () => ({ horizonDays: 45, asOf: "2026-10-27", currencies: [], suggestions: [] }),
    readDocument: async (docId) => {
      log.reads.push(docId);
      const d = opts.docs?.[docId];
      if (!d) throw Object.assign(new Error("Document not found"), { code: "DOC_NOT_FOUND" });
      return d;
    },
    storedReads: async (docIds) => {
      const out = new Map<string, ReaderResult | null>();
      if (docIds) for (const id of docIds) if (opts.docs?.[id]) out.set(id, opts.docs[id]!);
      return out;
    },
    accountHashOf: (a) => `hash:${a}`,
    proposeOrder: async (input) => {
      log.proposeOrder.push(input);
      return { proposalId: "66666666-6666-4666-8666-666666666666", decision: opts.decision ?? "ASK", reasonCodes: opts.reasonCodes ?? ["RISK_HIGH"], riskScore: 0.6, summary: "Ask: €2,400.00 to Budapest University of Technology" };
    },
    proposalCard: async (proposalId) => {
      const summary: ProposalSummary = { proposalId, createdBy: "AGENT", decision: opts.decision ?? "ASK", reasonCodes: [], riskScore: 0.6, status: "PENDING_APPROVAL", payeeName: "Budapest University of Technology", amountMinor: 240000, currency: "EUR", homeAmountMinor: 146976000, homeCurrency: "KZT", createdAt: "2026-10-27T09:00:00.000Z" };
      return { summary, budgetImpact: null };
    },
    logExpense: async (input) => {
      log.logExpense.push(input);
      return { status: "LOGGED", transactionId: null, mergedIntoId: null, parsedBy: "FIELDS", merchantNorm: "x", amountMinor: 1, currency: "HUF", homeAmountMinor: 1, category: "other", categorySource: "DEFAULT", notification: null };
    },
  };
  return { ports, log };
}

export function memoryStore(): TurnStore & { messages: ModelMessage[]; entries: PlaceholderEntry[] } {
  const s = {
    messages: [] as ModelMessage[],
    entries: [] as PlaceholderEntry[],
    history: async () => s.messages,
    placeholders: async () => s.entries,
    saveMessages: async (m: ModelMessage[]) => {
      s.messages.push(...m);
    },
    savePlaceholders: async (e: PlaceholderEntry[]) => {
      s.entries.push(...e);
    },
  };
  return s;
}

export async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

export function textOf(chunks: UIMessageChunk[]): string {
  return chunks.map((c) => (c.type === "text-delta" ? c.delta : "")).join("");
}
