import { buildIban } from "@kassa/shared";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { redactPrompt } from "../../src/modules/agent/middleware.ts";
import { detect, luhnValid, Redactor, type KnownName } from "../../src/modules/agent/redact.ts";

const HU_IBAN = buildIban("HU", "117730161111101800000000");
const KZ_IBAN = buildIban("KZ", "1234567890123456");
const printed = (iban: string) => iban.replace(/(.{4})(?=.)/g, "$1 ");
// Visa test PAN (Luhn-valid) and a Luhn-invalid neighbour.
const PAN = "4111111111111111";

const names: KnownName[] = [
  { name: "Dana Nurlanovna", kind: "PERSON", ref: "Dana Nurlanovna", personal: true },
  { name: "Budapest University of Technology", kind: "PAYEE", ref: "11111111-1111-4111-8111-111111111111" },
  { name: "Kovács Péter", kind: "PAYEE", ref: "22222222-2222-4222-8222-222222222222", personal: true },
];

describe("detectors (I11)", () => {
  it("finds IBANs in electronic and printed form, ISO 13616 length-checked", () => {
    for (const s of [HU_IBAN, printed(HU_IBAN), KZ_IBAN]) {
      const hits = detect(`pay to ${s} today`);
      expect(hits.map((h) => h.kind)).toEqual(["IBAN"]);
      expect(hits[0]!.value).toBe(s.replace(/ /g, ""));
    }
  });

  it("does not swallow the word after a printed IBAN", () => {
    const text = `IBAN ${printed(HU_IBAN)} DUE 31.10.2026`;
    const r = new Redactor().redactText(text);
    expect(r).toBe("IBAN iban_1 DUE 31.10.2026");
  });

  it("card PANs need a valid Luhn check (ISO/IEC 7812)", () => {
    expect(luhnValid(PAN)).toBe(true);
    expect(detect(`card 4111 1111 1111 1111`).map((h) => h.kind)).toEqual(["CARD"]);
    expect(detect(`order 4111111111111112`)).toEqual([]);
  });

  it("emails and E.164 phones", () => {
    expect(detect("write to dana.n+bills@example.edu.hu").map((h) => h.kind)).toEqual(["EMAIL"]);
    expect(detect("call +36 30 123 4567 now").map((h) => h.kind)).toEqual(["PHONE"]);
    expect(detect("call +7 (701) 234-56-78").map((h) => h.kind)).toEqual(["PHONE"]);
    // Amounts and dates are not phone numbers.
    expect(detect("HUF 180,000 due 2026-11-01")).toEqual([]);
  });

  it("names from profile and payees, case-insensitive, whole words; first names of people too", () => {
    const kinds = detect("dana nurlanovna pays Budapest University of Technology; Dana and Kovács agreed", names).map((h) => h.kind);
    expect(kinds).toEqual(["PERSON", "PAYEE", "PERSON", "PAYEE"]);
    expect(detect("Danaher Corp", names)).toEqual([]);
  });
});

describe("Redactor", () => {
  it("stable placeholders per value; same value → same placeholder", () => {
    const r = new Redactor({ names });
    const a = r.redactText(`Send to ${HU_IBAN}, then again to ${printed(HU_IBAN)}; card ${PAN}; mail x@y.com; Dana says hi`);
    expect(a).toBe("Send to iban_1, then again to iban_1; card card_1111; mail email_1; person_1 says hi");
    expect(r.redactText("Budapest University of Technology")).toBe("payee_1");
    expect(r.resolve("payee_1")).toEqual({ placeholder: "payee_1", kind: "PAYEE", realRef: names[1]!.ref });
    expect(r.resolve("iban_1")?.realRef).toBe(HU_IBAN);
  });

  it("continues numbering from persisted entries and only drains new ones", () => {
    const r1 = new Redactor({ names });
    r1.redactText(`${HU_IBAN} and ${KZ_IBAN}`);
    const saved = r1.drainNew();
    expect(saved.map((e) => e.placeholder)).toEqual(["iban_1", "iban_2"]);
    const r2 = new Redactor({ names, existing: saved });
    expect(r2.redactText(`${KZ_IBAN} x@y.com`)).toBe("iban_2 email_1");
    expect(r2.drainNew().map((e) => e.placeholder)).toEqual(["email_1"]);
  });

  it("card placeholders use last 4 and disambiguate collisions", () => {
    const r = new Redactor();
    const other = "5500000000081111"; // Luhn-valid, same last 4
    expect(luhnValid(other)).toBe(true);
    expect(r.redactText(`${PAN} ${other}`)).toBe("card_1111 card_1111_2");
  });

  it("redacts deep values (tool outputs) and is idempotent", () => {
    const r = new Redactor({ names });
    const out = r.redactValue({ list: [{ note: `pay ${HU_IBAN}`, amountMinor: 240000 }], who: "Kovács Péter" });
    expect(out).toEqual({ list: [{ note: "pay iban_1", amountMinor: 240000 }], who: "payee_1" });
    expect(r.redactValue(out)).toEqual(out);
  });

  it("rehydrates for the user: names restored, accounts masked", () => {
    const r = new Redactor({ names });
    const t = r.redactText(`Dana pays Budapest University of Technology from ${HU_IBAN}`);
    const names2 = new Map([[names[1]!.ref, "Budapest University of Technology"]]);
    expect(r.rehydrateForUser(t, names2)).toBe(`Dana Nurlanovna pays Budapest University of Technology from HU…${HU_IBAN.slice(-4)}`);
  });
});

describe("redaction middleware: nothing un-redacted reaches the model", () => {
  it("redacts user text and every tool result in the prompt", () => {
    const r = new Redactor({ names });
    const prompt: LanguageModelV4Prompt = [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: `I am Dana, IBAN ${HU_IBAN}` }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "x", input: {} }] },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "1", toolName: "x", output: { type: "json", value: { email: "dana@example.com", n: 3 } } },
          { type: "tool-result", toolCallId: "2", toolName: "y", output: { type: "text", value: `card ${PAN}` } },
        ],
      },
    ];
    const json = JSON.stringify(redactPrompt(prompt, r));
    for (const secret of ["Dana", HU_IBAN, "dana@example.com", PAN]) expect(json).not.toContain(secret);
    expect(json).toContain("iban_1");
    expect(json).toContain("card_1111");
  });
});
