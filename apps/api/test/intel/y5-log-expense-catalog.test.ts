/*
 * Y5: (p1 B6) log_expense goes through the same categoriser as capture, and a plain item word ("coffee") lands in
 * the category capture uses for that kind of merchant (eating_out), not "other"; (p1 B8) search_catalog accepts the
 * payee placeholder the planner sees (payee_N) as the merchant.
 */
import { describe, expect, it } from "vitest";

import { IDS, payees as seedPayees } from "../../../../fixtures/seed-data.ts";
import type { PayeeRow } from "../../src/modules/agent/ports.ts";
import { Redactor } from "../../src/modules/agent/redact.ts";
import { buildTools, quickExpense, type ToolContext } from "../../src/modules/agent/tools.ts";
import { categorize, lookupMerchant } from "../../src/modules/capture/categorize.ts";
import { normalizeMerchant } from "../../src/modules/capture/normalize.ts";

import { fakePorts } from "./fakes.ts";

describe("log_expense categorisation (Y5, p1 B6)", () => {
  it("'coffee 1200 HUF' parses to merchant 'coffee' and categorises like the coffee shop capture (eating_out)", async () => {
    const q = quickExpense("coffee 1200 HUF")!;
    expect(q.merchant).toBe("coffee");
    const viaText = await categorize({ merchantNorm: normalizeMerchant(q.merchant), merchantRaw: q.merchant });
    const viaCapture = await categorize({ merchantNorm: normalizeMerchant("COFFEE SHOP IN BUDAPEST"), merchantRaw: "COFFEE SHOP IN BUDAPEST" });
    expect(viaCapture.category).toBe("eating_out");
    expect(viaText.category).toBe(viaCapture.category);
  });

  it.each([
    ["lunch", "eating_out"],
    ["metro ticket", "transport"],
    ["taxi", "transport"],
    ["groceries", "groceries"],
    ["textbook", "books"],
    ["pharmacy", "health"],
    ["cinema", "entertainment"],
  ])("keyword '%s' → %s", async (text, category) => {
    expect((await categorize({ merchantNorm: normalizeMerchant(text), merchantRaw: text })).category).toBe(category);
  });

  it("dictionary merchants keep their category; unknown words stay 'other'", async () => {
    expect(lookupMerchant("pizza shop in")?.category).toBe("eating_out");
    expect((await categorize({ merchantNorm: "zxqv", merchantRaw: "zxqv" })).category).toBe("other");
  });

  it("the log_expense tool sends the parsed fields to the capture pipeline", async () => {
    const { ports, log } = fakePorts();
    const ctx: ToolContext = { ports, redactor: new Redactor(), emit: () => undefined, readDocs: new Map(), stop: { requested: false, reason: null }, proposals: [] };
    const tools = buildTools(ctx);
    await (tools.log_expense as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({ text: "coffee 1200 HUF" }, { toolCallId: "t", messages: [] });
    expect(log.logExpense).toEqual([{ source: "TEXT", fields: { merchant: "coffee", amountMinor: 120000, currency: "HUF" } }]);
  });
});

describe("search_catalog with a payee placeholder (Y5, p1 B8)", () => {
  const seeded: PayeeRow[] = seedPayees
    .filter((p) => p.userId === IDS.user)
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind, status: p.status, verifiedAt: p.verifiedAt, coolingUntil: p.coolingUntil, accountHash: `hash:${p.account}`, replacesPayeeId: p.replacesPayeeId }));

  function setup() {
    const { ports } = fakePorts();
    ports.payees = async () => seeded;
    const asked: string[] = [];
    ports.catalog = async (merchant) => {
      asked.push(merchant);
      if (merchant === "pizza") return { merchant: "pizza", merchantName: "Pizza Shop in Budapest", currency: "HUF", items: [{ sku: "margherita", name: "Margherita", unitPriceMinor: 290000, currency: "HUF" }] };
      return { error: "CATALOG_NOT_FOUND", merchant };
    };
    ports.catalogDirectory = async () => [
      { id: "pizza", name: "Pizza Shop in Budapest" },
      { id: "supplier-a", name: "Pizza Supplier from EU" },
    ];
    const redactor = new Redactor();
    const ctx: ToolContext = { ports, redactor, emit: () => undefined, readDocs: new Map(), stop: { requested: false, reason: null }, proposals: [] };
    const tools = buildTools(ctx);
    const search = async (merchant: string) =>
      (await (tools.search_catalog as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute({ merchant, query: "*" }, { toolCallId: "t", messages: [] })) as Record<string, unknown>;
    return { redactor, search, asked };
  }

  it("the pizza shop's placeholder finds the pizza menu and returns the same placeholder", async () => {
    const { redactor, search, asked } = setup();
    const ref = redactor.placeholderFor("PAYEE", IDS.payees.pizzaShop);
    const res = await search(ref);
    expect(asked).toEqual(["pizza"]);
    expect(res.payeeRef).toBe(ref);
    expect(res.payeeStatus).toBe("VERIFIED");
    expect((res.items as unknown[]).length).toBe(1);
  });

  it("an unknown placeholder → UNKNOWN_PAYEE_REF; a payee without a catalog → CATALOG_NOT_FOUND", async () => {
    const { redactor, search } = setup();
    expect((await search("payee_99")).error).toBe("UNKNOWN_PAYEE_REF");
    const landlord = redactor.placeholderFor("PAYEE", IDS.payees.landlord);
    expect((await search(landlord)).error).toBe("CATALOG_NOT_FOUND");
  });

  it("plain merchant ids still work", async () => {
    const { search, asked } = setup();
    await search("pizza");
    expect(asked).toEqual(["pizza"]);
  });
});
