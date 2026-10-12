import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CanonicalOrder, itemsHash, jcs, normalizePurchaseOrderCore, poHash, PurchaseOrderCore } from "../src/index.ts";

// Golden vector (2026-10-14, Business M0): change this object or the hash below only together with a `v` bump.
const CORE: PurchaseOrderCore = {
  v: 1,
  purchaseOrderId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  merchantId: "1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b",
  ownerUserId: "3f1b3c9e-5d2a-4e8f-9b7c-1a2b3c4d5e6f",
  region: "CN",
  supplierPayeeId: "0a0b0c0d-1111-4222-8333-444455556666",
  supplierName: "Supplier A",
  supplierAccountHash: "q1w2e3r4t5y6u7i8o9p0",
  currency: "CNY",
  lines: [
    { supplierSku: "BOX-33CM-100", inventorySku: "BOX-33CM", packSize: 100, packs: 5, packPriceMinor: 18000, lineTotalMinor: 90000 },
  ],
  totalMinor: 90000,
  deliverBy: "2026-10-15",
  forecastHash: null,
  createdAt: "2026-10-14T08:00:00.000Z",
};

const CORE_JCS =
  '{"createdAt":"2026-10-14T08:00:00.000Z","currency":"CNY","deliverBy":"2026-10-15","forecastHash":null,' +
  '"lines":[{"inventorySku":"BOX-33CM","lineTotalMinor":90000,"packPriceMinor":18000,"packSize":100,"packs":5,' +
  '"supplierSku":"BOX-33CM-100"}],"merchantId":"1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b",' +
  '"ownerUserId":"3f1b3c9e-5d2a-4e8f-9b7c-1a2b3c4d5e6f","purchaseOrderId":"7c9e6679-7425-40de-944b-e07fc1f90ae7",' +
  '"region":"CN","supplierAccountHash":"q1w2e3r4t5y6u7i8o9p0","supplierName":"Supplier A",' +
  '"supplierPayeeId":"0a0b0c0d-1111-4222-8333-444455556666","totalMinor":90000,"v":1}';

const PO_HASH = "xLC4g5VwGtayS-JW-ylDhSByGzHJ-zLaGA4GuMBX9oc";

describe("poHash", () => {
  it("canonicalises to the expected JCS text", () => {
    expect(jcs(CORE)).toBe(CORE_JCS);
  });

  it("matches the committed golden vector and node:crypto", () => {
    expect(poHash(CORE)).toBe(PO_HASH);
    expect(poHash(CORE)).toBe(createHash("sha256").update(jcs(CORE)).digest("base64url"));
  });

  it("strips unknown keys before hashing (only the schema-valid core is signed)", () => {
    expect(poHash({ ...CORE, note: "pay to another account" } as PurchaseOrderCore)).toBe(PO_HASH);
  });

  it("rejects a total that is not the sum of the lines, and a wrong line total", () => {
    expect(() => poHash({ ...CORE, totalMinor: 90001 })).toThrow();
    const bad = { ...CORE.lines[0]!, lineTotalMinor: 1 };
    expect(PurchaseOrderCore.safeParse({ ...CORE, lines: [bad], totalMinor: 1 }).success).toBe(false);
  });

  it("requires lines sorted by supplierSku; normalizePurchaseOrderCore sorts them", () => {
    const a = { supplierSku: "A-1", inventorySku: "A", packSize: 1, packs: 1, packPriceMinor: 10, lineTotalMinor: 10 };
    const z = { supplierSku: "Z-1", inventorySku: "Z", packSize: 1, packs: 1, packPriceMinor: 10, lineTotalMinor: 10 };
    const messy = { ...CORE, lines: [z, a], totalMinor: 20 };
    expect(() => poHash(messy)).toThrow();
    expect(normalizePurchaseOrderCore(messy).lines.map((l) => l.supplierSku)).toEqual(["A-1", "Z-1"]);
    expect(() => normalizePurchaseOrderCore({ ...CORE, lines: [a, a], totalMinor: 20 })).toThrow();
  });
});

describe("itemsHash", () => {
  const ITEMS_HASH = "ebvBQ6aZ3jOkW5yzr5ZWzR_JdS-5J7X-x186vY_DHwI";

  it("matches the committed golden vector; names are not signed; order-independent", () => {
    expect(itemsHash([{ sku: "PIZZA-MARGHERITA", qty: 2, unitPriceMinor: 350000 }])).toBe(ITEMS_HASH);
    expect(itemsHash([{ sku: "PIZZA-MARGHERITA", qty: 2, unitPriceMinor: 350000, name: "Margherita" }])).toBe(ITEMS_HASH);
    const x = { sku: "A", qty: 1, unitPriceMinor: 1 };
    const y = { sku: "B", qty: 1, unitPriceMinor: 1 };
    expect(itemsHash([x, y])).toBe(itemsHash([y, x]));
    expect(itemsHash([{ sku: "PIZZA-MARGHERITA", qty: 3, unitPriceMinor: 350000 }])).not.toBe(ITEMS_HASH);
  });

  it("CanonicalOrder accepts itemsHash and purchaseOrderId as optional fields", () => {
    const shape = CanonicalOrder.shape;
    expect(shape.itemsHash.safeParse(undefined).success).toBe(true);
    expect(shape.purchaseOrderId.safeParse(undefined).success).toBe(true);
    expect(shape.purchaseOrderId.safeParse("not-a-uuid").success).toBe(false);
  });
});
