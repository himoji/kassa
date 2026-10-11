/*
 * Webhooks (I13). Authenticated before any parsing is trusted:
 * - Stripe: `Stripe-Signature` via stripe.webhooks.constructEvent over the raw body.
 * - Mock world: X-Kassa-Timestamp + X-Kassa-Signature = hex(HMAC-SHA256(MOCK_HMAC_SECRET, `${ts}.${rawBody}`))
 *   (RFC 2104), 5-minute window against the demo Clock (@kassa/shared verifyMockWebhook).
 * Triggers never approve (I6): POS / remittance events only log and notify.
 * The raw body is kept by a content-type parser scoped to this plugin.
 */
import { MOCK_WEBHOOK_SIGNATURE_HEADER, MOCK_WEBHOOK_TIMESTAMP_HEADER, verifyMockWebhook } from "@kassa/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type Stripe from "stripe";

import { getDb } from "../../db/client.ts";
import { issuedCards, payments, profiles } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { HttpProblem } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { notify } from "../notifications/service.ts";
import { updatePaymentStatus } from "../payments/status.ts";
import { checkQrPayee } from "../rails/handoff.ts";
import { authorizeCardUse, fakeCharge, settleCard, stripe } from "../rails/issuing.ts";
import { mapWiseStatus } from "../rails/mockBank.ts";
import { onIntentSucceeded } from "../rails/payInPlace.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** Verify a mock-world webhook; throws 401 problem on failure. Exported for reuse by other webhook routes. */
export function assertMockWebhook(req: FastifyRequest): void {
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
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

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
    assertMockWebhook(req);
    const body = obj(req.body);
    const data = obj(body.data);
    const transferId = String(obj(data.resource).id ?? "");
    const state = String(data.current_state ?? "");
    const p = (await getDb().select().from(payments).where(and(eq(payments.railRef, transferId), eq(payments.rail, "BANK_TRANSFER"))))[0];
    if (!p) {
      await ledger.append("WEBHOOK_UNMATCHED", { kind: "bank", transferId, state });
      return { ok: true, matched: false };
    }
    const status = mapWiseStatus(state);
    await updatePaymentStatus(p.id, status, { source: "webhook:mock-bank", details: { bankState: state } });
    if (status === "SENT") {
      await notify(p.userId, { kind: "PAYMENT_SENT", title: "Payment sent", body: "Your bank transfer was sent (simulated bank).", data: { paymentId: p.id } });
    }
    return { ok: true, matched: true };
  });

  app.post("/webhooks/mock/qr", async (req) => {
    assertMockWebhook(req);
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
      await ledger.append("HANDOFF_PAID_MISMATCH", { userId: p.userId, paymentId: p.id, qrPayeeName: name, reasonCodes: ["QR_PAYEE_MISMATCH"] });
      await updatePaymentStatus(p.id, "FAILED", { source: "webhook:mock-qr", reasonCodes: ["QR_PAYEE_MISMATCH"] });
      return { ok: true, matched: true, reasonCodes: ["QR_PAYEE_MISMATCH"] };
    }
    await updatePaymentStatus(p.id, "SENT", { source: "webhook:mock-qr", merchantName: name });
    return { ok: true, matched: true };
  });

  app.post("/webhooks/mock/pos", async (req) => {
    assertMockWebhook(req);
    // I6: a stock trigger can only log (and later create a draft through the agent/scheduler), never approve.
    await ledger.append("TRIGGER_POS", { event: req.body });
    return { ok: true };
  });

  app.post("/webhooks/mock/remittance", async (req) => {
    assertMockWebhook(req);
    const body = obj(req.body);
    const profileId = Number(body.profileId);
    const owner = Number.isSafeInteger(profileId)
      ? (await getDb().select({ userId: profiles.userId }).from(profiles).where(eq(profiles.bankProfileId, profileId)))[0]
      : undefined;
    const userId = owner?.userId ?? null;
    await ledger.append("TRIGGER_REMITTANCE", { userId, event: body });
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
    assertMockWebhook(req);
    const b = obj(req.body);
    const cardId = String(b.cardId ?? "");
    const card = (await getDb().select().from(issuedCards).where(eq(issuedCards.stripeCardId, cardId)))[0];
    if (card && card.provider !== "fake") return { approved: false, reasonCode: "NO_APPROVAL" };
    const amount = Number(b.amountMinor);
    const d = await fakeCharge({
      cardId,
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
