/*
 * Handoff rail (spec §11): Kassa does not move money; the merchant (supplier / dorm office in mock world)
 * issues a QR payment request {paymentId, payeeName, amountMinor, currency, qrPayload}. The API compares
 * payeeName with the verified payee: normalized fuzzy similarity ≥ 0.92 or QR_PAYEE_MISMATCH (the app then
 * shows a warning and no Pay button). Paying in the mock QR wallet sends an HMAC webhook → SENT.
 * (X7) The QR is requested and checked when the order is first shown (rules getOrderView → requestHandoffQr via
 * the port wired in orders/wiring.ts), before the passkey prompt; execution reuses that QR and re-checks it.
 */
import type { CanonicalOrder } from "@kassa/shared";
import { eq } from "drizzle-orm";

import { proposals, type ProposalDraftJson } from "../../db/schema.ts";

import { nameSimilarity } from "../screening/normalize.ts";
import { mockWorld } from "./http.ts";
import type { ExecCtx, Rail, RailResult } from "./types.ts";

export const HANDOFF_NAME_THRESHOLD = 0.92;

type QrPayment = {
  paymentId: string;
  payeeName: string;
  amountMinor: number;
  currency: string;
  qrPayload: string;
  payUrl?: string;
};

export function checkQrPayee(qrPayeeName: string, verifiedName: string) {
  const similarity = nameSimilarity(qrPayeeName, verifiedName, { stripLegal: true });
  return { similarity, match: similarity >= HANDOFF_NAME_THRESHOLD };
}

export type HandoffQr = Omit<NonNullable<ProposalDraftJson["handoffQr"]>, "checkedAt">;

function checked(qr: QrPayment, order: CanonicalOrder): HandoffQr {
  const { similarity, match } = checkQrPayee(qr.payeeName, order.payeeName);
  const ok = match && qr.amountMinor === order.amountMinor && qr.currency === order.currency;
  return {
    qrPaymentId: qr.paymentId,
    qrPayeeName: qr.payeeName,
    verifiedPayeeName: order.payeeName,
    nameSimilarity: Math.round(similarity * 10_000) / 10_000,
    check: ok ? "MATCH" : "QR_PAYEE_MISMATCH",
    qrPayload: qr.qrPayload,
    walletUrl: ok ? (qr.payUrl ?? null) : null,
    qrAmountMinor: qr.amountMinor,
    qrCurrency: qr.currency,
  };
}

/** (M2) Check a QR code the merchant issued itself (e.g. the pizza shop's code for one order) like any handoff QR. */
export function checkHandoffQr(qr: QrPayment, order: CanonicalOrder): HandoffQr {
  return checked(qr, order);
}

/** (X7) Ask the merchant for its QR payment request and check it against the signed payee name and amount. */
export async function requestHandoffQr(order: CanonicalOrder): Promise<HandoffQr> {
  const qr = await mockWorld<QrPayment>("POST", "/qr/payments", {
    payeeName: order.payeeName,
    amountMinor: order.amountMinor,
    currency: order.currency,
    reference: order.purpose.slice(0, 35),
  });
  return checked(qr, order);
}

export const handoffRail: Rail = {
  id: "HANDOFF",
  async execute(order: CanonicalOrder, ctx: ExecCtx): Promise<RailResult> {
    // X7: pay exactly the QR the user saw before signing (re-checked here); none stored → request one now.
    const stored = (await ctx.db.select({ draft: proposals.draft }).from(proposals).where(eq(proposals.id, order.proposalId)))[0]?.draft.handoffQr;
    let details: HandoffQr;
    if (stored) {
      const { checkedAt: _checkedAt, ...prior } = stored;
      details = checked(
        { paymentId: prior.qrPaymentId, payeeName: prior.qrPayeeName, amountMinor: prior.qrAmountMinor, currency: prior.qrCurrency, qrPayload: prior.qrPayload, ...(prior.walletUrl ? { payUrl: prior.walletUrl } : {}) },
        order,
      );
    } else {
      details = await requestHandoffQr(order);
    }
    if (details.check !== "MATCH") return { status: "CANCELED", railRef: details.qrPaymentId, details, reasonCodes: ["QR_PAYEE_MISMATCH"] };
    return { status: "PROCESSING", railRef: details.qrPaymentId, details };
  },
};
