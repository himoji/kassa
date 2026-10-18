/*
 * Harness control port (TEST HARNESS ONLY — never mounted in the product server). Runs inside the sim
 * daemon, the single process that owns the PGlite directory, so it can call module functions in-process:
 *
 *  - POST /tool          the planner's 11 tools, built by the REAL agent/tools.ts with the REAL Redactor and the
 *                        placeholder map per conversation (I11), as agent/loop.ts does for one tool step. The
 *                        caller (an LLM persona playing the planner) gets what the model would see.
 *                        Only agent/ + rules.proposeOrder are reached; never payments/ or rails/ (I1).
 *  - POST /user-text     the user's chat message, redacted exactly as the planner would receive it.
 *  - POST /payment       one payment of the calling persona (incl. the one-time card id), read-only.
 *  - POST /ledger-verify the same ledger.verify() that scripts/ledger-verify.ts runs.
 *  - POST /evidence      ledger / proposals / payments / notifications since a marker (all users).
 *  - POST /tick          one scheduler tick (the sim runs with the 15 s scheduler off by default).
 *  - POST /health, /shutdown.
 *
 * Bound to 127.0.0.1; every request needs x-sim-token = the random token in .data/sim/token. Persona-scoped
 * calls also carry the persona's access token (Authorization: Bearer), verified like the API does.
 */
import {
  ForecastCoverageInput,
  GetBalancesInput,
  GetBudgetInput,
  GetObligationsInput,
  GetPayeeFactsInput,
  GetProfileSummaryInput,
  GetRoutesInput,
  LogExpenseInput,
  ProposeOrderInput,
  ReadDocumentInput,
  SearchCatalogInput,
} from "@kassa/shared";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { and, asc, desc, eq, gt, gte } from "drizzle-orm";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";

import { getDb } from "../../src/db/client.ts";
import { issuedCards, ledgerEntries, notifications, payments, proposals, users } from "../../src/db/schema.ts";
import { buildTools, dbPorts, dbTurnStore, knownNames, Redactor, type AgentPorts, type ToolContext } from "../../src/modules/agent/index.ts";
import { bindToConversation } from "../../src/modules/agent/ports.ts";
import { claimConversation, ConversationForbiddenError, conversationOwner } from "../../src/modules/agent/history.ts";
import { verifyToken } from "../../src/modules/auth/session.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { readDocument, type ReaderResult } from "../../src/modules/reader/index.ts";
import { assertAiProcessingAllowed } from "../../src/modules/privacy/notice.ts";
import { HttpProblem } from "../../src/http/problem.ts";
import { tick } from "../../src/modules/scheduler/index.ts";
import { SIM_TOKEN_HEADER } from "./lib/config.ts";

export class ControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

const TOOL_INPUTS: Record<string, z.ZodType> = {
  get_profile_summary: GetProfileSummaryInput,
  get_balances: GetBalancesInput,
  get_budget: GetBudgetInput,
  get_obligations: GetObligationsInput,
  get_payee_facts: GetPayeeFactsInput,
  search_catalog: SearchCatalogInput,
  get_routes: GetRoutesInput,
  forecast_coverage: ForecastCoverageInput,
  read_document: ReadDocumentInput,
  propose_order: ProposeOrderInput,
  log_expense: LogExpenseInput,
};

export const TOOL_NAMES = Object.keys(TOOL_INPUTS);

/**
 * Reader results read in a conversation through the sim (docId → result). In the live loop the planner reads
 * and proposes within one turn, so propose_order's readerChecks see the document via ctx.readDocs; here every
 * tool call is its own request, so the daemon keeps the per-conversation map (merged with the DB ones).
 */
const convReadDocs = new Map<string, Map<string, ReaderResult>>();

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const must = (v: unknown, name: string): string => {
  const s = str(v);
  if (!s) throw new ControlError(400, "BAD_ARGS", `${name} is required`);
  return s;
};

/** A caller-supplied extraction played back as the Reader model's structured output (the tester plays the Reader). */
function callerReaderModel(extraction: unknown) {
  return new MockLanguageModelV4({
    provider: "sim",
    modelId: "caller-reader",
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(extraction) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: 0, reasoning: undefined } },
      warnings: [],
    }),
  });
}

/** The product's AI gate (privacy/notice.ts: restriction, AI consent, PIPL consent for CN), plus the session's erased-user refusal. */
async function assertAiAllowed(userId: string): Promise<void> {
  const row = (await getDb().select({ erasedAt: users.erasedAt }).from(users).where(eq(users.id, userId)))[0];
  if (!row) throw new ControlError(401, "UNAUTHENTICATED", "user not found");
  if (row.erasedAt) throw new ControlError(401, "UNAUTHENTICATED", "user erased");
  try {
    await assertAiProcessingAllowed(userId);
  } catch (e) {
    if (e instanceof HttpProblem) throw new ControlError(e.status, e.code, e.message);
    throw e;
  }
}

async function claimAgentConversation(conversationId: string, userId: string): Promise<void> {
  try {
    await claimConversation(conversationId, userId, "agent");
  } catch (e) {
    if (e instanceof ConversationForbiddenError) throw new ControlError(403, "CONVERSATION_FORBIDDEN", "This conversation belongs to another user");
    throw e;
  }
}

async function runTool(body: Json, userId: string): Promise<unknown> {
  const name = must(body.name, "name");
  const conversationId = must(body.conversationId, "conversationId");
  const schema = TOOL_INPUTS[name];
  if (!schema) throw new ControlError(400, "UNKNOWN_TOOL", `unknown tool ${name}; one of ${TOOL_NAMES.join(", ")}`);
  const owner = await conversationOwner(conversationId);
  await claimAgentConversation(conversationId, userId);
  await assertAiAllowed(userId);

  const base = dbPorts(userId, conversationId);
  const ports: AgentPorts =
    body.readerOutput !== undefined
      ? {
          ...base,
          async readDocument(docId) {
            const r = await readDocument(docId, { userId, model: callerReaderModel(body.readerOutput), modelLabel: "sim:caller-reader" });
            await bindToConversation(userId, docId, conversationId);
            return r;
          },
        }
      : base;
  const store = dbTurnStore(conversationId, userId);
  const [existing, names, dbDocs] = await Promise.all([
    store.placeholders(),
    knownNames(ports),
    store.readDocs ? store.readDocs() : Promise.resolve(new Map<string, ReaderResult>()),
  ]);
  const redactor = new Redactor({ names, existing });
  const readDocs = new Map([...dbDocs, ...(convReadDocs.get(conversationId) ?? new Map<string, ReaderResult>())]);
  const ctx: ToolContext = { ports, redactor, emit: () => undefined, readDocs, stop: { requested: false, reason: null }, proposals: [] };
  const tools = buildTools(ctx);

  const parsed = schema.safeParse(body.input ?? {});
  let output: unknown;
  if (!parsed.success) {
    // The AI SDK hands a tool-input error back to the model in this case.
    output = { error: "INVALID_TOOL_INPUT", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  } else {
    const t = tools[name] as { execute?: (input: unknown, o: { toolCallId: string; messages: ModelMessage[] }) => Promise<unknown> };
    output = await t.execute!(parsed.data, { toolCallId: `sim-${randomUUID()}`, messages: [] });
  }
  // Defence in depth, as agent/middleware.ts does on every prompt (idempotent).
  output = redactor.redactValue(output);
  convReadDocs.set(conversationId, ctx.readDocs);

  // Persist like a real turn: redacted messages only; this also establishes conversation ownership.
  const toolCallId = `sim-${randomUUID()}`;
  const msgs: ModelMessage[] = [];
  if (!owner) msgs.push({ role: "user", content: "[sim] planner session (tool calls issued through the sim harness)" });
  msgs.push(
    { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName: name, input: redactor.redactValue(body.input ?? {}) }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: name, output: { type: "json", value: output as never } }] },
  );
  await store.saveMessages(msgs);
  await store.savePlaceholders(redactor.drainNew());
  return {
    tool: name,
    conversationId,
    output,
    sim: {
      stopRequested: ctx.stop.requested,
      stopReason: ctx.stop.reason,
      ...(ctx.stop.requested ? { note: "In the live loop the planner gets no more tools this turn (REFUSE / COOLING): explain and stop." } : {}),
    },
  };
}

/**
 * The user's chat text as the planner receives it: agent/loop.ts redacts every user message with the same
 * Redactor (names of known payees → payee_N, IBAN/PAN/e-mail/phone → placeholders) and stores it.
 */
async function userText(body: Json, userId: string): Promise<unknown> {
  const text = must(body.text, "text");
  const conversationId = must(body.conversationId, "conversationId");
  await claimAgentConversation(conversationId, userId);
  await assertAiAllowed(userId);
  const ports = dbPorts(userId, conversationId);
  const store = dbTurnStore(conversationId, userId);
  const [existing, names] = await Promise.all([store.placeholders(), knownNames(ports)]);
  const redactor = new Redactor({ names, existing });
  const redacted = redactor.redactText(text);
  await store.saveMessages([{ role: "user", content: redacted }]);
  await store.savePlaceholders(redactor.drainNew());
  return { conversationId, plannerSees: redacted };
}

async function paymentOf(body: Json, userId: string) {
  const db = getDb();
  const byProposal = str(body.proposalId);
  const p = byProposal
    ? (await db.select().from(payments).where(and(eq(payments.proposalId, byProposal), eq(payments.userId, userId))).orderBy(desc(payments.createdAt)))[0]
    : (await db.select().from(payments).where(and(eq(payments.id, must(body.paymentId, "paymentId or proposalId")), eq(payments.userId, userId))))[0];
  if (!p) throw new ControlError(404, "NOT_FOUND", "payment not found for this persona");
  const card = (await db.select().from(issuedCards).where(eq(issuedCards.paymentId, p.id)))[0];
  return {
    payment: { id: p.id, proposalId: p.proposalId, rail: p.rail, status: p.status, amountMinor: p.amountMinor, currency: p.currency, railRef: p.railRef, reasonCodes: p.reasonCodes, details: p.details, createdAt: p.createdAt, updatedAt: p.updatedAt },
    card: card
      ? { cardId: card.stripeCardId, provider: card.provider, last4: card.last4, maxAmountMinor: card.maxAmountMinor, currency: card.currency, expiresAt: card.expiresAt, usedAt: card.usedAt, canceledAt: card.canceledAt }
      : null,
  };
}

async function headSeq(): Promise<number> {
  const r = await getDb().select({ seq: ledgerEntries.seq }).from(ledgerEntries).orderBy(asc(ledgerEntries.seq));
  return r.length ? r[r.length - 1]!.seq : 0;
}

async function evidence(body: Json) {
  const sinceSeq = Number(body.sinceSeq ?? 0);
  const sinceAt = str(body.sinceAt) ? new Date(String(body.sinceAt)) : new Date(0);
  const db = getDb();
  const [entries, props, pays, notes, verify] = await Promise.all([
    db.select().from(ledgerEntries).where(gt(ledgerEntries.seq, sinceSeq)).orderBy(asc(ledgerEntries.seq)),
    db.select().from(proposals).where(gte(proposals.updatedAt, sinceAt)).orderBy(asc(proposals.createdAt)),
    db.select().from(payments).where(gte(payments.updatedAt, sinceAt)).orderBy(asc(payments.createdAt)),
    db.select().from(notifications).where(gte(notifications.createdAt, sinceAt)).orderBy(asc(notifications.createdAt)),
    ledger.verify(),
  ]);
  return {
    generatedAt: clock.now().toISOString(),
    since: { seq: sinceSeq, at: sinceAt.toISOString() },
    ledgerVerify: verify,
    ledger: entries.map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, payload: e.payload, hash: e.hash })),
    proposals: props.map((p) => ({ id: p.id, userId: p.userId, createdBy: p.createdBy, decision: p.decision, status: p.status, reasonCodes: p.reasonCodes, riskScore: p.riskScore, orderHash: p.orderHash, canonicalOrder: p.canonicalOrder })),
    payments: pays.map((p) => ({ id: p.id, userId: p.userId, proposalId: p.proposalId, rail: p.rail, status: p.status, amountMinor: p.amountMinor, currency: p.currency, reasonCodes: p.reasonCodes })),
    notifications: notes.map((n) => ({ id: n.id, userId: n.userId, kind: n.kind, title: n.title, body: n.body, createdAt: n.createdAt })),
  };
}

export type ControlDeps = { shutdown: () => void; info: () => Json };

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new ControlError(413, "TOO_LARGE", "control body limit is 2 MB");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return v && typeof v === "object" ? (v as Json) : {};
  } catch {
    throw new ControlError(400, "BAD_JSON", "body is not JSON");
  }
}

function tokenOk(got: unknown, expected: string): boolean {
  const a = Buffer.from(typeof got === "string" ? got : "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function personaUser(req: IncomingMessage): Promise<string> {
  const auth = req.headers.authorization;
  const userId = auth?.startsWith("Bearer ") ? await verifyToken(auth.slice(7).trim(), "access") : null;
  if (!userId) throw new ControlError(401, "UNAUTHENTICATED", "persona access token missing or invalid");
  return userId;
}

export function controlHandler(token: string, deps: ControlDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      if (!tokenOk(req.headers[SIM_TOKEN_HEADER], token)) throw new ControlError(403, "FORBIDDEN", "bad sim token");
      if (req.method !== "POST") throw new ControlError(405, "METHOD", "POST only");
      const body = await readBody(req);
      switch (req.url) {
        case "/health":
          return send(200, { ok: true, ...deps.info(), now: clock.now().toISOString(), ledgerHeadSeq: await headSeq() });
        case "/shutdown":
          send(200, { ok: true });
          deps.shutdown();
          return;
        case "/tick":
          await tick((msg, err) => console.error(msg, err));
          return send(200, { ok: true, now: clock.now().toISOString() });
        case "/ledger-head":
          return send(200, { seq: await headSeq(), now: clock.now().toISOString() });
        case "/ledger-verify":
          return send(200, { ...(await ledger.verify()), verifiedAt: clock.now().toISOString() });
        case "/evidence":
          return send(200, await evidence(body));
        case "/tool":
          return send(200, await runTool(body, await personaUser(req)));
        case "/user-text":
          return send(200, await userText(body, await personaUser(req)));
        case "/payment":
          return send(200, await paymentOf(body, await personaUser(req)));
        default:
          throw new ControlError(404, "NOT_FOUND", `no control route ${req.url}`);
      }
    } catch (e) {
      if (e instanceof ControlError) return send(e.status, { error: e.code, message: e.message });
      console.error("[sim-control]", e);
      return send(500, { error: "CONTROL_INTERNAL", message: (e as Error).message });
    }
  };
}
