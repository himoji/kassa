/*
 * Handoff rail (spec §11): Kassa does not move money; the merchant (supplier / dorm office in mock world)
 * issues a QR payment request {paymentId, payeeName, amountMinor, currency, qrPayload}. The API compares
 * payeeName with the verified payee: normalized fuzzy similarity ≥ 0.92 or QR_PAYEE_MISMATCH (the app then
 * shows a warning and no Pay button). Paying in the mock QR wallet sends an HMAC webhook → SENT.
 */
import type { CanonicalOrder } from "@kassa/shared";

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

export const handoffRail: Rail = {
  id: "HANDOFF",
  async execute(order: CanonicalOrder, ctx: ExecCtx): Promise<RailResult> {
    const qr = await mockWorld<QrPayment>("POST", "/qr/payments", {
      payeeName: ctx.payee.name,
      amountMinor: order.amountMinor,
      currency: order.currency,
      reference: order.purpose.slice(0, 35),
    });
    const { similarity, match } = checkQrPayee(qr.payeeName, order.payeeName);
    const amountOk = qr.amountMinor === order.amountMinor && qr.currency === order.currency;
    const ok = match && amountOk;
    const details = {
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
    if (!ok) return { status: "CANCELED", railRef: qr.paymentId, details, reasonCodes: ["QR_PAYEE_MISMATCH"] };
    return { status: "PROCESSING", railRef: qr.paymentId, details };
  },
};
