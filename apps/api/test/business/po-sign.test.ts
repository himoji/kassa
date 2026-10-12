/*
 * Business M5: signing a purchase order with the payments passkey (challenge = poHash). A wrong challenge, a
 * replayed assertion, another PO's assertion and a changed core are refused; another merchant's PO is 404; an
 * unsigned PO sent to the supplier is 401. The business agent tool only drafts: no proposal, approval or payment.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_IDS, SEED_NOW } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { approvals, ledgerEntries, payments, proposals, purchaseOrders } from "../../src/db/schema.ts";
import { buildTools } from "../../src/modules/agent/tools.ts";
import { dbPorts } from "../../src/modules/agent/ports.ts";
import { Redactor } from "../../src/modules/agent/redact.ts";
import { knownNames } from "../../src/modules/agent/loop.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { loadSeedData, seedDatabase } from "../../src/modules/demo/seed.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { draftBoxes, ownerPasskey, poRow, signOptions } from "../helpers/business.ts";
import { useTestDb } from "../helpers/db.ts";
import { offlineEnvironment } from "../helpers/fixtures.ts";
import { startMockWorld, stubCatalogFetch, type TestMockWorld } from "../helpers/mockWorld.ts";

const t = useTestDb();
const app = useTestApp();
let mw: TestMockWorld;
const SHA = BUSINESS_IDS.sha;

beforeEach(async () => {
  await t.reset();
  clock.freezeForTests(new Date(SEED_NOW));
  offlineEnvironment();
  mw = await startMockWorld({ env: { DEMO_ENABLED: "true" } });
  await seedDatabase(getDb(), await loadSeedData(), { reset: true, personas: true });
});
afterEach(async () => {
  clock.freezeForTests(null);
  await mw.close();
});

const post = async (userId: string, url: string, payload: object) => app().inject({ method: "POST", url, headers: await bearer(userId), payload });

describe("M5 purchase-order signing", () => {
  it("options → sign → SIGNED + PO_SIGNED → sent to the supplier (SENT)", async () => {
    const auth = await ownerPasskey(SHA.user, "CNY");
    const poId = await draftBoxes("sha", SHA.payees.supplierC, 4);
    const o = await signOptions(app(), SHA.user, poId);
    expect(o.webauthnOptions.challenge).toBe(o.poHash);
    expect(o.core).toMatchObject({ purchaseOrderId: poId, supplierName: "Restaurant Supplier from China", totalMinor: 72_000, currency: "CNY", region: "CN" });
    const res = await post(SHA.user, `/api/business/purchase-orders/${poId}/sign`, { core: o.core, assertion: auth.assert(o.poHash) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "SENT", poHash: o.poHash });
    const po = await poRow(poId);
    expect(po).toMatchObject({ status: "SENT", poHash: o.poHash });
    expect(po.timeline.map((x) => x.status)).toEqual(["DRAFT", "SIGNED", "SENT"]);
    expect((await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "PO_SIGNED"))).length).toBe(1);
    expect(mw.suppliers.get(poId)).toMatchObject({ supplierId: "c", totalMinor: 72_000, status: "RECEIVED" });
    const detail = await app().inject({ method: "GET", url: `/api/business/purchase-orders/${poId}`, headers: await bearer(SHA.user) });
    expect(detail.json()).toMatchObject({ id: poId, status: "SENT", poHash: o.poHash });
  });

  it("a wrong challenge is refused (403) and nothing is stored", async () => {
    const auth = await ownerPasskey(SHA.user, "CNY");
    const poId = await draftBoxes("sha", SHA.payees.supplierC, 4);
    const o = await signOptions(app(), SHA.user, poId);
    const res = await post(SHA.user, `/api/business/purchase-orders/${poId}/sign`, { core: o.core, assertion: auth.assert("not-the-po-hash") });
    expect(res.statusCode).toBe(403);
    expect(await poRow(poId)).toMatchObject({ status: "DRAFT", poHash: null, ownerAssertion: null });
    expect(mw.suppliers.get(poId)).toBeUndefined();
  });

  it("a replayed assertion and another PO's assertion are refused; a changed core is 409", async () => {
    const auth = await ownerPasskey(SHA.user, "CNY");
    const poId = await draftBoxes("sha", SHA.payees.supplierC, 4);
    const o = await signOptions(app(), SHA.user, poId);
    const assertion = auth.assert(o.poHash);
    expect((await post(SHA.user, `/api/business/purchase-orders/${poId}/sign`, { core: o.core, assertion })).statusCode).toBe(200);
    expect((await post(SHA.user, `/api/business/purchase-orders/${poId}/sign`, { core: o.core, assertion })).statusCode).toBe(409);

    await getDb().update(purchaseOrders).set({ status: "CANCELED" }).where(eq(purchaseOrders.id, poId));
    const other = await draftBoxes("sha", SHA.payees.supplierC, 5);
    const o2 = await signOptions(app(), SHA.user, other);
    expect((await post(SHA.user, `/api/business/purchase-orders/${other}/sign`, { core: o2.core, assertion: auth.assert(o.poHash) })).statusCode).toBe(403);
    const changed = { ...o2.core, totalMinor: 1, lines: [{ ...(o2.core.lines as object[])[0], packs: 1, lineTotalMinor: 1, packPriceMinor: 1 }] };
    expect((await post(SHA.user, `/api/business/purchase-orders/${other}/sign`, { core: changed, assertion: auth.assert(o2.poHash) })).statusCode).toBe(409);
    expect((await poRow(other)).status).toBe("DRAFT");
  });

  it("another merchant's PO is 404; an unsigned PO to the supplier is 401", async () => {
    const poId = await draftBoxes("sha", SHA.payees.supplierC, 4);
    expect((await post(BUSINESS_IDS.bud.user, `/api/business/purchase-orders/${poId}/sign/options`, {})).statusCode).toBe(404);
    const forged = await mw.app.inject({ method: "POST", url: "/mock/supplier/purchase-orders", payload: { purchaseOrderId: poId, poHash: null, supplierName: "Restaurant Supplier from China", merchant: { slug: "sha", name: "x" }, currency: "CNY", lines: [{ supplierSku: "BOX-33CM-100", packs: 4, packSize: 100, packPriceMinor: 18000, lineTotalMinor: 72000 }], totalMinor: 72000, deliverBy: "2026-10-28" } });
    expect(forged.statusCode).toBe(401);
  });

  it("invariant: the business agent tools draft a PO but never create a proposal, approval or payment", async () => {
    stubCatalogFetch(mw);
    const ports = dbPorts(SHA.user, randomUUID());
    const redactor = new Redactor({ names: await knownNames(ports), existing: [] });
    const ctx = { ports, redactor, emit: () => undefined, readDocs: new Map(), stop: { requested: false, reason: null }, proposals: [], business: true };
    const tools = buildTools(ctx) as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
    const opts = { toolCallId: "t", messages: [] };
    const f = (await tools.forecast_stock!.execute({}, opts)) as { shortages: { sku: string; suggestion: { supplierRef: string; supplierSku: string; packs: number } }[] };
    expect(f.shortages.map((s) => s.sku)).toEqual(["BOX-33CM"]);
    const s = f.shortages[0]!.suggestion;
    const r = (await tools.propose_purchase_order!.execute({ supplierRef: s.supplierRef, lines: [{ supplierSku: s.supplierSku, packs: s.packs }] }, opts)) as { status: string; totalMinor: number; reasonCodes: string[] };
    expect(r).toMatchObject({ status: "DRAFT", totalMinor: 72_000, reasonCodes: [] });
    const again = (await tools.propose_purchase_order!.execute({ supplierRef: s.supplierRef, lines: [{ supplierSku: s.supplierSku, packs: 5 }] }, opts)) as { error: string };
    expect(again.error).toBe("PO_ALREADY_OPEN");
    await getDb().update(purchaseOrders).set({ status: "CANCELED" });
    const flagged = (await tools.propose_purchase_order!.execute({ supplierRef: s.supplierRef, lines: [{ supplierSku: s.supplierSku, packs: 9 }] }, opts)) as { reasonCodes: string[] };
    expect(flagged.reasonCodes).toEqual(["PO_ABOVE_FORECAST"]);
    await getDb().update(purchaseOrders).set({ status: "CANCELED" });
    const capped = (await tools.propose_purchase_order!.execute({ supplierRef: s.supplierRef, lines: [{ supplierSku: s.supplierSku, packs: 100 }] }, opts)) as { error: string };
    expect(capped.error).toBe("PO_ABOVE_CAP");
    expect(await getDb().select().from(proposals)).toHaveLength(0);
    expect(await getDb().select().from(approvals)).toHaveLength(0);
    expect(await getDb().select().from(payments)).toHaveLength(0);
  });
});
