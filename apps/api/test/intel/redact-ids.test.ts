import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { detect, luhnValid, Redactor, type KnownName } from "../../src/modules/agent/redact.ts";

/*
 * Y1 (p3 B3, B4): the redactor must never match inside UUIDs / identifiers, and payee placeholders are keyed by
 * payee id (two payees with the same name get distinct placeholders).
 */

/** A random RFC 9562 UUID whose hex letters are replaced by digits (worst case for the PAN detector). */
function digitUuid(): string {
  return randomUUID().replace(/[a-f]/g, () => String(Math.floor(Math.random() * 10)));
}

describe("redactor vs identifiers (Y1, p3 B3)", () => {
  it("the p3 B3 UUID is left intact", () => {
    const id = "588fc665-2092-4241-93b7-0c5e8a1d2f34";
    expect(new Redactor().redactText(`proposal ${id} created`)).toBe(`proposal ${id} created`);
  });

  it("5,000 random UUIDs (mixed hex and digit-only) never produce a hit", () => {
    const r = new Redactor({ names: [{ name: "Cafe", kind: "PAYEE", ref: "p-cafe" }, { name: "Dead Beef", kind: "PAYEE", ref: "p-db" }] });
    for (let i = 0; i < 5000; i++) {
      const id = i % 2 === 0 ? randomUUID() : digitUuid();
      for (const s of [id, id.toUpperCase(), `ref:${id}`, `"proposalId":"${id}"`, `${id}, ${digitUuid()}`]) {
        expect(detect(s), s).toEqual([]);
        expect(r.redactText(s)).toBe(s);
      }
    }
  });

  it("the deep redactor leaves id fields alone", () => {
    const value = { proposalId: digitUuid(), paymentId: randomUUID(), nested: [{ id: digitUuid() }] };
    expect(new Redactor().redactValue(value)).toEqual(value);
  });

  it("card numbers still need token boundaries and a Luhn-valid 13–19 digit sequence", () => {
    const pan = "4111111111111111";
    expect(luhnValid(pan)).toBe(true);
    expect(detect(`card ${pan}`).map((h) => h.kind)).toEqual(["CARD"]);
    expect(detect(`card 4111-1111-1111-1111 exp 12/27`).map((h) => h.kind)).toEqual(["CARD"]);
    expect(detect(`card ${pan}, 1200 HUF`).map((h) => h.kind)).toEqual(["CARD"]);
    // Glued to letters / identifiers: not a card.
    expect(detect(`ord${pan}`)).toEqual([]);
    expect(detect(`${pan}x`)).toEqual([]);
    expect(detect(`ab-${pan.slice(0, 4)}-${pan.slice(4, 8)}-${pan.slice(8, 12)}-${pan.slice(12)}-cd`)).toEqual([]);
    // Too short / too long / Luhn-invalid.
    expect(detect("411111111111")).toEqual([]);
    expect(detect("41111111111111111111")).toEqual([]);
    expect(detect("4111111111111112")).toEqual([]);
  });
});

describe("payee placeholders keyed by payee id (Y1, p3 B4)", () => {
  const OLD = "11111111-1111-4111-8111-111111111111";
  const NEW = "22222222-2222-4222-8222-222222222222";
  const names: KnownName[] = [
    { name: "Landlord in Budapest", kind: "PAYEE", ref: OLD, payeeKind: "LANDLORD" },
    { name: "Landlord in Budapest", kind: "PAYEE", ref: NEW, payeeKind: "LANDLORD" },
  ];

  it("two payees with the same name get distinct placeholders", () => {
    const r = new Redactor({ names });
    const a = r.placeholderFor("PAYEE", OLD);
    const b = r.placeholderFor("PAYEE", NEW);
    expect(a).not.toBe(b);
    expect(r.resolve(a)?.realRef).toBe(OLD);
    expect(r.resolve(b)?.realRef).toBe(NEW);
  });

  it("text about a specific payee is redacted to that payee's placeholder", () => {
    const r = new Redactor({ names });
    const a = r.placeholderFor("PAYEE", OLD);
    const b = r.placeholderFor("PAYEE", NEW);
    const summary = "Refused: Landlord in Budapest is still cooling.";
    expect(r.redactValue({ summary }, { payeeId: NEW })).toEqual({ summary: `Refused: ${b} is still cooling.` });
    expect(r.redactValue({ summary }, { payeeId: OLD })).toEqual({ summary: `Refused: ${a} is still cooling.` });
  });

  it("without context an ambiguous name maps to one of the payees, deterministically", () => {
    const r1 = new Redactor({ names });
    const r2 = new Redactor({ names });
    expect(r1.redactText("pay Landlord in Budapest")).toBe(r2.redactText("pay Landlord in Budapest"));
  });
});

describe("tool outputs about a same-name replacement payee (Y1, p3 B4)", () => {
  it("propose_order's refusal for the replacement payee names the replacement's placeholder", async () => {
    const { buildTools } = await import("../../src/modules/agent/tools.ts");
    const { knownNames } = await import("../../src/modules/agent/loop.ts");
    const { fakePorts, LANDLORD, NEW_LANDLORD } = await import("./fakes.ts");
    const { ports } = fakePorts({ decision: "REFUSE", reasonCodes: ["REFUSE_UNVERIFIED_PAYEE"] });
    ports.proposeOrder = async () => ({ proposalId: "66666666-6666-4666-8666-666666666666", decision: "REFUSE", reasonCodes: ["REFUSE_UNVERIFIED_PAYEE"], riskScore: 1, summary: "Refused: Kovács Péter is still cooling." });
    const redactor = new Redactor({ names: await knownNames(ports) });
    const oldRef = redactor.placeholderFor("PAYEE", LANDLORD);
    const newRef = redactor.placeholderFor("PAYEE", NEW_LANDLORD);
    expect(newRef).not.toBe(oldRef);
    const tools = buildTools({ ports, redactor, emit: () => undefined, readDocs: new Map(), stop: { requested: false, reason: null }, proposals: [] });
    const exec = (tools.propose_order as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute;
    const res = await exec({ payeeRef: newRef, amountMinor: 18000000, currency: "HUF", purpose: "Rent" }, { toolCallId: "t", messages: [] });
    expect(res.summary).toBe(`Refused: ${newRef} is still cooling.`);
    // Without context (free chat text), the verified payee wins.
    expect(redactor.redactText("pay Kovács Péter")).toBe(`pay ${oldRef}`);
  });
});
