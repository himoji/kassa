/*
 * I13 webhook hardening beyond HMAC (RUNBOOK S3, S9; SECURITY.md R5, R6):
 * - a valid signed mock webhook replayed inside the 5-minute window is refused (409 WEBHOOK_REPLAYED, ledgered);
 *   the seen-signature store is purged by the scheduler once entries are outside the window;
 * - malicious mock-bank status sequences (unknown state, another user's profile, backwards moves, a move after
 *   the payment is final, SENT before funding, unknown transfer ids) never change a payment and are ledgered.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { payments, profiles, transactions, webhookSeenSignatures } from "../../src/db/schema.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { setRailOverridesForTests, type Rail } from "../../src/modules/rails/index.ts";
import { approveOrder, getOrderView, proposeOrder } from "../../src/modules/rules/index.ts";
import { tick } from "../../src/modules/scheduler/index.ts";
import { purgeSeenWebhookSignatures } from "../../src/modules/webhooks/replay.ts";
import { ledgerOf, ledgerWithReason } from "../helpers/attacks.ts";
import { useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";
import { postSignedWebhook } from "../helpers/mockWorld.ts";

const t = useTestDb();
const app = useTestApp();

const PROFILE_A = 16_000_101;
const PROFILE_B = 16_000_202;

/** A bank transfer the (stub) bank accepted: PROCESSING, funded unless `bankState` says otherwise. */
async function bankPayment(opts: { profileId?: number; bankState?: string; status?: "CREATED" | "PROCESSING" } = {}) {
  const { userId, auth } = await createUserWithPasskey();
  await getDb().update(profiles).set({ bankProfileId: opts.profileId ?? PROFILE_A }).where(eq(profiles.userId, userId));
  const transferId = String(Math.floor(Math.random() * 1e9));
  const rail: Rail = {
    id: "BANK_TRANSFER",
    async execute() {
      return { status: opts.status ?? "PROCESSING", railRef: transferId, details: { bankState: opts.bankState ?? "processing" } };
    },
  };
  setRailOverridesForTests({ BANK_TRANSFER: rail });
  const payee = await addPayee(userId, { name: "University in Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
  const p = await proposeOrder({ userId, createdBy: "USER", payeeId: payee.id, amountMinor: 10_000, currency: "EUR", purpose: "tuition", rail: "BANK_TRANSFER" });
  const view = await getOrderView(userId, p.proposalId);
  const res = await approveOrder(userId, p.proposalId, auth.assert(view.orderHash));
  expect(res.paymentId).toBeTruthy();
  return { userId, transferId, paymentId: res.paymentId! };
}

const bankEvent = (transferId: string, state: string, profileId: number | null = PROFILE_A) => ({
  data: { resource: { type: "transfer", id: Number(transferId), ...(profileId !== null ? { profile_id: profileId } : {}), account_id: 1 }, current_state: state, previous_state: null, occurred_at: clock.now().toISOString() },
  event_type: "transfers#state-change",
  schema_version: "2.0.0",
});

async function paymentRow(id: string) {
  return (await getDb().select().from(payments).where(eq(payments.id, id)))[0]!;
}

describe("webhook replay inside the 5-minute window (I13, R5)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("the same signed delivery is accepted once; the replay gets 409 WEBHOOK_REPLAYED and is ledgered", async () => {
    const body = { eventId: randomUUID(), type: "stock.level", sku: "DOUGH-250G-40", level: 2 };
    const ts = Math.floor(clock.nowMs() / 1000);
    const first = await postSignedWebhook(app(), "pos", body, ts);
    expect(first.statusCode).toBe(200);
    // Replayed 2 minutes later: still inside the window, signature still valid.
    clock.setOffsetInMemoryForTests(120_000);
    const replay = await postSignedWebhook(app(), "pos", body, ts);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: "WEBHOOK_REPLAYED", reasonCodes: ["WEBHOOK_REPLAYED"] });
    expect(await ledgerOf("TRIGGER_POS")).toHaveLength(1);
    expect(await ledgerWithReason("WEBHOOK_REPLAY_REJECTED", "WEBHOOK_REPLAYED")).toHaveLength(1);
  });

  it("a replayed bank status webhook does not move the payment twice; the remittance trigger logs once", async () => {
    const { transferId, paymentId } = await bankPayment();
    const ev = bankEvent(transferId, "outgoing_payment_sent");
    const ts = Math.floor(clock.nowMs() / 1000);
    expect((await postSignedWebhook(app(), "bank", ev, ts)).statusCode).toBe(200);
    expect((await postSignedWebhook(app(), "bank", ev, ts)).statusCode).toBe(409);
    expect((await paymentRow(paymentId)).status).toBe("SENT");
    expect(await getDb().select().from(transactions).where(eq(transactions.paymentId, paymentId))).toHaveLength(1);

    const remit = { eventId: randomUUID(), type: "remittance.incoming", profileId: PROFILE_A, amountMinor: 100_000_000, currency: "KZT" };
    expect((await postSignedWebhook(app(), "remittance", remit, ts)).statusCode).toBe(200);
    expect((await postSignedWebhook(app(), "remittance", remit, ts)).statusCode).toBe(409);
    expect(await ledgerOf("TRIGGER_REMITTANCE")).toHaveLength(1);
  });

  it("a re-signed retry (new timestamp) is a new delivery; a different body with the same timestamp is too", async () => {
    const ts = Math.floor(clock.nowMs() / 1000);
    expect((await postSignedWebhook(app(), "pos", { a: 1 }, ts)).statusCode).toBe(200);
    expect((await postSignedWebhook(app(), "pos", { a: 1 }, ts + 1)).statusCode).toBe(200);
    expect((await postSignedWebhook(app(), "pos", { a: 2 }, ts)).statusCode).toBe(200);
  });

  it("after the window the replay fails the window check; the scheduler purges old signatures", async () => {
    const ts = Math.floor(clock.nowMs() / 1000);
    expect((await postSignedWebhook(app(), "pos", { b: 1 }, ts)).statusCode).toBe(200);
    expect(await getDb().select().from(webhookSeenSignatures)).toHaveLength(1);
    expect(await purgeSeenWebhookSignatures()).toBe(0); // still inside the window: kept

    await clock.setOffset(11 * 60_000); // persisted: the scheduler tick reloads the demo clock
    const late = await postSignedWebhook(app(), "pos", { b: 1 }, ts);
    expect(late.statusCode).toBe(401);
    expect(late.json().code).toBe("WEBHOOK_REPLAY_WINDOW");
    await tick(); // scheduler job "webhookReplayPurge"
    expect(await getDb().select().from(webhookSeenSignatures)).toHaveLength(0);
  });

  it("unsigned or badly signed deliveries are never stored", async () => {
    const bad = await app().inject({ method: "POST", url: "/api/webhooks/mock/pos", payload: "{}", headers: { "content-type": "application/json", "x-kassa-timestamp": String(Math.floor(clock.nowMs() / 1000)), "x-kassa-signature": "ab".repeat(32) } });
    expect(bad.statusCode).toBe(401);
    expect(await getDb().select().from(webhookSeenSignatures)).toHaveLength(0);
  });
});

describe("malicious mock-bank status sequences (I13, R6 / RUNBOOK S9)", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  async function expectRejected(transferId: string, paymentId: string, ev: unknown, reason: string) {
    const before = await paymentRow(paymentId);
    const res = await postSignedWebhook(app(), "bank", ev);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "WEBHOOK_REJECTED", details: { reason } });
    const after = await paymentRow(paymentId);
    expect(after.status).toBe(before.status);
    expect(after.details).toEqual(before.details);
    const logged = (await ledgerOf("WEBHOOK_REJECTED")).map((r) => r.payload as { reason: string; paymentId: string });
    expect(logged.some((p) => p.reason === reason && p.paymentId === paymentId)).toBe(true);
  }

  it("the normal forward sequence is applied and SENT is recorded once", async () => {
    const { transferId, paymentId } = await bankPayment();
    for (const s of ["processing", "funds_converted", "outgoing_payment_sent", "outgoing_payment_sent"]) {
      expect((await postSignedWebhook(app(), "bank", bankEvent(transferId, s))).statusCode).toBe(200);
    }
    const p = await paymentRow(paymentId);
    expect(p.status).toBe("SENT");
    expect(await getDb().select().from(transactions).where(eq(transactions.paymentId, paymentId))).toHaveLength(1);
    expect(await ledgerOf("WEBHOOK_REJECTED")).toHaveLength(0);
  });

  it("backwards transition (funds_converted → processing / incoming_payment_waiting) is rejected", async () => {
    const { transferId, paymentId } = await bankPayment();
    expect((await postSignedWebhook(app(), "bank", bankEvent(transferId, "funds_converted"))).statusCode).toBe(200);
    await expectRejected(transferId, paymentId, bankEvent(transferId, "processing"), "STATUS_REGRESSION");
    await expectRejected(transferId, paymentId, bankEvent(transferId, "incoming_payment_waiting"), "STATUS_REGRESSION");
  });

  it("a final payment cannot be moved again (SENT → cancelled / funds_converted)", async () => {
    const { transferId, paymentId } = await bankPayment();
    expect((await postSignedWebhook(app(), "bank", bankEvent(transferId, "outgoing_payment_sent"))).statusCode).toBe(200);
    await expectRejected(transferId, paymentId, bankEvent(transferId, "cancelled"), "PAYMENT_FINAL");
    await expectRejected(transferId, paymentId, bankEvent(transferId, "funds_converted"), "PAYMENT_FINAL");
    expect((await paymentRow(paymentId)).status).toBe("SENT");
  });

  it("SENT (or funds_converted) before the transfer was funded is rejected", async () => {
    const { transferId, paymentId } = await bankPayment({ status: "CREATED", bankState: "incoming_payment_waiting" });
    await expectRejected(transferId, paymentId, bankEvent(transferId, "outgoing_payment_sent"), "NOT_FUNDED");
    await expectRejected(transferId, paymentId, bankEvent(transferId, "funds_converted"), "NOT_FUNDED");
    expect(await getDb().select().from(transactions).where(eq(transactions.paymentId, paymentId))).toHaveLength(0);
  });

  it("a status event naming another user's bank profile (or none) is rejected", async () => {
    const a = await bankPayment({ profileId: PROFILE_A });
    await bankPayment({ profileId: PROFILE_B });
    await expectRejected(a.transferId, a.paymentId, bankEvent(a.transferId, "outgoing_payment_sent", PROFILE_B), "PROFILE_MISMATCH");
    await expectRejected(a.transferId, a.paymentId, bankEvent(a.transferId, "outgoing_payment_sent", null), "PROFILE_MISMATCH");
  });

  it("an unknown Wise state is rejected (it is not silently mapped to PROCESSING)", async () => {
    const { transferId, paymentId } = await bankPayment();
    await expectRejected(transferId, paymentId, bankEvent(transferId, "money_teleported"), "UNKNOWN_STATE");
  });

  it("an unknown transfer id changes nothing and is ledgered as WEBHOOK_UNMATCHED", async () => {
    const { paymentId } = await bankPayment();
    const res = await postSignedWebhook(app(), "bank", bankEvent("999999999", "outgoing_payment_sent"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, matched: false });
    expect((await paymentRow(paymentId)).status).toBe("PROCESSING");
    expect((await ledgerOf("WEBHOOK_UNMATCHED")).map((r) => (r.payload as { transferId: string }).transferId)).toContain("999999999");
  });
});
