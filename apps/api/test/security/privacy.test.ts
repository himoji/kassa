/*
 * GDPR data-subject rights and crypto-shredding (Arts. 15, 16, 17, 18, 20, 7(3)); EU AI Act Art. 50 notice.
 * The key property: after an erasure every ledger entry is still there and `ledger.verify()` (what
 * `bun run ledger:verify` runs) passes, yet no personal value survives anywhere in the database in clear,
 * and the user's export contains nothing personal.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { budgets, cards, ledgerEntries, obligations, placeholderMaps, proposals, userKeys, users } from "../../src/db/schema.ts";
import { agentDocuments, agentMessages, onboardingDrafts } from "../../src/db/schema.intel.ts";
import { ingestCapture } from "../../src/modules/capture/index.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { notify } from "../../src/modules/notifications/service.ts";
import { exportUserData } from "../../src/modules/privacy/service.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { addPayee, createUserWithPasskey, IBAN_OTHER, offlineEnvironment } from "../helpers/fixtures.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const app = useTestApp();

const NAME = "Erika Mustermann-Sample";
const RENAMED = "Erika Sample-Renamed";
const PAYEE = "Zebulon Quartermaine Lettings";
const MERCHANT = "QUIXOTIC BAKERY NO 7";
const REASON = "wrong amount, call Zebulon first";
const DOC_TEXT = "Invoice from Zebulon Quartermaine, pay to HU03 1620 0216 9011 7442 0000 0000";
const CHAT = "pay Zebulon, my email erika@example.org";

type Gated = { challengeId: string; webauthnOptions: { challenge: string } };

async function gated(url: string, h: Record<string, string>, body: Record<string, unknown>, auth: SoftAuthenticator) {
  const first = await app().inject({ method: "POST", url, headers: h, payload: body });
  expect(first.statusCode, first.body).toBe(428);
  const d = first.json().details as Gated;
  return app().inject({ method: "POST", url, headers: h, payload: { ...body, challengeId: d.challengeId, assertion: auth.assert(d.webauthnOptions.challenge) } });
}

describe("Art. 15/16/17/20: export, rectify, erase by crypto-shredding", () => {
  let userId = "";
  let auth: SoftAuthenticator;
  let h: { authorization: string };
  let accountHash = "";
  let verifyId = "";
  const conversationId = randomUUID();

  beforeAll(async () => {
    await ensureIntelTables(t.db());
    offlineEnvironment();
    const u = await createUserWithPasskey();
    userId = u.userId;
    auth = u.auth;
    h = await bearer(userId);
    const db = getDb();
    const payee = await addPayee(userId, { name: PAYEE, account: IBAN_OTHER, currency: "EUR", kind: "LANDLORD" });
    accountHash = payee.accountHash!;
    // A payee created over HTTP (PAYEE_CREATED ledger entry with its sealed account hash).
    expect((await app().inject({ method: "POST", url: "/api/payees", headers: h, payload: { name: `${PAYEE} II`, kind: "LANDLORD", account: IBAN_OTHER, country: "HU", currency: "HUF" } })).statusCode).toBe(201);
    // Executed payment (retained record) + a rejected order with a free-text reason (sealed in the ledger).
    const paid = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 50_000, currency: "EUR", purpose: `Rent to ${PAYEE}` });
    const view = await getOrderView(userId, paid.proposalId);
    await approveOrder(userId, paid.proposalId, auth.assert(view.orderHash));
    const rejected = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 60_000, currency: "EUR", purpose: "Deposit" });
    expect((await app().inject({ method: "POST", url: `/api/orders/${rejected.proposalId}/reject`, headers: h, payload: { reason: REASON } })).statusCode).toBe(204);
    // Captured purchase (merchant sealed in the ledger), notification, conversation, document, draft, budget, card.
    await ingestCapture(userId, { source: "TEXT", fields: { merchant: MERCHANT, amountMinor: 1_200, currency: "HUF" } });
    await notify(userId, { kind: "TEST", title: `Paid ${PAYEE}`, body: MERCHANT });
    await db.insert(agentMessages).values({ conversationId, userId, channel: "agent", seq: 0, message: { role: "user", content: CHAT }, createdAt: clock.now() });
    await db.insert(placeholderMaps).values({ conversationId, placeholder: "person_1", kind: "PERSON", realRef: PAYEE });
    await db.insert(agentDocuments).values({ userId, conversationId, filename: "zebulon.txt", mediaType: "text/plain", dataB64: Buffer.from(DOC_TEXT).toString("base64"), createdAt: clock.now() });
    await db.insert(onboardingDrafts).values({ conversationId: randomUUID(), userId, draft: { displayName: NAME } as never, updatedAt: clock.now() });
    await db.insert(budgets).values({ userId, category: "groceries", periodStart: "2026-10-01", periodEnd: "2026-10-31", limitHomeMinor: 1000 });
    await db.insert(cards).values({ userId, label: `${NAME} card`, last4: "4821", billingCurrency: "KZT", kind: "HOME_KZT" });
    await db.insert(obligations).values({ userId, payeeId: payee.id, amountMinor: 100, currency: "EUR", dueDate: "2026-12-01", recurrence: "MONTHLY", reference: `REF ${PAYEE}`, category: "rent" });
    const cr = await app().inject({ method: "POST", url: "/api/credit-record/export", headers: h, payload: { from: "2026-01-01", to: "2026-10-31", items: ["BILLS"] } });
    expect(cr.statusCode, cr.body).toBe(200);
    verifyId = cr.json().verifyId;
  });

  it("Art. 16: PATCH /me rectifies the name (logged with the value sealed)", async () => {
    const res = await app().inject({ method: "PATCH", url: "/api/me", headers: h, payload: { displayName: NAME } });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe(NAME);
    const again = await app().inject({ method: "PATCH", url: "/api/me", headers: h, payload: { displayName: RENAMED } });
    expect(again.json().displayName).toBe(RENAMED);
    expect((await app().inject({ method: "PATCH", url: "/api/me", headers: h, payload: { displayName: "" } })).statusCode).toBe(400);
  });

  it("personal ledger fields are stored as ciphertext; the owner sees them decrypted", async () => {
    const raw = JSON.stringify(await getDb().select().from(ledgerEntries));
    for (const s of [MERCHANT.toLowerCase(), REASON, RENAMED, NAME, accountHash]) expect(raw).not.toContain(s);
    const res = await app().inject({ method: "GET", url: "/api/ledger?limit=200", headers: h });
    const items = res.json().items as { type: string; payload: Record<string, unknown> }[];
    expect(items.find((i) => i.type === "CAPTURE_LOGGED")?.payload.merchantNorm).toMatch(/^quixotic bakery/);
    expect(items.find((i) => i.type === "ORDER_REJECTED")?.payload.reason).toBe(REASON);
    expect(items.find((i) => i.type === "PAYEE_CREATED")?.payload.accountHash).toBe(accountHash);
    expect(items.every((i) => !("pii" in i.payload))).toBe(true);
    expect((await app().inject({ method: "GET", url: `/api/public/verify/${verifyId}` })).json()).toMatchObject({ valid: true });
  });

  it("Art. 15/20: GET /privacy/export returns all personal data, decrypted, as JSON", async () => {
    const res = await app().inject({ method: "GET", url: "/api/privacy/export", headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    const body = res.json();
    expect(body).toMatchObject({ format: "kassa.dsar-export", version: 1, subject: { userId } });
    expect(body.processing.automatedDecisions.exists).toBe(true);
    const s = JSON.stringify(body);
    for (const v of [RENAMED, PAYEE, IBAN_OTHER, MERCHANT, REASON, CHAT, "4821"]) expect(s, v).toContain(v);
    expect(body.data.documents[0].dataB64).toBe(Buffer.from(DOC_TEXT).toString("base64"));
  });

  it("Art. 17: erase needs a fresh passkey assertion over a server challenge", async () => {
    const noAssertion = await app().inject({ method: "POST", url: "/api/privacy/erase", headers: h, payload: { confirm: "ERASE" } });
    expect(noAssertion.statusCode).toBe(428);
    const d = noAssertion.json().details as Gated;
    // An assertion over anything else (e.g. an old challenge) is refused and audited.
    const wrong = await app().inject({ method: "POST", url: "/api/privacy/erase", headers: h, payload: { confirm: "ERASE", challengeId: d.challengeId, assertion: auth.assert("not-the-challenge") } });
    expect(wrong.statusCode).toBe(403);
    expect((await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "AUTH_ASSERTION_FAILED"))).length).toBeGreaterThan(0);
    expect((await app().inject({ method: "POST", url: "/api/privacy/erase", headers: h, payload: { confirm: "nope" } })).statusCode).toBe(400);
    const ledgerBefore = (await ledger.verify()).entries;

    const res = await gated("/api/privacy/erase", h, { confirm: "ERASE" }, auth);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().retained.length).toBeGreaterThan(0);

    // The chain is intact: every entry still there (plus the erasure audit), all hashes and checkpoints verify.
    const report = await ledger.verify();
    expect(report.ok).toBe(true);
    expect(report.entries).toBe(ledgerBefore + 1);
    const key = (await getDb().select().from(userKeys).where(eq(userKeys.userId, userId)))[0]!;
    expect(key.wrappedDek).toBeNull();
    expect(key.shreddedAt).not.toBeNull();
  });

  it("after erasure: no personal value survives in any table, in clear", async () => {
    const tables = (await getDb().execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { rows: { tablename: string }[] };
    const dump: string[] = [];
    for (const { tablename } of tables.rows) {
      const r = (await getDb().execute(sql.raw(`select row_to_json(x)::text as j from "${tablename}" x`))) as unknown as { rows: { j: string }[] };
      dump.push(...r.rows.map((x) => x.j));
    }
    const all = dump.join("\n");
    for (const v of [NAME, RENAMED, PAYEE, IBAN_OTHER, "HU03 1620", MERCHANT, MERCHANT.toLowerCase(), REASON, CHAT, "erika@example.org", accountHash, Buffer.from(DOC_TEXT).toString("base64")]) {
      expect(all, `"${v}" survived erasure`).not.toContain(v);
    }
    // Retained payment record: amounts and hashes only.
    const kept = await getDb().select().from(proposals).where(eq(proposals.userId, userId));
    expect(kept).toHaveLength(1);
    expect(kept[0]!.canonicalOrder).toMatchObject({ payeeName: "[erased]", purpose: "[erased]", amountMinor: 50_000 });
  });

  it("after erasure: export returns nothing personal, sessions and the public credit record are gone", async () => {
    const exp = await exportUserData(userId);
    const s = JSON.stringify(exp);
    for (const v of [NAME, RENAMED, PAYEE, IBAN_OTHER, MERCHANT, MERCHANT.toLowerCase(), REASON, CHAT, accountHash, "4821"]) expect(s, v).not.toContain(v);
    const data = exp.data as { ledger: { payload: Record<string, unknown> }[]; payees: unknown[]; transactions: unknown[]; user: { displayName: string; erasedAt: string } };
    expect(data.payees).toEqual([]);
    expect(data.transactions).toEqual([]);
    expect(data.user.displayName).toBe("[erased]");
    expect(data.user.erasedAt).toBeTruthy();
    expect(data.ledger.filter((e) => e.payload.piiErased === true).length).toBeGreaterThanOrEqual(4);

    const me = await app().inject({ method: "GET", url: "/api/me", headers: h });
    expect(me.statusCode).toBe(401);
    expect(me.json().code).toBe("ACCOUNT_ERASED");
    const opt = (await app().inject({ method: "POST", url: "/api/auth/login/options" })).json();
    const login = await app().inject({ method: "POST", url: "/api/auth/login/verify", payload: { challengeId: opt.challengeId, response: auth.assert(opt.options.challenge), client: "native" } });
    expect(login.statusCode).toBe(401);
    const pub = await app().inject({ method: "GET", url: `/api/public/verify/${verifyId}` });
    expect(pub.statusCode).toBe(410);
    // The leftover token cannot attach a new passkey to the erased account either.
    const addDevice = await app().inject({ method: "POST", url: "/api/auth/register/options", headers: h, payload: { displayName: "back" } });
    expect(addDevice.statusCode).toBe(401);
    expect((await getDb().select().from(users).where(eq(users.id, userId)))[0]!.frozenAt).not.toBeNull();
  });
});

describe("Art. 18 restriction, Art. 7 consent, EU AI Act Art. 50 notice", () => {
  it("restriction freezes and stops AI processing; only a passkey unfreeze (+24 h) lifts it", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const h = await bearer(userId);
    const r = await app().inject({ method: "POST", url: "/api/privacy/restrict", headers: h });
    expect(r.statusCode).toBe(200);
    expect(r.json().frozenAt).toBeTruthy();
    const chat = await app().inject({ method: "POST", url: "/api/agent/message", headers: h, payload: { conversationId: randomUUID(), text: "hi" } });
    expect(chat.statusCode).toBe(403);
    expect(chat.json().code).toBe("PROCESSING_RESTRICTED");
    expect((await app().inject({ method: "GET", url: "/api/me", headers: h })).json().restrictedAt).toBeTruthy();
    const un = await gated("/api/unfreeze", h, {}, auth);
    expect(un.statusCode, un.body).toBe(200);
    await clock.advanceHours(25);
    const { applyDueUnfreezes } = await import("../../src/modules/users/unfreeze.ts");
    expect(await applyDueUnfreezes()).toBe(1);
    // (the 15-minute access token expired with the clock jump: mint a fresh one)
    const me = (await app().inject({ method: "GET", url: "/api/me", headers: await bearer(userId) })).json();
    expect(me.restrictedAt).toBeNull();
    expect(me.frozenAt).toBeNull();
  });

  it("AI routes need consent; consent can be given and withdrawn; registration can capture it", async () => {
    const { userId } = await createUserWithPasskey({ aiConsent: false });
    const h = await bearer(userId);
    const denied = await app().inject({ method: "POST", url: "/api/onboarding/message", headers: h, payload: { conversationId: randomUUID(), text: "hi" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "AI_CONSENT_REQUIRED", reasonCodes: ["AI_CONSENT_REQUIRED"] });
    expect(denied.json().details.aiNotice.isAiSystem).toBe(true);
    const upload = await app().inject({ method: "POST", url: "/api/agent/documents", headers: h });
    expect(upload.statusCode).toBe(403);

    const give = await app().inject({ method: "POST", url: "/api/privacy/ai-consent", headers: h, payload: { consent: true } });
    expect(give.json().aiConsentAt).toBeTruthy();
    const allowed = await app().inject({ method: "POST", url: "/api/onboarding/message", headers: h, payload: { conversationId: randomUUID(), text: "hi" } });
    expect(allowed.statusCode).not.toBe(403);
    const withdraw = await app().inject({ method: "POST", url: "/api/privacy/ai-consent", headers: h, payload: { consent: false } });
    expect(withdraw.json().aiConsentAt).toBeNull();
    expect((await app().inject({ method: "POST", url: "/api/onboarding/message", headers: h, payload: { conversationId: randomUUID(), text: "hi" } })).statusCode).toBe(403);
    const types = (await getDb().select({ type: ledgerEntries.type }).from(ledgerEntries)).map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(["AI_CONSENT_GIVEN", "AI_CONSENT_WITHDRAWN"]));

    // Consent ticked on the sign-up screen.
    const a = new SoftAuthenticator();
    const opt = (await app().inject({ method: "POST", url: "/api/auth/register/options", payload: { displayName: "New" } })).json();
    const reg = await app().inject({ method: "POST", url: "/api/auth/register/verify", payload: { challengeId: opt.challengeId, response: a.register(opt.options.challenge), client: "native", aiConsent: true } });
    expect(reg.statusCode).toBe(200);
    const me = await app().inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${reg.json().tokens.accessToken}` } });
    expect(me.json().aiConsentAt).toBeTruthy();
  });

  it("GET /me and the public GET /privacy/ai-notice tell the user it is an AI and which provider processes the data", async () => {
    const saved = process.env.PLANNER_MODEL;
    process.env.PLANNER_MODEL = "ollama:llama3.3";
    try {
      const { userId } = await createUserWithPasskey();
      const me = (await app().inject({ method: "GET", url: "/api/me", headers: await bearer(userId) })).json();
      expect(me.aiNotice).toMatchObject({ isAiSystem: true, canPay: false, consentRequired: true, planner: { provider: "ollama", model: "llama3.3", local: true } });
      expect(me.aiNotice.text).toMatch(/AI assistant, not a person/);
      expect(me.aiNotice.reader.local).toBe(false);
      const pub = await app().inject({ method: "GET", url: "/api/privacy/ai-notice" });
      expect(pub.statusCode).toBe(200);
      expect(pub.json().redacted).toEqual(expect.arrayContaining(["IBANs and account numbers", "card numbers"]));
    } finally {
      if (saved === undefined) delete process.env.PLANNER_MODEL;
      else process.env.PLANNER_MODEL = saved;
    }
  });
});
