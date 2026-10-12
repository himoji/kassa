/*
 * (added 2026-10-15, Business M5) Signing a purchase order with the owner's PAYMENTS passkey.
 *   POST /business/purchase-orders/:id/sign/options → {core, poHash, webauthnOptions}; challenge = poHash(core)
 *   POST /business/purchase-orders/:id/sign {core, assertion}
 * The server rebuilds the core from the stored DRAFT (the client's copy must be identical), verifies the assertion
 * against webauthn_credentials_payments (live: counter advances, so a replayed assertion fails), and stores core,
 * poHash and assertion; payments later re-verifies that stored assertion before paying the invoice (payments/index.ts).
 * Then the PO is sent to the supplier (business/supplier.ts). Not reachable from agent/** (imports payments).
 */
import { jcs, jcsHash, normalizePurchaseOrderCore, poHash, type PurchaseOrderCore } from "@kassa/shared";
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { payees, purchaseOrders } from "../../db/schema.ts";
import { conflict, HttpProblem, notFound } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { verifyPaymentsAssertion } from "../payments/credentials.ts";
import { assertionOptions } from "../rules/webauthn.ts";
import { addDays, localDay } from "./forecast.ts";
import type { MerchantRow } from "./queries.ts";
import { sendToSupplier } from "./supplier.ts";

type PoRow = typeof purchaseOrders.$inferSelect;

async function ownPo(merchant: MerchantRow, id: string): Promise<PoRow> {
  const po = (await getDb().select().from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.merchantId, merchant.id))))[0];
  if (!po) throw notFound("Purchase order");
  return po;
}

/** The exact core the owner signs for a DRAFT purchase order (deterministic from the stored row and supplier). */
export async function buildCore(merchant: MerchantRow, po: PoRow): Promise<PurchaseOrderCore> {
  if (po.status !== "DRAFT") throw conflict("PO_NOT_DRAFT", `This purchase order is ${po.status}`);
  const supplier = (await getDb().select().from(payees).where(and(eq(payees.id, po.supplierPayeeId), eq(payees.userId, merchant.ownerUserId))))[0];
  if (!supplier || supplier.status !== "VERIFIED" || !supplier.accountHash) {
    throw new HttpProblem(409, "SUPPLIER_NOT_VERIFIED", "Only a purchase order to a verified supplier can be signed", { reasonCodes: ["REFUSE_UNVERIFIED_PAYEE"] });
  }
  if (po.totalMinor > merchant.poCapMinor) throw new HttpProblem(409, "PO_ABOVE_CAP", "The total is above this shop's purchase-order cap");
  const snap = po.forecastSnapshot as { deliverBy?: unknown; tomorrow?: unknown } | null;
  const deliverBy =
    typeof snap?.deliverBy === "string" ? snap.deliverBy : typeof snap?.tomorrow === "string" ? snap.tomorrow : addDays(localDay(po.createdAt, merchant.timezone), 1);
  try {
    return normalizePurchaseOrderCore({
      v: 1,
      purchaseOrderId: po.id,
      merchantId: merchant.id,
      ownerUserId: merchant.ownerUserId,
      region: merchant.region,
      supplierPayeeId: supplier.id,
      supplierName: supplier.name,
      supplierAccountHash: supplier.accountHash,
      currency: po.currency,
      lines: po.lines,
      totalMinor: po.totalMinor,
      deliverBy,
      forecastHash: po.forecastSnapshot ? jcsHash(po.forecastSnapshot) : null,
      createdAt: po.createdAt.toISOString(),
    });
  } catch (err) {
    throw new HttpProblem(422, "INVALID_PURCHASE_ORDER", (err as Error).message);
  }
}

export async function signOptions(merchant: MerchantRow, id: string) {
  const core = await buildCore(merchant, await ownPo(merchant, id));
  const hash = poHash(core);
  return { core, poHash: hash, webauthnOptions: await assertionOptions(getDb(), merchant.ownerUserId, hash) };
}

export async function signPurchaseOrder(merchant: MerchantRow, id: string, submitted: PurchaseOrderCore, assertion: unknown) {
  const db = getDb();
  const po = await ownPo(merchant, id);
  const core = await buildCore(merchant, po);
  // The owner signs what the server will store: a changed draft (or a core for another PO) is refused.
  let same = false;
  try {
    same = jcs(normalizePurchaseOrderCore(submitted)) === jcs(core);
  } catch {
    same = false;
  }
  if (!same) throw conflict("PO_CHANGED", "The purchase order changed; review it again");
  const hash = poHash(core);
  const check = await verifyPaymentsAssertion(db, { userId: merchant.ownerUserId, assertion, expectedChallenge: hash, mode: "live", challengeReason: "ASSERTION_INVALID" });
  if (!check.ok) {
    await ledger.append("PO_SIGN_REFUSED", { userId: merchant.ownerUserId, merchantId: merchant.id, purchaseOrderId: po.id, reasonCodes: [check.reason], detail: check.detail });
    throw new HttpProblem(403, "PASSKEY_REQUIRED", check.detail, { reasonCodes: ["PASSKEY_REQUIRED", check.reason] });
  }
  const now = clock.now();
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(purchaseOrders)
      .set({
        status: "SIGNED",
        core,
        poHash: hash,
        ownerAssertion: assertion as never,
        signedAt: now,
        timeline: sql`${purchaseOrders.timeline} || ${JSON.stringify([{ status: "SIGNED", at: now.toISOString() }])}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.status, "DRAFT")))
      .returning({ id: purchaseOrders.id });
    if (rows.length === 0) throw conflict("PO_NOT_DRAFT", "This purchase order was already signed");
    await ledger.append("PO_SIGNED", { userId: merchant.ownerUserId, merchantId: merchant.id, purchaseOrderId: po.id, poHash: hash, totalMinor: core.totalMinor, currency: core.currency, supplierPayeeId: core.supplierPayeeId }, tx);
  });
  const sent = await sendToSupplier(po.id);
  return { id: po.id, status: sent ? ("SENT" as const) : ("SIGNED" as const), poHash: hash };
}

/** Retry sending a SIGNED purchase order whose first delivery to the supplier failed. */
export async function resendPurchaseOrder(merchant: MerchantRow, id: string) {
  const po = await ownPo(merchant, id);
  if (po.status !== "SIGNED") throw conflict("PO_NOT_SIGNED", `This purchase order is ${po.status}`);
  const sent = await sendToSupplier(po.id);
  return { id: po.id, status: sent ? ("SENT" as const) : ("SIGNED" as const), poHash: po.poHash };
}
