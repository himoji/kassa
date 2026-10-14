import { describe, expect, it } from "@jest/globals";

import {
  checkPayeeForm,
  EMPTY_PAYEE_FIELDS,
  schemesAndChoice,
  usualCurrency,
} from "@/lib/payee-form";

describe("add-payee form", () => {
  it("picks the usual currency for a country Kassa can pay", () => {
    expect(usualCurrency("DE")).toBe("EUR");
    expect(usualCurrency("CN")).toBe("CNY");
    expect(usualCurrency("US")).toBe("USD");
    expect(usualCurrency("BR")).toBeNull();
  });

  it("offers Alipay first in China and keeps a still-valid choice", () => {
    expect(schemesAndChoice("CN", "CNY", "IBAN")).toEqual({
      schemes: ["CN_ALIPAY", "CN_UNIONPAY", "KASSA_USER", "OTHER"],
      scheme: "CN_ALIPAY",
    });
    expect(schemesAndChoice("CN", "CNY", "CN_UNIONPAY").scheme).toBe("CN_UNIONPAY");
    expect(schemesAndChoice("US", "USD", "CN_ALIPAY").scheme).toBe("US_ACH");
  });

  it("encodes valid fields and names the wrong field otherwise", () => {
    expect(
      checkPayeeForm({ ...EMPTY_PAYEE_FIELDS, iban: "de89 3704 0044 0532 0130 00" }, "EUR")
    ).toEqual({ ok: true, account: "DE89370400440532013000" });
    expect(
      checkPayeeForm(
        { ...EMPTY_PAYEE_FIELDS, scheme: "CN_ALIPAY", alipayId: "138 0013 8000" },
        "CNY"
      )
    ).toEqual({ ok: true, account: "ALIPAY:+8613800138000" });
    expect(
      checkPayeeForm(
        { ...EMPTY_PAYEE_FIELDS, scheme: "US_ACH", routingNumber: "021000021", accountNumber: "1" },
        "USD"
      )
    ).toEqual({ ok: false, problem: { field: "accountNumber", code: "ACH_ACCOUNT_INVALID" } });
    expect(
      checkPayeeForm(
        { ...EMPTY_PAYEE_FIELDS, scheme: "KASSA_USER", kassaId: "ksa 7qmx 2hva" },
        "HUF"
      )
    ).toEqual({ ok: true, account: "KASSA:KSA-7QMX-2HVA" });
  });
});
