/*
 * (M5) Purchase-order test helpers: a payments passkey for a business owner, a DRAFT PO at the supplier's catalog
 * price, signing through the HTTP API, and the supplier portal's steps in the in-process mock world.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { SUPPLIER_PACKS } from "../../../../fixtures/seed-data.ts";
import { getDb } from "../../src/db/client.ts";
import { purchaseOrders, webauthnCredentialsPayments, webauthnCredentialsRules } from "../../src/db/schema.ts";
import { draftPurchaseOrder } from "../../src/modules/business/drafts.ts";
import { merchantBySlug } from "../../src/modules/business/queries.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { bearer } from "./app.ts";
import { signBaseRules } from "./fixtures.ts";
import { deliverWebhooks, type TestMockWorld } from "./mockWorld.ts";
import { SoftAuthenticator } from "./webauthn.ts";

export async function ownerPasskey(userId: string, homeCurrency: string): Promise<SoftAuthenticator> {
  const auth = new SoftAuthenticator();
  const row = { userId, credentialId: auth.id, publicKey: auth.publicKeyB64u(), counter: 0, transports: ["internal"] };
  await getDb().insert(webauthnCredentialsRules).values(row);
  await getDb().insert(webauthnCredentialsPayments).values(row);
  await signBaseRules(userId, auth, homeCurrency);
  return auth;
}

/** Draft `packs` of supplier boxes (BOX-33CM-100) at the catalog price. */
export async function draftBoxes(slug: "bud" | "sha", supplierPayeeId: string, packs: number): Promise<string> {
  const m = (await merchantBySlug(slug))!;
  const price = SUPPLIER_PACKS[slug === "bud" ? "a" : "c"].find((p) => p.supplierSku === "BOX-33CM-100")!.packPriceMinor;
  const r = await draftPurchaseOrder(m, { supplierPayeeId, currency: m.currency, lines: [{ supplierSku: "BOX-33CM-100", packs, packPriceMinor: price }], createdBy: "USER", now: clock.now() });
  if (!r.ok) throw new Error(`draft failed: ${r.error} ${r.message}`);
  return r.purchaseOrderId;
}

export async function signOptions(app: FastifyInstance, userId: string, poId: string) {
  const res = await app.inject({ method: "POST", url: `/api/business/purchase-orders/${poId}/sign/options`, headers: await bearer(userId), payload: {} });
  if (res.statusCode !== 200) throw new Error(`options ${res.statusCode}: ${res.body}`);
  return res.json() as { core: Record<string, unknown>; poHash: string; webauthnOptions: { challenge: string } };
}

export async function signPo(app: FastifyInstance, userId: string, auth: SoftAuthenticator, poId: string) {
  const o = await signOptions(app, userId, poId);
  return app.inject({ method: "POST", url: `/api/business/purchase-orders/${poId}/sign`, headers: await bearer(userId), payload: { core: o.core, assertion: auth.assert(o.poHash) } });
}

export const poRow = async (id: string) => (await getDb().select().from(purchaseOrders).where(eq(purchaseOrders.id, id)))[0]!;

/** A supplier portal action, then deliver the resulting signed webhooks to the API. */
export async function portal(mw: TestMockWorld, app: FastifyInstance, supplier: string, poId: string, action: "confirm" | "deliver" | "invoice", payload: object = {}) {
  const res = await mw.app.inject({ method: "POST", url: `/mock/supplier/${supplier}/purchase-orders/${poId}/${action}`, payload });
  if (res.statusCode !== 200) throw new Error(`portal ${action} ${res.statusCode}: ${res.body}`);
  return deliverWebhooks(mw, app);
}
