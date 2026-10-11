import { describe, expect, it } from "vitest";

import { IDS, payees as seedPayees } from "../../../../fixtures/seed-data.ts";
import type { PayeeRow } from "../../src/modules/agent/ports.ts";
import { Redactor } from "../../src/modules/agent/redact.ts";
import { buildTools, type ToolContext } from "../../src/modules/agent/tools.ts";

import { fakePorts } from "./fakes.ts";

// Seeded user's payees (Dana), as the DB port would return them.
const seeded: PayeeRow[] = seedPayees
  .filter((p) => p.userId === IDS.user)
  .map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    status: p.status,
    verifiedAt: p.verifiedAt,
    coolingUntil: p.coolingUntil,
    accountHash: `hash:${p.account}`,
    replacesPayeeId: p.replacesPayeeId,
  }));

function setup() {
  const { ports } = fakePorts();
  ports.payees = async () => seeded;
  ports.catalog = async (merchant) => {
    if (merchant === "pizza") {
      return {
        merchant: "pizza",
        merchantName: "Pizza Shop in Budapest",
        currency: "HUF",
        items: [{ sku: "margherita", name: "Margherita", unitPriceMinor: 290000, currency: "HUF" }],
      };
    }
    if (merchant === "supplier-z") {
      return { merchant, merchantName: "Stationery Depot Ltd", currency: "EUR", items: [{ sku: "a4-500", name: "A4 paper", unitPriceMinor: 1250, currency: "EUR" }] };
    }
    return { error: "CATALOG_NOT_FOUND", merchant };
  };
  const redactor = new Redactor();
  const ctx: ToolContext = { ports, redactor, emit: () => undefined, readDocs: new Map(), stop: { requested: false, reason: null }, proposals: [] };
  const tools = buildTools(ctx);
  const search = async (merchant: string) =>
    (await (tools.search_catalog as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(
      { merchant, query: "*" },
      { toolCallId: "t1", messages: [] },
    )) as Record<string, unknown>;
  return { redactor, search };
}

describe("search_catalog payeeRef / payeeStatus (B5)", () => {
  it("the pizza shop result carries a payeeRef that resolves to the seeded pizza shop payee", async () => {
    const { redactor, search } = setup();
    const res = await search("pizza");
    expect(res.payeeStatus).toBe("VERIFIED");
    expect(typeof res.payeeRef).toBe("string");
    expect(res.payeeRef).toMatch(/^payee_\d+$/);
    expect(redactor.resolve(res.payeeRef as string)?.realRef).toBe(IDS.payees.pizzaShop);
    // Items are still returned.
    expect(res.items).toEqual([expect.objectContaining({ name: "Margherita", unitPriceMinor: 290000 })]);
  });

  it("an unknown supplier (no payee row for this user) → payeeRef null, payeeStatus UNKNOWN", async () => {
    const { search } = setup();
    const res = await search("supplier-z");
    expect(res.payeeRef).toBeNull();
    expect(res.payeeStatus).toBe("UNKNOWN");
    expect(res.items).toHaveLength(1);
  });

  it("a merchant with no catalog → payeeRef null, payeeStatus UNKNOWN, error kept", async () => {
    const { search } = setup();
    const res = await search("nope");
    expect(res).toEqual(expect.objectContaining({ error: "CATALOG_NOT_FOUND", payeeRef: null, payeeStatus: "UNKNOWN" }));
  });
});
