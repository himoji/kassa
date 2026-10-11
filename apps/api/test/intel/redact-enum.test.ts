import { buildIban } from "@kassa/shared";
import { describe, expect, it } from "vitest";

import { Redactor, type KnownName } from "../../src/modules/agent/redact.ts";

const HU_IBAN = buildIban("HU", "117730161111101800000000");
const LANDLORD_ID = "8244c30e-61a5-5c07-b556-a9b7706bd087";
const SHOP_ID = "99999999-9999-4999-8999-999999999999";

// An organisation payee flagged personal: its single words (LANDLORD, Budapest, ...) must still not match.
const names: KnownName[] = [
  { name: "Landlord in Budapest", kind: "PAYEE", ref: LANDLORD_ID, payeeKind: "LANDLORD", personal: true },
  { name: "Verified Shop", kind: "PAYEE", ref: SHOP_ID, payeeKind: "MERCHANT" },
];

describe("payee names match as the whole name only (B3)", () => {
  it("payeeKind LANDLORD stays; the payee name becomes a placeholder", () => {
    const r = new Redactor({ names });
    const out = r.redactValue({ name: "Landlord in Budapest", payeeKind: "LANDLORD" });
    expect(out).toEqual({ name: "payee_1", payeeKind: "LANDLORD" });
    expect(r.resolve("payee_1")?.realRef).toBe(LANDLORD_ID);
  });

  it("free text: the full phrase is replaced", () => {
    const r = new Redactor({ names });
    expect(r.redactText("pay the Landlord in Budapest rent")).toBe("pay the payee_1 rent");
    // Case variants and extra whitespace of the whole name still match.
    expect(r.redactText("pay the LANDLORD  IN budapest rent")).toBe("pay the payee_1 rent");
  });

  it("a single word of an organisation payee name is not redacted", () => {
    const r = new Redactor({ names });
    expect(r.redactText("my landlord is nice")).toBe("my landlord is nice");
    expect(r.redactText("Budapest transit pass")).toBe("Budapest transit pass");
  });

  it("a natural-person payee's surname is redacted; an organisation's single word is not", () => {
    const people: KnownName[] = [{ name: "Anna Kovács", kind: "PAYEE", ref: "33333333-3333-4333-8333-333333333333", payeeKind: "PERSON", personal: true }];
    const r = new Redactor({ names: people });
    expect(r.redactText("Kovács agreed")).toBe("payee_1 agreed");
    const org = new Redactor({ names });
    expect(org.redactText("my landlord")).toBe("my landlord");
  });

  it("status VERIFIED next to a payee named 'Verified Shop' stays; the name is redacted", () => {
    const r = new Redactor({ names });
    const out = r.redactValue({ status: "VERIFIED", name: "Verified Shop" });
    expect(out).toEqual({ status: "VERIFIED", name: "payee_1" });
    expect(r.redactText("status VERIFIED")).toBe("status VERIFIED");
  });
});

describe("enum/code keys are passed through verbatim (B3 allowlist)", () => {
  it("does not redact values under allowlisted keys, including arrays and nested objects", () => {
    const r = new Redactor({ names });
    const value = {
      decision: "Landlord in Budapest",
      reasonCodes: ["Verified Shop", "RISK_HIGH"],
      rail: { code: "Landlord in Budapest" },
      items: [{ kind: "Verified Shop", note: "Verified Shop" }],
    };
    expect(r.redactValue(value)).toEqual({
      decision: "Landlord in Budapest",
      reasonCodes: ["Verified Shop", "RISK_HIGH"],
      rail: { code: "Landlord in Budapest" },
      items: [{ kind: "Verified Shop", note: "payee_1" }],
    });
  });

  it("IBAN, email and phone redaction are unchanged", () => {
    const r = new Redactor({ names });
    const out = r.redactValue({ kind: "BANK_TRANSFER", note: `pay ${HU_IBAN} mail dana@example.com call +36 30 123 4567` });
    expect(out).toEqual({ kind: "BANK_TRANSFER", note: "pay iban_1 mail email_1 call phone_1" });
    expect(r.resolve("iban_1")?.realRef).toBe(HU_IBAN);
  });
});
