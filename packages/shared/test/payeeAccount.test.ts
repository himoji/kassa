import { describe, expect, it } from "vitest";

import {
  abaRoutingOk,
  decodePayeeAccount,
  encodePayeeAccount,
  luhnOk,
  maskPayeeAccount,
  normalizePayeeAccount,
  payoutSchemesFor,
  validatePayeeAccount,
} from "../src/payeeAccount.ts";

// Public test numbers: a German example IBAN, Stripe's UnionPay test card, JPMorgan Chase's ABA routing number.
const IBAN = "DE89370400440532013000";
const UNIONPAY = "6200000000000005";
const ROUTING = "021000021";

describe("payee account schemes", () => {
  it("round-trips every scheme through one canonical string", () => {
    const cases = [
      { scheme: "IBAN", iban: "de89 3704 0044 0532 0130 00" },
      { scheme: "CN_ALIPAY", alipayId: "Li.Wei@Example.CN" },
      { scheme: "CN_ALIPAY", alipayId: "+86 138 0013 8000" },
      { scheme: "CN_UNIONPAY", cardNumber: "6200 0000 0000 0005" },
      { scheme: "US_ACH", routingNumber: ROUTING, accountNumber: "123456789", accountType: "SAVINGS" },
    ] as const;
    const encoded = cases.map((c) => encodePayeeAccount(c));
    expect(encoded).toEqual([IBAN, "ALIPAY:li.wei@example.cn", "ALIPAY:+8613800138000", `UNIONPAY:${UNIONPAY}`, `ACH:${ROUTING}:123456789:SAVINGS`]);
    for (const e of encoded) expect(encodePayeeAccount(decodePayeeAccount(e))).toBe(e);
  });

  it("keeps merchant ids and other identifiers as OTHER, normalized as before", () => {
    expect(decodePayeeAccount("pizza shop in shanghai").scheme).toBe("OTHER");
    expect(normalizePayeeAccount("pizza shop in shanghai")).toBe("PIZZASHOPINSHANGHAI");
    expect(normalizePayeeAccount("hu42 1177 3016 1111 1018 0000 0000")).toBe("HU42117730161111101800000000");
  });

  it("checks each scheme's own check digits", () => {
    expect(luhnOk(UNIONPAY)).toBe(true);
    expect(luhnOk("6200000000000006")).toBe(false);
    expect(abaRoutingOk(ROUTING)).toBe(true);
    expect(abaRoutingOk("021000022")).toBe(false);
    expect(validatePayeeAccount({ scheme: "IBAN", iban: "DE89370400440532013001" })).toEqual({ field: "iban", code: "IBAN_INVALID" });
    expect(validatePayeeAccount({ scheme: "CN_ALIPAY", alipayId: "12345" })).toEqual({ field: "alipayId", code: "ALIPAY_ID_INVALID" });
    expect(validatePayeeAccount({ scheme: "CN_UNIONPAY", cardNumber: "4242424242424242" })).toEqual({ field: "cardNumber", code: "UNIONPAY_CARD_INVALID" });
    expect(validatePayeeAccount({ scheme: "US_ACH", routingNumber: ROUTING, accountNumber: "12", accountType: "CHECKING" })).toEqual({ field: "accountNumber", code: "ACH_ACCOUNT_INVALID" });
    expect(validatePayeeAccount({ scheme: "CN_UNIONPAY", cardNumber: UNIONPAY }, "CNY")).toBeNull();
  });

  it("refuses a currency the scheme cannot pay out in", () => {
    expect(validatePayeeAccount({ scheme: "CN_ALIPAY", alipayId: "li@example.cn" }, "EUR")?.code).toBe("SCHEME_CURRENCY_MISMATCH");
    expect(validatePayeeAccount({ scheme: "US_ACH", routingNumber: ROUTING, accountNumber: "1234", accountType: "CHECKING" }, "EUR")?.code).toBe("SCHEME_CURRENCY_MISMATCH");
    expect(validatePayeeAccount({ scheme: "IBAN", iban: IBAN }, "CNY")?.code).toBe("SCHEME_CURRENCY_MISMATCH");
    expect(validatePayeeAccount({ scheme: "IBAN", iban: IBAN }, "EUR")).toBeNull();
  });

  it("offers the schemes that fit the country and currency", () => {
    expect(payoutSchemesFor("CN", "CNY")).toEqual(["CN_ALIPAY", "CN_UNIONPAY", "OTHER"]);
    expect(payoutSchemesFor("US", "USD")).toEqual(["US_ACH", "OTHER"]);
    expect(payoutSchemesFor("DE", "EUR")).toEqual(["IBAN", "OTHER"]);
  });

  it("masks with the scheme and the last characters only", () => {
    expect(maskPayeeAccount(IBAN)).toBe("DE •••• 3000");
    expect(maskPayeeAccount("ALIPAY:li.wei@example.cn")).toBe("Alipay l•••@example.cn");
    expect(maskPayeeAccount("ALIPAY:+8613800138000")).toBe("Alipay •••• 8000");
    expect(maskPayeeAccount(`UNIONPAY:${UNIONPAY}`)).toBe("UnionPay •••• 0005");
    expect(maskPayeeAccount(`ACH:${ROUTING}:123456789:CHECKING`)).toBe("ACH •••• 6789");
  });
});
