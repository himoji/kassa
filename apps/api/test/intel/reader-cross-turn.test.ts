/*
 * B1 ("Reader checks lost across turns", I10 → rules §10 step 3): a document read in one turn and
 * paid in a later turn (or another conversation, or uploaded without a conversationId) must still bring its
 * persisted Reader checks to the rules. Real DB, real rules module, Reader played by a mock model.
 */
import { MockLanguageModelV4 } from "ai/test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { obligations, proposals } from "../../src/db/schema.ts";
import { dbPorts, type AgentPorts } from "../../src/modules/agent/ports.ts";
import { Redactor } from "../../src/modules/agent/redact.ts";
import { dbTurnStore } from "../../src/modules/agent/store.ts";
import { buildTools, type ToolContext } from "../../src/modules/agent/tools.ts";
import { clock, isoDate } from "../../src/modules/clock/index.ts";
import { addDays } from "../../src/modules/fx/dates.ts";
import { readDocument, storeDocument } from "../../src/modules/reader/index.ts";
import { useTestDb } from "../helpers/db.ts";
import { addPayee, createUserWithPasskey, IBAN_OTHER, IBAN_UNIVERSITY, offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { ensureIntelTables } from "./intelTables.ts";

const t = useTestDb();
let userId = "";

const printed = (iban: string) => iban.replace(/(.{4})(?=.)/g, "$1 ");
const invoiceText = (iban: string) => `University in Budapest (simulated)
Invoice no. INV-2026-0417
Payee account: ${printed(iban)}
Reference: RF39RUB2026F04217
Amount due: EUR 2,400.00
Due date: 31.10.2026`;

const f = (value: string | null, evidence: string | null) => ({ value, evidence });
const extraction = (iban: string, amount = "2400.00") => ({
  payeeName: f("University in Budapest", "University in Budapest (simulated)"),
  accountNumber: f(iban, `Payee account: ${printed(iban)}`),
  reference: f("RF39RUB2026F04217", "Reference: RF39RUB2026F04217"),
  amount: f(amount, "Amount due: EUR 2,400.00"),
  currency: f("EUR", "EUR 2,400.00"),
  dueDate: f("2026-10-31", "Due date: 31.10.2026"),
});

function readerModel(output: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    }),
  });
}

/** One planner turn: fresh tool context loaded like agent/loop.ts does (history store → readDocs). */
async function turn(conversationId: string, reader?: unknown) {
  const store = dbTurnStore(conversationId, userId);
  const base = dbPorts(userId, conversationId);
  const ports: AgentPorts = reader ? { ...base, readDocument: (docId) => readDocument(docId, { userId, model: readerModel(reader), modelLabel: "test:reader" }) } : base;
  const redactor = new Redactor({ existing: await store.placeholders() });
  const ctx: ToolContext = { ports, redactor, emit: () => undefined, readDocs: (await store.readDocs?.()) ?? new Map(), stop: { requested: false, reason: null }, proposals: [] };
  const tools = buildTools(ctx);
  const call = async (name: string, input: unknown) => {
    const tl = tools[name] as unknown as { execute: (i: unknown, o: { toolCallId: string; messages: [] }) => Promise<unknown> };
    return (await tl.execute(input, { toolCallId: randomUUID(), messages: [] })) as Record<string, unknown>;
  };
  const save = async () => store.savePlaceholders?.(redactor.drainNew());
  return { call, save, ctx };
}

async function uploadInvoice(iban: string, conversationId: string | null = null) {
  return storeDocument(userId, { data: new TextEncoder().encode(invoiceText(iban)), mediaType: "text/plain", kind: "invoice", conversationId });
}

async function universityRef(call: (n: string, i: unknown) => Promise<Record<string, unknown>>) {
  const obs = (await call("get_obligations", {})) as { obligations: Array<{ payeeRef: string; payeeKind: string }> };
  return obs.obligations.find((o) => o.payeeKind === "UNIVERSITY")!.payeeRef;
}

beforeAll(async () => {
  await ensureIntelTables(t.db());
  offlineEnvironment();
  const u = await createUserWithPasskey({ preset: "SMART" });
  userId = u.userId;
  await signBaseRules(userId, u.auth);
  const uni = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" });
  await t.db().insert(obligations).values({ userId, payeeId: uni.id, amountMinor: 240000, currency: "EUR", dueDate: addDays(isoDate(clock.now()), 20), recurrence: "TERM", reference: "RF39RUB2026F04217", category: "tuition" });
});

describe("Reader checks survive turns (B1, I10)", () => {
  it("unverified amount read in turn 1 (upload without conversationId) → REFUSE_SOURCE_MISMATCH in turn 2", async () => {
    const conv = randomUUID();
    const docId = await uploadInvoice(IBAN_UNIVERSITY);
    // Turn 1: the Reader claims €2,500 but its evidence says €2,400 → amount UNVERIFIED.
    const t1 = await turn(conv, extraction(IBAN_UNIVERSITY, "2500.00"));
    const read = (await t1.call("read_document", { docId })) as { checks: { amount: string } };
    expect(read.checks.amount).toBe("UNVERIFIED");
    await t1.save();

    // Turn 2: the planner proposes the Reader's (wrong) amount.
    const t2 = await turn(conv);
    const ref = await universityRef(t2.call);
    const r = (await t2.call("propose_order", { payeeRef: ref, amountMinor: 250000, currency: "EUR", purpose: "Tuition" })) as { decision: string; reasonCodes: string[] };
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_SOURCE_MISMATCH");
  });

  it("swapped-account invoice read in one conversation → payment proposed in another conversation is refused", async () => {
    const docId = await uploadInvoice(IBAN_OTHER);
    const t1 = await turn(randomUUID(), extraction(IBAN_OTHER));
    const read = (await t1.call("read_document", { docId })) as { checks: { amount: string; account: string } };
    expect(read.checks).toMatchObject({ amount: "VERIFIED", account: "VERIFIED" });

    // Same amount as the invoice, to the verified university whose stored account differs.
    const t2 = await turn(randomUUID());
    const ref = await universityRef(t2.call);
    const r = (await t2.call("propose_order", { payeeRef: ref, amountMinor: 240000, currency: "EUR", purpose: "Tuition" })) as { decision: string; reasonCodes: string[]; readerChecks: unknown };
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_SOURCE_MISMATCH");
    expect(r.readerChecks).toMatchObject({ account: "UNVERIFIED" });
  });

  it("explicit docIds: the referenced document's checks apply even when the amount differs; docIds are stored on the draft", async () => {
    const docId = await uploadInvoice(IBAN_UNIVERSITY);
    const t1 = await turn(randomUUID(), extraction(IBAN_UNIVERSITY, "9.99"));
    await t1.call("read_document", { docId });

    const t2 = await turn(randomUUID());
    const ref = await universityRef(t2.call);
    const r = (await t2.call("propose_order", { payeeRef: ref, amountMinor: 240000, currency: "EUR", purpose: "Tuition", docIds: [docId] })) as { proposalId: string; decision: string; reasonCodes: string[] };
    expect(r.decision).toBe("REFUSE");
    expect(r.reasonCodes).toContain("REFUSE_SOURCE_MISMATCH");
    const row = (await t.db().select().from(proposals).where(eq(proposals.id, r.proposalId)))[0]!;
    expect(row.draft.sourceDocIds).toContain(docId);
  });

  it("explicit docIds that are unknown or not yet read → tool error, no proposal", async () => {
    const t2 = await turn(randomUUID());
    const ref = await universityRef(t2.call);
    const before = (await t.db().select().from(proposals)).length;
    const unknown = await t2.call("propose_order", { payeeRef: ref, amountMinor: 240000, currency: "EUR", purpose: "Tuition", docIds: [randomUUID()] });
    expect(unknown).toMatchObject({ error: "DOC_NOT_FOUND" });
    const unread = await uploadInvoice(IBAN_UNIVERSITY);
    const notRead = await t2.call("propose_order", { payeeRef: ref, amountMinor: 240000, currency: "EUR", purpose: "Tuition", docIds: [unread] });
    expect(notRead).toMatchObject({ error: "DOC_NOT_READ" });
    expect((await t.db().select().from(proposals)).length).toBe(before);
  });

  it("a faithful invoice read earlier does not block the matching payment (VERIFIED checks reach the rules)", async () => {
    // Fresh user so earlier tests' suspicious documents do not apply.
    const u = await createUserWithPasskey({ preset: "SMART" });
    const prev = userId;
    userId = u.userId;
    try {
      await signBaseRules(userId, u.auth);
      const uni = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" });
      await t.db().insert(obligations).values({ userId, payeeId: uni.id, amountMinor: 240000, currency: "EUR", dueDate: addDays(isoDate(clock.now()), 20), recurrence: "TERM", reference: "RF39RUB2026F04217", category: "tuition" });
      const docId = await uploadInvoice(IBAN_UNIVERSITY);
      await (await turn(randomUUID(), extraction(IBAN_UNIVERSITY))).call("read_document", { docId });
      const t2 = await turn(randomUUID());
      const ref = await universityRef(t2.call);
      const r = (await t2.call("propose_order", { payeeRef: ref, amountMinor: 240000, currency: "EUR", purpose: "Tuition" })) as { decision: string; readerChecks: unknown };
      expect(r.decision).not.toBe("REFUSE");
      expect(r.readerChecks).toMatchObject({ amount: "VERIFIED", account: "VERIFIED" });
    } finally {
      userId = prev;
    }
  });
});
