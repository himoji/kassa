/*
 * Payment taps beyond the iPhone Transaction trigger: Android wallet notifications (Google Wallet, Samsung Wallet),
 * Alipay / WeChat Pay notices and bank SMS, forwarded to POST /capture/shortcut as `{ app, title, text }` with the same
 * device token. Capture only logs (I6).
 */
import { describe, expect, it, beforeEach } from "vitest";

import { parseWalletNotification } from "../../src/modules/capture/parsers/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

describe("parseWalletNotification", () => {
  it("Google Wallet: merchant in the title, amount and card in the text", () => {
    const ev = parseWalletNotification({ app: "com.google.android.apps.walletnfcrel", title: "Cafe Frei", text: "€4.50 with Visa ••1234" });
    expect(ev).toMatchObject({ format: "GOOGLE_WALLET", kind: "PURCHASE", merchantRaw: "Cafe Frei", amountMinor: 450, currency: "EUR", cardHint: "1234" });
  });

  it("older Google Pay wording and a locale with the symbol after the number", () => {
    const ev = parseWalletNotification({ title: "Google Pay", text: "Paid 1 290 Ft at Spar Budapest with Mastercard •••• 9876" });
    expect(ev).toMatchObject({ format: "GOOGLE_WALLET", merchantRaw: "Spar Budapest", amountMinor: 129_000, currency: "HUF", cardHint: "9876" });
  });

  it("Samsung Wallet: merchant after 'at', app name as the title", () => {
    const ev = parseWalletNotification({ app: "com.samsung.android.spay", title: "Samsung Wallet", text: "Payment of ₸2 500 at Magnum completed" });
    expect(ev).toMatchObject({ format: "SAMSUNG_WALLET", merchantRaw: "Magnum", amountMinor: 250_000, currency: "KZT" });
  });

  it("a refund is not spending; an unknown currency or another app is not a wallet tap", () => {
    expect(parseWalletNotification({ app: "com.samsung.android.spay", text: "Refund of $4.50 from Starbucks" })?.kind).toBe("REFUND");
    expect(parseWalletNotification({ app: "com.google.android.apps.walletnfcrel", title: "Pret", text: "£4.50 with Visa ••1234" })).toBeNull();
    expect(parseWalletNotification({ app: "com.eg.android.AlipayGphone", text: "你在 便利店 消费 ¥32.50" })).toBeNull();
  });
});

describe("POST /capture/shortcut with a forwarded notification", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  async function token(): Promise<string> {
    const { userId } = await createUserWithPasskey();
    const res = await app().inject({ method: "POST", url: "/api/devices/shortcut", headers: await bearer(userId) });
    return (res.json() as { token: string }).token;
  }

  const post = (tok: string, payload: Record<string, unknown>) =>
    app().inject({ method: "POST", url: "/api/capture/shortcut", headers: { authorization: `Bearer ${tok}` }, payload });

  it("logs a Google Wallet tap and an Alipay notice; the iOS shape still works", async () => {
    const tok = await token();
    const google = await post(tok, { app: "com.google.android.apps.walletnfcrel", title: "Cafe Frei", text: "€4.50 with Visa ••1234" });
    expect(google.statusCode, google.body).toBe(200);
    expect(google.json()).toMatchObject({ status: "LOGGED", parsedBy: "PARSER:GOOGLE_WALLET", amountMinor: 450, currency: "EUR" });
    expect(google.json().nudge).toBeTruthy();

    const alipay = await post(tok, { app: "com.eg.android.AlipayGphone", title: "交易提醒", text: "你在 便利店(示例) 消费 ¥32.50" });
    expect(alipay.json()).toMatchObject({ status: "LOGGED", parsedBy: "PARSER:ALIPAY", amountMinor: 3250, currency: "CNY" });

    const ios = await post(tok, { merchant: "Bakery", amount: "€3.20" });
    expect(ios.json()).toMatchObject({ status: "LOGGED", parsedBy: "PARSER:IOS_SHORTCUT", amountMinor: 320 });
  });

  it("text nobody can read stays unparsed (no AI consent → no Reader)", async () => {
    const res = await post(await token(), { app: "com.example.chat", text: "see you at 5" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("UNPARSED");
  });
});
