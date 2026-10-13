/*
 * Object-level authorisation (OWASP API1:2023 BOLA / IDOR). User B, fully signed in, targets every kind of
 * object user A owns. Expected: 404 (the same answer as for a missing id, so existence does not leak), A's
 * objects unchanged, lists never include them, and each probe of an existing object is audited
 * (AUTHZ_DENIED with B as actor).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerEntries, mandates, notifications, payments, placeholderMaps, proposals, transactions } from "../../src/db/schema.ts";
import { agentMessages, conversations, onboardingDrafts } from "../../src/db/schema.intel.ts";
import { claimConversation, loadPlaceholders } from "../../src/modules/agent/history.ts";
import { notify } from "../../src/modules/notifications/service.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { addActiveMandate, addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment } from "../helpers/fixtures.ts";
import type { SoftAuthenticator } from "../helpers/webauthn.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const app = useTestApp();

const A: { userId: string; auth: SoftAuthenticator | null; payeeId: string; pendingId: string; paymentId: string; mandateId: string; notificationId: string; txId: string; conversationId: string } = {
  userId: "",
  auth: null,
  payeeId: "",
  pendingId: "",
  paymentId: "",
  mandateId: "",
  notificationId: "",
  txId: "",
  conversationId: randomUUID(),
};
let B: { userId: string; auth: SoftAuthenticator; h: { authorization: string } };

beforeAll(async () => {
  await ensureIntelTables(t.db());
  offlineEnvironment();
  const a = await createUserWithPasskey();
  A.userId = a.userId;
  A.auth = a.auth;
  const payee = await addPayee(a.userId, { name: "University of Alice", kind: "UNIVERSITY", account: IBAN_UNIVERSITY, currency: "EUR" });
  A.payeeId = payee.id;
  // One executed order (→ payment) and one pending order.
  const done = await proposeOrder({ userId: a.userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 100_000, currency: "EUR", purpose: "Tuition part 1" });
  const view = await getOrderView(a.userId, done.proposalId);
  const paid = await approveOrder(a.userId, done.proposalId, a.auth.assert(view.orderHash));
  A.paymentId = paid.paymentId!;
  A.pendingId = (await proposeOrder({ userId: a.userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 120_000, currency: "EUR", purpose: "Tuition part 2" })).proposalId;
  A.mandateId = (await addActiveMandate(a.userId, a.auth, { payeeIds: [payee.id], categories: ["tuition"], currency: "EUR", maxPerPaymentMinor: 300_000, maxPerPeriodMinor: 300_000 })).mandateId;
  A.notificationId = await notify(a.userId, { kind: "TEST", title: "For Alice", body: "private" });
  A.txId = (
    await getDb()
      .insert(transactions)
      .values({ userId: a.userId, source: "TEXT", occurredAt: new Date(), merchantRaw: "Alice Bakery", merchantNorm: "alice bakery", amountMinor: 500, currency: "HUF", category: "groceries", status: "SETTLED" })
      .returning({ id: transactions.id })
  )[0]!.id;
  await getDb().insert(agentMessages).values({ conversationId: A.conversationId, userId: a.userId, channel: "agent", seq: 0, message: { role: "user", content: "hi from payee_1" }, createdAt: new Date() });
  await getDb().insert(placeholderMaps).values({ conversationId: A.conversationId, userId: a.userId, placeholder: "payee_1", kind: "PAYEE", realRef: payee.id });

  const b = await createUserWithPasskey();
  B = { userId: b.userId, auth: b.auth, h: await bearer(b.userId) };
});

async function denied(): Promise<{ existed: boolean; resourceId: string }[]> {
  const rows = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "AUTHZ_DENIED"));
  return rows.map((r) => r.payload as { actorUserId?: string; existed: boolean; resourceId: string; userId?: string }).filter((p) => p.actorUserId === B.userId && p.userId === undefined);
}

describe("user B cannot reach user A's objects", () => {
  it("each targeted request answers 404 exactly like a missing id, and is audited", async () => {
    const assertion = B.auth.assert("anything");
    const cases: { method: "GET" | "POST"; url: string; payload?: unknown }[] = [
      { method: "GET", url: `/api/orders/${A.pendingId}` },
      { method: "POST", url: `/api/orders/${A.pendingId}/approve`, payload: { assertion } },
      { method: "POST", url: `/api/orders/${A.pendingId}/reject`, payload: { reason: "mine now" } },
      { method: "POST", url: `/api/payees/${A.payeeId}/verify-callback` },
      { method: "POST", url: `/api/mandates/${A.mandateId}/revoke` },
      { method: "POST", url: `/api/notifications/${A.notificationId}/read` },
      { method: "POST", url: `/api/transactions/${A.txId}/category`, payload: { category: "rent" } },
      { method: "POST", url: `/api/payments/${A.paymentId}/intent` },
      { method: "POST", url: `/api/payments/${A.paymentId}/intent/simulate-success` },
      { method: "GET", url: `/api/handoff/${A.paymentId}` },
    ];
    const before = (await denied()).length;
    for (const c of cases) {
      const res = await app().inject({ method: c.method, url: c.url, headers: B.h, payload: c.payload as never });
      expect(res.statusCode, `${c.method} ${c.url}: ${res.body}`).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
      // A truly missing id gets the identical answer.
      const missing = await app().inject({ method: c.method, url: c.url.replace(/[0-9a-f-]{36}/, randomUUID()), headers: B.h, payload: c.payload as never });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe(res.json().code);
    }
    // Audited uniformly (missing ids too); only the server knows which probes hit a real object.
    const entries = (await denied()).slice(before);
    expect(entries).toHaveLength(cases.length * 2);
    expect(entries.filter((e) => e.existed)).toHaveLength(cases.length);
  });

  it("A's objects are unchanged", async () => {
    const db = getDb();
    expect((await db.select().from(proposals).where(eq(proposals.id, A.pendingId)))[0]!.status).toBe("PENDING_APPROVAL");
    expect((await db.select().from(mandates).where(eq(mandates.id, A.mandateId)))[0]!.status).toBe("ACTIVE");
    expect((await db.select().from(notifications).where(eq(notifications.id, A.notificationId)))[0]!.readAt).toBeNull();
    expect((await db.select().from(transactions).where(eq(transactions.id, A.txId)))[0]!.category).toBe("groceries");
    expect((await db.select().from(payments).where(and(eq(payments.id, A.paymentId), eq(payments.userId, A.userId))))).toHaveLength(1);
  });

  it("B cannot continue A's agent conversation (placeholder maps stay private): 404", async () => {
    const res = await app().inject({ method: "POST", url: "/api/agent/message", headers: B.h, payload: { conversationId: A.conversationId, text: "who is payee_1?" } });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("University of Alice");
  });

  it("B's lists, ledger and data export never contain A's objects", async () => {
    const urls = ["/api/payees", "/api/mandates", "/api/proposals", "/api/notifications", "/api/transactions", "/api/ledger", "/api/rule-changes?status=all", "/api/privacy/export", "/api/obligations", "/api/cards"];
    const secrets = [A.userId, A.payeeId, A.pendingId, A.paymentId, A.mandateId, A.notificationId, A.txId, A.conversationId, "University of Alice", "Alice Bakery", IBAN_UNIVERSITY];
    for (const url of urls) {
      const res = await app().inject({ method: "GET", url, headers: B.h });
      expect(res.statusCode, url).toBe(200);
      for (const s of secrets) expect(res.body, `${url} leaks ${s}`).not.toContain(s);
    }
  });

  it("B cannot mint a mandate for A's payee or in A's name", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/api/mandates/options",
      headers: B.h,
      payload: { payeeIds: [A.payeeId], categories: ["tuition"], currency: "EUR", maxPerPaymentMinor: 1000, maxPerPeriodMinor: 1000, period: "MONTH", validUntil: null },
    });
    expect(res.statusCode).toBe(404);
  });
});

/** One-file multipart body for POST /agent/documents. */
function multipartDoc(fields: Record<string, string>): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----kassa${randomUUID()}`;
  const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bill.txt"\r\nContent-Type: text/plain\r\n\r\nInvoice 10 EUR\r\n--${boundary}--\r\n`);
  return { payload: Buffer.from(parts.join("")), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("conversation ownership across channels (conversations table)", () => {
  it("an id is one user's and one channel's: cross-user and cross-channel reuse answer 404 and are audited", async () => {
    const aH = await bearer(A.userId);
    // A's agent conversation cannot be continued as A's onboarding chat (nor B's).
    for (const h of [aH, B.h]) {
      const res = await app().inject({ method: "POST", url: "/api/onboarding/message", headers: h, payload: { conversationId: A.conversationId, text: "hi" } });
      expect(res.statusCode).toBe(404);
    }
    // An onboarding conversation of A cannot be used for the agent chat, by A or by B.
    const onboardingId = randomUUID();
    await getDb().insert(onboardingDrafts).values({ conversationId: onboardingId, userId: A.userId, draft: { displayName: null, homeCurrency: "KZT", region: null, preset: null, moneyMode: null, notificationMode: null, incomes: [], obligations: [], budgets: [], cards: [] }, updatedAt: new Date() });
    for (const h of [aH, B.h]) {
      const res = await app().inject({ method: "POST", url: "/api/agent/message", headers: h, payload: { conversationId: onboardingId, text: "hello" } });
      expect(res.statusCode).toBe(404);
    }
    const probes = (await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "AUTHZ_DENIED"))).map((r) => r.payload as { resourceId?: string });
    expect(probes.filter((p) => p.resourceId === onboardingId).length).toBeGreaterThanOrEqual(2);
  });

  it("POST /agent/documents with another user's conversationId: 404, nothing stored", async () => {
    const { payload, headers } = multipartDoc({ conversationId: A.conversationId, kind: "invoice" });
    const res = await app().inject({ method: "POST", url: "/api/agent/documents", headers: { ...B.h, ...headers }, payload });
    expect(res.statusCode).toBe(404);
    const mine = multipartDoc({ conversationId: randomUUID(), kind: "invoice" });
    const ok = await app().inject({ method: "POST", url: "/api/agent/documents", headers: { ...B.h, ...mine.headers }, payload: mine.payload });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("two users claiming the same new id at once: exactly one wins, the other is refused", async () => {
    const id = randomUUID();
    const results = await Promise.allSettled([claimConversation(id, A.userId, "agent"), claimConversation(id, B.userId, "agent")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const rows = await getDb().select().from(conversations).where(eq(conversations.id, id));
    expect(rows).toHaveLength(1);
    // The loser cannot take it over afterwards either.
    const loser = rows[0]!.userId === A.userId ? B.userId : A.userId;
    await expect(claimConversation(id, loser, "agent")).rejects.toThrow();
  });

  it("history endpoint: B cannot read A's messages; A reads them rehydrated; lists are per user", async () => {
    const res = await app().inject({ method: "GET", url: `/api/agent/conversations/${A.conversationId}/messages`, headers: B.h });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("University of Alice");
    const mine = await app().inject({ method: "GET", url: `/api/agent/conversations/${A.conversationId}/messages`, headers: await bearer(A.userId) });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "hi from University of Alice" }] });
    const list = await app().inject({ method: "GET", url: "/api/agent/conversations", headers: B.h });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(A.conversationId);
    const onboarding = await app().inject({ method: "GET", url: "/api/onboarding/conversation", headers: B.h });
    expect(onboarding.statusCode).toBe(200);
    expect(onboarding.body).not.toContain(A.conversationId);
  });

  it("placeholder maps are scoped to their owner", async () => {
    expect(await loadPlaceholders(A.conversationId, B.userId)).toEqual([]);
    expect((await loadPlaceholders(A.conversationId, A.userId)).map((e) => e.realRef)).toEqual([A.payeeId]);
  });
});
