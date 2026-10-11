import { describe, expect, it } from "vitest";

import { ManualClock } from "../src/clock.ts";
import { crc16ccitt, parseEmvPayload } from "../src/qr/emv.ts";
import { QrError, QrWallet } from "../src/qr/qr.ts";
import { publicView } from "../src/routes/qr.ts";
import { RecordingSink } from "../src/webhooks.ts";
import { QR_MERCHANTS, SWAPPED_QR_PAYEE } from "../src/world/data.ts";

const PUBLIC_URL = "http://mock.test";

function makeWallet() {
  const clock = new ManualClock(Date.parse("2026-10-27T09:00:00Z"));
  const sink = new RecordingSink();
  const wallet = new QrWallet({ clock, webhooks: sink, publicUrl: PUBLIC_URL });
  return { wallet, sink };
}

const DORM = QR_MERCHANTS["dorm-office"]!;

describe("CRC-16/CCITT-FALSE", () => {
  it("matches the standard check value for 123456789", () => {
    expect(crc16ccitt("123456789")).toBe("29B1");
  });
});

describe("QR payment, normal variant", () => {
  it("encodes the merchant, amount and currency in a valid EMV payload", async () => {
    const { wallet } = makeWallet();
    const p = await wallet.create({ merchantId: "dorm-office", amountMinor: 150_000, currency: "CNY", reference: "ROOM-12" });

    expect(p.payeeName).toBe(DORM.name);
    expect(p.intendedPayeeName).toBe(DORM.name);
    expect(p.variant).toBe("normal");

    const { fields, crcValid } = parseEmvPayload(p.qrPayload);
    expect(crcValid).toBe(true);
    // EMV names are limited to 25 characters.
    expect(fields["59"]).toBe(p.payeeName.slice(0, 25));
    expect(fields["53"]).toBe("156");
    expect(fields["54"]).toBe("1500.00");
    expect(fields["58"]).toBe("CN");
    expect(p.payUrl).toBe(`${PUBLIC_URL}/mock/qr/${p.paymentId}`);
  });

  it("detects a single changed character with a CRC failure", async () => {
    const { wallet } = makeWallet();
    const p = await wallet.create({ merchantId: "dorm-office", amountMinor: 150_000, currency: "CNY" });
    // Character 10 is the value of the point-of-initiation field ("12"); changing it breaks the CRC.
    const original = p.qrPayload[10]!;
    const replacement = original === "2" ? "3" : "2";
    const tampered = p.qrPayload.slice(0, 10) + replacement + p.qrPayload.slice(11);
    expect(tampered).not.toBe(p.qrPayload);
    expect(parseEmvPayload(tampered).crcValid).toBe(false);
  });
});

describe("QR payment, swapped variant (A5)", () => {
  it("names the swapped payee in the QR and keeps the intended payee for the record", async () => {
    const { wallet } = makeWallet();
    const p = await wallet.create({ merchantId: "dorm-office", amountMinor: 150_000, currency: "CNY", variant: "swapped" });

    expect(p.payeeName).toBe(SWAPPED_QR_PAYEE.name);
    expect(p.intendedPayeeName).toBe(DORM.name);

    const { fields, crcValid } = parseEmvPayload(p.qrPayload);
    expect(fields["59"]).toBe(SWAPPED_QR_PAYEE.name);
    expect(crcValid).toBe(true);
  });

  it("makes every request swapped when swapAll is on, even without a variant", async () => {
    const { wallet } = makeWallet();
    wallet.swapAll = true;
    const p = await wallet.create({ merchantId: "dorm-office", amountMinor: 150_000, currency: "CNY" });
    expect(p.variant).toBe("swapped");
    expect(p.payeeName).toBe(SWAPPED_QR_PAYEE.name);
  });

  it("does not leak the variant or intended payee to the API view", async () => {
    const { wallet } = makeWallet();
    const p = await wallet.create({ merchantId: "dorm-office", amountMinor: 150_000, currency: "CNY", variant: "swapped" });
    const view = publicView(p) as Record<string, unknown>;
    expect(Object.keys(view)).not.toContain("variant");
    expect(Object.keys(view)).not.toContain("intendedPayeeName");
    expect(view.payeeName).toBe(SWAPPED_QR_PAYEE.name);
  });
});

describe("paying a QR code", () => {
  it("marks the payment PAID and emits one qr webhook without the internal variant fields", async () => {
    const { wallet, sink } = makeWallet();
    wallet.swapAll = true;
    const p = await wallet.create({ merchantId: "dorm-office", amountMinor: 150_000, currency: "CNY" });

    const paid = await wallet.pay(p.paymentId);
    expect(paid.status).toBe("PAID");
    expect(paid.paidAt).not.toBeNull();

    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]!.kind).toBe("qr");
    const body = sink.sent[0]!.body as Record<string, unknown>;
    expect(body.payeeName).toBe(SWAPPED_QR_PAYEE.name);
    expect(Object.keys(body)).not.toContain("variant");
    expect(Object.keys(body)).not.toContain("intendedPayeeName");
  });

  it("rejects paying the same code twice with 409", async () => {
    const { wallet } = makeWallet();
    const p = await wallet.create({ merchantId: "dorm-office", amountMinor: 150_000, currency: "CNY" });
    await wallet.pay(p.paymentId);
    await expect(wallet.pay(p.paymentId)).rejects.toBeInstanceOf(QrError);
    await expect(wallet.pay(p.paymentId)).rejects.toMatchObject({ status: 409 });
  });
});
