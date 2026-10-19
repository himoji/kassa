/*
 * Webhooks (I13). Authenticated before any parsing is trusted:
 * - Stripe: `Stripe-Signature` via stripe.webhooks.constructEvent over the raw body.
 * - Mock world: X-Kassa-Timestamp + X-Kassa-Signature = hex(HMAC-SHA256(MOCK_HMAC_SECRET, `${ts}.${rawBody}`))
 *   (RFC 2104), 5-minute window against the demo Clock (@kassa/shared verifyMockWebhook), and single use inside
 *   the window (seen-signature store, webhooks/replay.ts → 409 WEBHOOK_REPLAYED).
 * - Mock bank status events are checked against what Kassa knows about the transfer (known Wise state, the
 *   owner's bank profile, no backwards move, nothing past `processing` before the transfer was funded);
 *   anything else is refused (409 WEBHOOK_REJECTED) and ledgered as WEBHOOK_REJECTED.
 * Triggers never approve (I6): POS / remittance events only log and notify.
 * The raw body is kept by a content-type parser scoped to this plugin.
 */
import { fromMinor, isSupportedCurrency, MOCK_WEBHOOK_SIGNATURE_HEADER, MOCK_WEBHOOK_TIMESTAMP_HEADER, verifyMockWebhook } from "@kassa/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type Stripe from "stripe";

import { getDb } from "../../db/client.ts";
import { issuedCards, payments, profiles, type PaymentDetailsJson } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { HttpProblem } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { onSupplierWebhook } from "../business/supplier.ts";
import { onShopWebhook } from "../commerce/service.ts";
import { onSchoolWebhook } from "../schools/service.ts";
import { ledger } from "../ledger/index.ts";
import { sealPii } from "../privacy/keys.ts";
import { notify } from "../notifications/service.ts";
import { updatePaymentStatus } from "../payments/status.ts";
import { checkQrPayee } from "../rails/handoff.ts";
import { authorizeCardUse, fakeCharge, settleCard, stripe } from "../rails/issuing.ts";
import { mapWiseStatus } from "../rails/mockBank.ts";
import { onIntentSucceeded } from "../rails/payInPlace.ts";
import { senderNameForProfile } from "../wallet/service.ts";
import { rememberWebhookSignature } from "./replay.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/**
 * Verify a mock-world webhook: HMAC, 5-minute window, then single use (I13). Throws a 401 problem for a bad or
 * stale signature and a 409 problem (ledgered) for a replay of an already accepted delivery.
 * Exported for reuse by other webhook routes.
 */
export async function assertMockWebhook(req: FastifyRequest, kind: string): Promise<void> {
  const ts = req.headers[MOCK_WEBHOOK_TIMESTAMP_HEADER];
  const sig = req.headers[MOCK_WEBHOOK_SIGNATURE_HEADER];
  const r = verifyMockWebhook(
    env().MOCK_HMAC_SECRET,
    typeof ts === "string" ? ts : undefined,
    typeof sig === "string" ? sig : undefined,
    req.rawBody ?? "",
    Math.floor(clock.nowMs() / 1000),
  );
  if (!r.ok) throw new HttpProblem(401, r.code, "Webhook authentication failed", { reasonCodes: [r.code] });
  // verifyMockWebhook only returns ok with both headers present as strings.
  if (!(await rememberWebhookSignature(kind, ts as string, sig as string))) {
    await ledger.append("WEBHOOK_REPLAY_REJECTED", { kind, timestamp: Number(ts), reasonCodes: ["WEBHOOK_REPLAYED"] });
    throw new HttpProblem(409, "WEBHOOK_REPLAYED", "This signed webhook was already processed", { reasonCodes: ["WEBHOOK_REPLAYED"] });
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

/** Wise transfer states in the order a funded transfer moves through them (mock-world TRANSFER_STATES). */
const BANK_FLOW = ["incoming_payment_waiting", "processing", "funds_converted", "outgoing_payment_sent"] as const;
/** Wise end states for a transfer that did not complete (mapWiseStatus → CANCELED / FAILED). */
const BANK_FAILURES = new Set(["cancelled", "funds_refunded", "bounced_back", "charged_back"]);
const FUNDED_RANK = BANK_FLOW.indexOf("processing");

export type BankEventRejection = "UNKNOWN_STATE" | "PROFILE_MISMATCH" | "PAYMENT_FINAL" | "STATUS_REGRESSION" | "NOT_FUNDED";

/**
 * Malicious or impossible mock-bank status events (RUNBOOK S9). The signed event is still only a claim: it
 * must name a known state, the bank profile of the payment's owner, and move the transfer forward; nothing
 * beyond `processing` is accepted before Kassa saw the transfer funded. Returns null when the event may apply.
 */
export function bankEventRejection(
  p: { status: string; details: PaymentDetailsJson },
  state: string,
  eventProfileId: unknown,
  ownerProfileId: number | null,
): BankEventRejection | null {
  const flowRank = (BANK_FLOW as readonly string[]).indexOf(state);
  if (flowRank < 0 && !BANK_FAILURES.has(state)) return "UNKNOWN_STATE";
  if (ownerProfileId === null || Number(eventProfileId) !== ownerProfileId) return "PROFILE_MISMATCH";
  const known = (BANK_FLOW as readonly string[]).indexOf(String(p.details.bankState ?? ""));
  if (p.status === "SENT" || p.status === "FAILED" || p.status === "CANCELED") {
    // A final payment only accepts a repeat of its own end state (the scheduler poll may have finalised it first).
    return mapWiseStatus(state) === p.status ? null : "PAYMENT_FINAL";
  }
  if (flowRank < 0) return null; // a failure state may end any open transfer
  // Last known bank state; payments without one (rail results before this field existed) are funded iff PROCESSING.
  const current = known >= 0 ? known : p.status === "PROCESSING" ? FUNDED_RANK : 0;
  if (flowRank < current) return "STATUS_REGRESSION";
  if (flowRank > FUNDED_RANK && current < FUNDED_RANK) return "NOT_FUNDED";
  return null;
}

const routes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, (body as string).length > 0 ? JSON.parse(body as string) : {});
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // ---------- mock world ----------

  app.post("/webhooks/mock/bank", async (req) => {
    await assertMockWebhook(req, "bank");
    const body = obj(req.body);
    const data = obj(body.data);
    const resource = obj(data.resource);
    const transferId = String(resource.id ?? "");
    const state = String(data.current_state ?? "");
    const p = (await getDb().select().from(payments).where(and(eq(payments.railRef, transferId), eq(payments.rail, "BANK_TRANSFER"))))[0];
    if (!p) {
      await ledger.append("WEBHOOK_UNMATCHED", { kind: "bank", transferId, state });
      return { ok: true, matched: false };
    }
    // An instant payout is SENT by the rail itself; the bank's webhooks for the states it passed on the way arrive
    // after that. A state at or before the one Kassa already recorded is a late echo: acknowledged, nothing moves.
    const stateRank = (BANK_FLOW as readonly string[]).indexOf(state);
    if (p.status === "SENT" && p.details.instantPayout === true && stateRank >= 0 && stateRank <= (BANK_FLOW as readonly string[]).indexOf(String(p.details.bankState ?? ""))) {
      return { ok: true, matched: true };
    }
    const owner = (await getDb().select({ bankProfileId: profiles.bankProfileId }).from(profiles).where(eq(profiles.userId, p.userId)))[0];
    const rejection = bankEventRejection(p, state, resource.profile_id, owner?.bankProfileId ?? null);
    if (rejection) {
      await ledger.append("WEBHOOK_REJECTED", { kind: "bank", userId: p.userId, paymentId: p.id, transferId, state, from: p.status, reason: rejection });
      throw new HttpProblem(409, "WEBHOOK_REJECTED", `Bank status event refused: ${rejection}`, { details: { reason: rejection } });
    }
    const status = mapWiseStatus(state);
    if (status === p.status && (status === "SENT" || status === "FAILED" || status === "CANCELED")) return { ok: true, matched: true };
    if (status === p.status) {
      // Same PaymentStatus, later bank state (processing → funds_converted): remember it, nothing else moves.
      await getDb().update(payments).set({ details: { ...p.details, bankState: state }, updatedAt: clock.now() }).where(eq(payments.id, p.id));
      return { ok: true, matched: true };
    }
    // X9: PAYMENT_SENT / PAYMENT_FAILED are sent by updatePaymentStatus (all rails, with payee and amounts).
    await updatePaymentStatus(p.id, status, { source: "webhook:mock-bank", details: { bankState: state } });
    return { ok: true, matched: true };
  });

  app.post("/webhooks/mock/qr", async (req) => {
    await assertMockWebhook(req, "qr");
    const body = obj(req.body);
    const qrPaymentId = String(body.paymentId ?? "");
    const p = (await getDb().select().from(payments).where(and(eq(payments.railRef, qrPaymentId), eq(payments.rail, "HANDOFF"))))[0];
    if (!p) {
      await ledger.append("WEBHOOK_UNMATCHED", { kind: "qr", qrPaymentId });
      return { ok: true, matched: false };
    }
    const d = p.details as Obj;
    const name = String(body.payeeName ?? "");
    const check = checkQrPayee(name, String(d.verifiedPayeeName ?? ""));
    if (!check.match || body.amountMinor !== p.amountMinor || body.currency !== p.currency || d.check !== "MATCH") {
      // The user paid someone else than the signed payee (e.g. a swapped QR): record, never mark SENT.
      await ledger.append("HANDOFF_PAID_MISMATCH", { userId: p.userId, paymentId: p.id, reasonCodes: ["QR_PAYEE_MISMATCH"], ...(await sealPii(p.userId, { qrPayeeName: name })) });
      await updatePaymentStatus(p.id, "FAILED", { source: "webhook:mock-qr", reasonCodes: ["QR_PAYEE_MISMATCH"] });
      return { ok: true, matched: true, reasonCodes: ["QR_PAYEE_MISMATCH"] };
    }
    await updatePaymentStatus(p.id, "SENT", { source: "webhook:mock-qr", merchantName: name });
    return { ok: true, matched: true };
  });

  app.post("/webhooks/mock/pos", async (req) => {
    await assertMockWebhook(req, "pos");
    // I6: a stock trigger can only log (and later create a draft through the agent/scheduler), never approve.
    await ledger.append("TRIGGER_POS", { event: req.body });
    return { ok: true };
  });

  // (M2/M3) The pizza shop's order book: order / till-bill status. Only mirrors the shop's status (I6).
  app.post("/webhooks/mock/shop", async (req) => {
    await assertMockWebhook(req, "shop");
    return onShopWebhook(req.body);
  });

  // (M5) Suppliers: purchase order confirmed / delivered / invoiced. Claims only; the invoice is three-way matched.
  app.post("/webhooks/mock/supplier", async (req) => {
    await assertMockWebhook(req, "supplier");
    return onSupplierWebhook(req.body);
  });

  // School portals: a payment booked against a tuition invoice. A claim only, recorded on the payment it names (I6).
  app.post("/webhooks/mock/school", async (req) => {
    await assertMockWebhook(req, "school");
    return onSchoolWebhook(req.body);
  });

  app.post("/webhooks/mock/remittance", async (req) => {
    await assertMockWebhook(req, "remittance");
    const body = obj(req.body);
    const profileId = Number(body.profileId);
    const owner = Number.isSafeInteger(profileId)
      ? (await getDb().select({ userId: profiles.userId }).from(profiles).where(eq(profiles.bankProfileId, profileId)))[0]
      : undefined;
    const userId = owner?.userId ?? null;
    if (body.type === "wallet.received") return onWalletReceived(userId, body);
    // The event names the sender (a third person): sealed with the recipient's key; unmatched events keep no names.
    await ledger.append(
      "TRIGGER_REMITTANCE",
      userId
        ? { userId, eventId: body.eventId ?? null, ...(await sealPii(userId, { event: body })) }
        : { userId: null, eventId: body.eventId ?? null, amountMinor: body.amountMinor ?? null, currency: body.currency ?? null },
    );
    if (userId) {
      await notify(userId, {
        kind: "MONEY_FROM_HOME",
        title: "Money from home",
        body: "Incoming transfer (simulated). Ask Kassa for the cheapest way to convert it.",
        data: body,
      }).catch(() => undefined);
    }
    return { ok: true };
  });

  /**
   * FakeIssuing authorization (coordination doc, Track D): the mock shop "charges" a one-time card.
   * HMAC-authenticated like mock webhooks. Same decision logic as Stripe issuing_authorization.request;
   * a second charge on a used card is declined (CARD_ALREADY_USED).
   */
  app.post("/rails/fake-issuing/authorize", async (req) => {
    await assertMockWebhook(req, "fake-issuing");
    const b = obj(req.body);
    const cardId = String(b.cardId ?? "");
    const card = (await getDb().select().from(issuedCards).where(eq(issuedCards.stripeCardId, cardId)))[0];
    if (card && card.provider !== "fake") return { approved: false, reasonCode: "NO_APPROVAL" };
    const amount = Number(b.amountMinor);
    const authorizationId = typeof b.authorizationId === "string" && b.authorizationId.length > 0 && b.authorizationId.length <= 64 ? b.authorizationId : undefined;
    const d = await fakeCharge({
      cardId,
      authorizationId,
      amountMinor: Number.isSafeInteger(amount) ? amount : -1,
      currency: String(b.currency ?? ""),
      merchantName: String(obj(b.merchant).name ?? b.merchantName ?? ""),
    });
    return d.approved ? { approved: true } : { approved: false, reasonCode: d.reasonCode ?? "NO_APPROVAL" };
  });

  // ---------- Stripe ----------

  app.post("/webhooks/stripe", async (req, reply) => {
    const e = env();
    if (!e.stripeEnabled || !e.STRIPE_WEBHOOK_SECRET) throw new HttpProblem(503, "STRIPE_DISABLED", "Stripe is not configured");
    const sig = req.headers["stripe-signature"];
    let event: Stripe.Event;
    try {
      event = stripe().webhooks.constructEvent(req.rawBody ?? "", typeof sig === "string" ? sig : "", e.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      throw new HttpProblem(400, "WEBHOOK_SIGNATURE_INVALID", (err as Error).message, { reasonCodes: ["WEBHOOK_SIGNATURE_INVALID"] });
    }
    switch (event.type) {
      case "issuing_authorization.request": {
        // Real-time authorization: answer in the response body (Stripe "respond directly"), < 1 s, no LLM.
        // Compare in the MERCHANT's currency (EU cards are EUR; a HUF charge arrives converted).
        const auth = event.data.object;
        const pending = auth.pending_request;
        const d = await authorizeCardUse({
          cardId: auth.card.id,
          authorizationId: auth.id,
          amountMinor: pending?.merchant_amount ?? auth.merchant_amount,
          currency: (pending?.merchant_currency ?? auth.merchant_currency).toUpperCase(),
          merchantName: auth.merchant_data.name ?? "",
        });
        return reply.header("Stripe-Version", event.api_version ?? "").status(200).send({ approved: d.approved });
      }
      case "issuing_transaction.created": {
        const tx = event.data.object;
        const cardId = typeof tx.card === "string" ? tx.card : tx.card.id;
        await settleCard(cardId, tx.merchant_data.name ?? "");
        break;
      }
      case "payment_intent.succeeded":
        await onIntentSucceeded(event.data.object.id);
        break;
      default:
        break;
    }
    return { received: true };
  });
};

export default routes;

/**
 * Kassa → Kassa: money from another user's wallet arrived in this user's wallet (mock bank, wallet.received). Like any
 * trigger it only logs and notifies (I6); the sender's name is sealed with the recipient's key.
 */
async function onWalletReceived(userId: string | null, body: Record<string, unknown>) {
  const sourceProfile = Number(body.sourceProfileId);
  const sender = Number.isSafeInteger(sourceProfile) ? await senderNameForProfile(sourceProfile) : null;
  const amountMinor = Number(body.amountMinor);
  const currency = String(body.currency ?? "");
  if (!userId) {
    await ledger.append("WALLET_RECEIVED", { userId: null, eventId: body.eventId ?? null, amountMinor, currency });
    return { ok: true };
  }
  await ledger.append("WALLET_RECEIVED", { userId, eventId: body.eventId ?? null, amountMinor, currency, transferId: body.transferId ?? null, ...(await sealPii(userId, { sender, reference: body.reference ?? null })) });
  const amount = Number.isSafeInteger(amountMinor) && isSupportedCurrency(currency) ? `${fromMinor(amountMinor, currency)} ${currency}` : "Money";
  await notify(userId, {
    kind: "MONEY_RECEIVED",
    title: sender ? `${sender} sent you ${amount}` : `You received ${amount}`,
    body: "From another Kassa wallet (sandbox, no real money). It is in your wallet now.",
    data: { amountMinor, currency, sender, reference: body.reference ?? null },
  }).catch(() => undefined);
  return { ok: true };
}
