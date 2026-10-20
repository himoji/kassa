/*
 * (2026-10-20) Voice pay: "send 15 euro to my friend Li Wei" through the voice Shortcut (POST /capture/voice).
 * SECURITY INVARIANT under test: the Shortcut key cannot move money. A voice turn may only DRAFT one passkey-only
 * order to the one payee the server matched; it is PENDING_APPROVAL until the user approves it with their passkey on
 * the web order page (approveUrl), and the key itself can never approve. An unknown or ambiguous name drafts nothing.
 */
import { randomUUID } from "node:crypto";

import { buildIban } from "@kassa/shared";
import type { LanguageModel } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { IDS, LI_WEI_IDS, LI_WEI_MOCK_BANK_PROFILE_ID } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { approvals, notifications, payees, payments, proposals, users, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { replayModel, type RecordedStep } from "../../src/modules/agent/replay.ts";
import { setVoiceModelForTests } from "../../src/modules/capture/routes.ts";
import { matchVoiceRecipient } from "../../src/modules/capture/voicePay.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { setRailOverridesForTests } from "../../src/modules/rails/index.ts";
import { setBalanceProviderForTests } from "../../src/modules/rules/facts.ts";
import { approveOrder, getOrderView } from "../../src/modules/rules/index.ts";
import { kassaIdFor } from "../../src/modules/wallet/service.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment, signBaseRules } from "../helpers/fixtures.ts";
import { deliverWebhooks, startMockWorld, type TestMockWorld } from "../helpers/mockWorld.ts";
import { SoftAuthenticator } from "../helpers/webauthn.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld | null = null;

async function seedWithPasskey(): Promise<SoftAuthenticator> {
  await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
  const auth = new SoftAuthenticator();
  const row = { userId: IDS.user, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  await signBaseRules(IDS.user, auth, "KZT");
  await getDb().update(users).set({ aiConsentAt: clock.now() }).where(eq(users.id, IDS.user));
  return auth;
}

async function addPayee(name: string, account: string, currency = "EUR", country = "HU"): Promise<string> {
  const res = await app().inject({ method: "POST", url: "/api/payees", headers: await bearer(IDS.user), payload: { name, kind: "PERSON", account, country, currency } });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { id: string }).id;
  // Cooling as always (I7); skip the 24 h here.
  await getDb().update(payees).set({ status: "VERIFIED", verifiedAt: clock.now(), coolingUntil: null }).where(eq(payees.id, id));
  return id;
}

const addLiWei = () => addPayee("Li Wei", `KASSA:${kassaIdFor(LI_WEI_IDS.user)}`);

async function shortcutKey(): Promise<string> {
  const res = await app().inject({ method: "POST", url: "/api/devices/shortcut", headers: await bearer(IDS.user) });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

/** The planner for the next voice turns, scripted. */
function scripted(steps: RecordedStep[]): MockLanguageModelV4 {
  const model = replayModel({ userText: "x", match: [], steps }) as unknown as MockLanguageModelV4;
  setVoiceModelForTests(model as unknown as LanguageModel);
  return model;
}

const voice = (token: string, text: string) =>
  app().inject({ method: "POST", url: "/api/capture/voice", headers: { authorization: `Bearer ${token}` }, payload: { text } });

const userProposals = () => getDb().select().from(proposals).where(eq(proposals.userId, IDS.user));

describe("voice pay (Shortcut drafts, passkey approves)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
    setBalanceProviderForTests(null);
    setRailOverridesForTests({});
    clock.setOffsetInMemoryForTests(0);
    await mw?.close();
    mw = await startMockWorld();
  });
  afterEach(() => setVoiceModelForTests(null));
  afterAll(async () => {
    await mw?.close();
  });

  it("drafts exactly one PENDING_APPROVAL order to the named Kassa friend; only the passkey makes it pay, and the friend is notified", async () => {
    const auth = await seedWithPasskey();
    const top = await app().inject({ method: "POST", url: "/api/wallet/top-ups", headers: await bearer(IDS.user), payload: { amountMinor: 10_000, currency: "EUR", method: "APPLE_PAY", idempotencyKey: randomUUID() } });
    expect(top.statusCode).toBe(200);
    const li = await addLiWei();
    const model = scripted([
      // A misbehaving planner: a conversion, the same payment twice in one step, then a further try.
      {
        toolCalls: [
          { toolName: "propose_order", input: { kind: "CONVERT", currency: "USD", fromCurrency: "EUR", amountMinor: 1_500, purpose: "x" } },
          { toolName: "propose_order", input: { payeeRef: "payee_1", amountMinor: 1_500, currency: "EUR", purpose: "For the concert" } },
          { toolName: "propose_order", input: { payeeRef: "payee_1", amountMinor: 1_500, currency: "EUR", purpose: "For the concert" } },
        ],
      },
      { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "payee_1", amountMinor: 9_000, currency: "EUR", purpose: "again" } }] },
      { text: "OK, 15 euro to payee_1 is ready: approve it with your passkey on the page that opens." },
    ]);

    const res = await voice(await shortcutKey(), "Send 15 euro to my friend Li Wei");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; reply: string; approveUrl: string | null };
    expect(body.ok).toBe(true);
    // The model was told who the payee is (as a placeholder) and saw no real name.
    const prompts = JSON.stringify(model.doStreamCalls.map((c) => c.prompt));
    expect(prompts).toContain("The payee the user named is payee_1");
    expect(prompts).not.toContain("Li Wei");
    expect(body.reply).toContain("Li Wei");

    const rows = await userProposals();
    expect(rows).toHaveLength(1);
    const p = rows[0]!;
    expect(p.status).toBe("PENDING_APPROVAL");
    expect(p.decision).toBe("ASK");
    expect(p.draft).toMatchObject({ payeeId: li, amountMinor: 1_500, currency: "EUR" });
    expect(body.approveUrl).toBe(`http://localhost:8081/order/${p.id}?from=lite`);
    // Nothing executed, nothing approved.
    expect(await getDb().select().from(approvals).where(eq(approvals.proposalId, p.id))).toHaveLength(0);
    expect(await getDb().select().from(payments).where(eq(payments.proposalId, p.id))).toHaveLength(0);

    // The Shortcut key cannot approve: not as a bearer token, not as ?key=.
    const key = await shortcutKey();
    for (const r of [
      await app().inject({ method: "POST", url: `/api/orders/${p.id}/approve`, headers: { authorization: `Bearer ${key}` }, payload: {} }),
      await app().inject({ method: "POST", url: `/api/orders/${p.id}/approve?key=${encodeURIComponent(key)}`, payload: {} }),
    ]) expect(r.statusCode).toBe(401);
    expect(await getDb().select().from(payments).where(eq(payments.proposalId, p.id))).toHaveLength(0);

    // The passkey approval (the web order page) is what executes it; the friend's Kassa wallet receives it.
    const view = await getOrderView(IDS.user, p.id);
    expect(view.canonicalOrder).toMatchObject({ payeeName: "Li Wei", amountMinor: 1_500, currency: "EUR" });
    expect((await approveOrder(IDS.user, p.id, auth.assert(view.orderHash))).paymentStatus).toBe("PROCESSING");
    const liBefore = await (async () => {
      const raw = (await mw!.app.inject({ method: "GET", url: `/mock/v4/profiles/${LI_WEI_MOCK_BANK_PROFILE_ID}/balances?types=STANDARD` })).json() as { currency: string; amount: { valueMinor: number } }[];
      return raw.find((b) => b.currency === "EUR")?.amount.valueMinor ?? 0;
    })();
    clock.setOffsetInMemoryForTests(clock.offsetMs() + 2 * 86_400_000);
    await mw!.app.inject({ method: "POST", url: "/mock/bank/tick" });
    const raw = (await mw!.app.inject({ method: "GET", url: `/mock/v4/profiles/${LI_WEI_MOCK_BANK_PROFILE_ID}/balances?types=STANDARD` })).json() as { currency: string; amount: { valueMinor: number } }[];
    expect(raw.find((b) => b.currency === "EUR")?.amount.valueMinor).toBe(liBefore + 1_500);
    await deliverWebhooks(mw!, app());
    const note = (await getDb().select().from(notifications).where(and(eq(notifications.userId, LI_WEI_IDS.user), eq(notifications.kind, "MONEY_RECEIVED"))))[0];
    expect(note?.title).toBe("Dana sent you 15.00 EUR");
  });

  it("an unknown name drafts nothing, even when the planner tries", async () => {
    await seedWithPasskey();
    await addLiWei();
    scripted([
      { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "payee_1", amountMinor: 1_500, currency: "EUR", purpose: "x" } }] },
      { text: "I could not find Zorro among your payees." },
    ]);
    const res = await voice(await shortcutKey(), "Send 15 euro to my friend Zorro");
    expect(res.statusCode).toBe(200);
    expect(res.json().approveUrl).toBeNull();
    expect(await userProposals()).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });

  it("an ambiguous name asks which one and drafts nothing", async () => {
    await seedWithPasskey();
    await addPayee("Anna Kovacs", buildIban("HU", "117730161111101800000000"));
    await addPayee("Anna Szabo", buildIban("HU", "117730162222202800000000"));
    const model = scripted([
      { toolCalls: [{ toolName: "propose_order", input: { payeeRef: "payee_1", amountMinor: 1_500, currency: "EUR", purpose: "x" } }] },
      { text: "Which Anna: payee_1 or payee_2?" },
    ]);
    const res = await voice(await shortcutKey(), "Send 15 euro to Anna");
    expect(res.statusCode).toBe(200);
    expect(res.json().approveUrl).toBeNull();
    expect(res.json().reply).toMatch(/Anna Kovacs|Anna Szabo/);
    expect(JSON.stringify(model.doStreamCalls.map((c) => c.prompt))).toMatch(/Several of the user's payees match the name they said: payee_\d, payee_\d/);
    expect(await userProposals()).toHaveLength(0);
  });
});

describe("matchVoiceRecipient", () => {
  const row = (id: string, name: string, kassaWallet = false, kind = "PERSON") => ({ id, name, kind, status: "VERIFIED", replacesPayeeId: null, kassaWallet });

  it("a whole name wins over first names; Kassa-wallet friends come first; several left is ambiguous", () => {
    const rows = [row("a", "Anna Kovacs"), row("b", "Anna Szabo")];
    expect(matchVoiceRecipient("send 15 euro to anna", rows)).toMatchObject({ kind: "AMBIGUOUS" });
    expect(matchVoiceRecipient("send 15 euro to Anna Szabo", rows)).toMatchObject({ kind: "ONE", payee: { id: "b" } });
    expect(matchVoiceRecipient("send 15 euro to Anna", [row("a", "Anna Kovács"), row("w", "Anna Lee", true)])).toMatchObject({ kind: "ONE", payee: { id: "w", kassaWallet: true } });
    expect(matchVoiceRecipient("send 15 euro to Anna", [row("v", "Anna Lee", true), row("w", "Anna Ray", true)])).toMatchObject({ kind: "AMBIGUOUS" });
    expect(matchVoiceRecipient("pay Kovacs", [row("a", "Anna Kovács")])).toMatchObject({ kind: "ONE" });
    expect(matchVoiceRecipient("send money to Bob", rows)).toEqual({ kind: "NONE" });
    // An organisation matches only by its whole name, never by one word.
    expect(matchVoiceRecipient("pay the landlord", [row("l", "Landlord in Budapest", false, "LANDLORD")])).toEqual({ kind: "NONE" });
  });
});
