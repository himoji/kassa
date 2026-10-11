import { randomUUID } from "node:crypto";

import type { Clock } from "../clock.ts";
import type { WebhookSink } from "../webhooks.ts";
import { QR_MERCHANTS, SWAPPED_QR_PAYEE } from "../world/data.ts";
import { buildEmvPayload } from "./emv.ts";

/*
 * QR wallet (simulated) for handoff mode (spec §11 Handoff, §17). A merchant (supplier, dorm
 * office, ...) issues a payment request; the API shows the QR and compares `payeeName` with the
 * verified payee (fuzzy >= 0.92, else QR_PAYEE_MISMATCH). The "swapped" variant is attack A5: the
 * code names a different payee than the merchant the user meant to pay.
 */

export type QrVariant = "normal" | "swapped";

export interface QrPayment {
  paymentId: string;
  merchantId: string | null;
  /** Payee name encoded in the QR (what the wallet will pay). */
  payeeName: string;
  /** Who the request was meant for (differs only in the swapped variant). */
  intendedPayeeName: string;
  amountMinor: number;
  currency: string;
  reference: string | null;
  variant: QrVariant;
  qrPayload: string;
  payUrl: string;
  status: "PENDING" | "PAID";
  createdAt: string;
  paidAt: string | null;
  simulated: true;
}

export interface CreateQrInput {
  merchantId?: string;
  payeeName?: string;
  amountMinor: number;
  currency: string;
  reference?: string | null;
  variant?: QrVariant;
}

export class QrError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class QrWallet {
  private readonly payments = new Map<string, QrPayment>();
  /** Demo switch for A5: when on, every new request is issued with the swapped payee. */
  swapAll = false;

  constructor(
    private readonly opts: { clock: Clock; webhooks: WebhookSink; publicUrl: string },
  ) {}

  reset(): void {
    this.payments.clear();
    this.swapAll = false;
  }

  async create(input: CreateQrInput): Promise<QrPayment> {
    // The API's handoff rail names the payee only: a known QR merchant still gets its own city / country
    // in the EMV payload (e.g. "Dorm Office in Shanghai" → Shanghai, CN), others default to Budapest, HU.
    const merchant = input.merchantId
      ? QR_MERCHANTS[input.merchantId]
      : Object.values(QR_MERCHANTS).find((m) => m.name === input.payeeName);
    if (input.merchantId && !merchant) throw new QrError(404, "UNKNOWN_MERCHANT", `Unknown merchant ${input.merchantId}`);
    const intended = merchant?.name ?? input.payeeName;
    if (!intended) throw new QrError(400, "BAD_REQUEST", "merchantId or payeeName is required");
    const variant: QrVariant = this.swapAll ? "swapped" : (input.variant ?? "normal");
    const payeeName = variant === "swapped" ? SWAPPED_QR_PAYEE.name : intended;
    const now = await this.opts.clock.now();
    const paymentId = randomUUID();
    const qrPayload = buildEmvPayload({
      paymentId,
      merchantName: payeeName,
      merchantCity: variant === "swapped" ? SWAPPED_QR_PAYEE.city : (merchant?.city ?? "Budapest"),
      countryCode: variant === "swapped" ? SWAPPED_QR_PAYEE.country : (merchant?.country ?? "HU"),
      mcc: merchant?.mcc ?? "5999",
      currency: input.currency,
      amountMinor: input.amountMinor,
      reference: input.reference ?? null,
    });
    const p: QrPayment = {
      paymentId,
      merchantId: input.merchantId ?? null,
      payeeName,
      intendedPayeeName: intended,
      amountMinor: input.amountMinor,
      currency: input.currency,
      reference: input.reference ?? null,
      variant,
      qrPayload,
      payUrl: `${this.opts.publicUrl}/mock/qr/${paymentId}`,
      status: "PENDING",
      createdAt: now.toISOString(),
      paidAt: null,
      simulated: true,
    };
    this.payments.set(paymentId, p);
    return p;
  }

  /** Newest first (Demo Stage wallet screen). */
  list(): QrPayment[] {
    // Map keeps insertion order: reverse first so codes created at the same demo instant stay newest first (stable sort).
    return [...this.payments.values()].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(paymentId: string): QrPayment | undefined {
    return this.payments.get(paymentId);
  }

  async pay(paymentId: string): Promise<QrPayment> {
    const now = await this.opts.clock.now();
    const p = this.payments.get(paymentId);
    if (!p) throw new QrError(404, "NOT_FOUND", "Unknown payment");
    if (p.status === "PAID") throw new QrError(409, "ALREADY_PAID", "This QR code was already paid");
    p.status = "PAID";
    p.paidAt = now.toISOString();
    this.opts.webhooks.send("qr", {
      eventId: randomUUID(),
      type: "qr.payment.completed",
      paymentId: p.paymentId,
      merchantId: p.merchantId,
      payeeName: p.payeeName,
      amountMinor: p.amountMinor,
      currency: p.currency,
      reference: p.reference,
      qrPayload: p.qrPayload,
      paidAt: p.paidAt,
      simulated: true,
    });
    return p;
  }
}
