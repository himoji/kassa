/*
 * (added 2026-10-14, Business M3) Counter-till bills: the customer scans the till's QR code (Kassa app /pay/<billId>)
 * and Kassa proposes paying exactly the bill the MERCHANT's system reports: amount, currency, items and merchant are
 * fetched from the till server side, never taken from the client. The payee is the user's own payee row for that
 * merchant (exact name; a merchant the user never added is refused, no payee is created here). The order then goes
 * through rules like any other (fulfillment TILL, itemsHash signed) and is paid by the M2 hook (fulfill.ts).
 */
import { FulfillmentItem, type MerchantBillProposeResponse, type MerchantBillView } from "@kassa/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { payees, proposals } from "../../db/schema.ts";
import { HttpProblem } from "../../http/problem.ts";
import { mockWorld, MockWorldError } from "../rails/http.ts";
import { proposeOrder } from "../rules/index.ts";
import { reportTillDecline } from "./fulfill.ts";

/** Till bill ids carry their store: "<storeId>-<hex>" (mock-world ShopOrderBook.createBill). */
export const BILL_ID = /^([a-z][a-z0-9]{1,31})-([0-9a-f]{16,64})$/;

const TillBill = z.object({
  bill: z.object({
    billId: z.string(),
    storeId: z.string(),
    items: z.array(z.object({ sku: z.string(), name: z.string(), qty: z.number().int().positive(), unitPriceMinor: z.number().int().nonnegative() })).min(1),
    totalMinor: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: z.string(),
  }),
  merchant: z.object({ storeId: z.string(), name: z.string().min(1) }),
});

/** The bill as the merchant's till reports it. 404 when the till does not know it. */
export async function fetchBill(billId: string): Promise<MerchantBillView> {
  const m = BILL_ID.exec(billId);
  if (!m) throw new HttpProblem(404, "NOT_FOUND", "bill not found");
  let raw: unknown;
  try {
    raw = await mockWorld("GET", `/shop/${m[1]}/bills/${encodeURIComponent(billId)}`);
  } catch (err) {
    if (err instanceof MockWorldError && err.status === 404) throw new HttpProblem(404, "NOT_FOUND", "bill not found");
    throw new HttpProblem(502, "RAIL_ERROR", "The merchant's till could not be reached", { reasonCodes: ["RAIL_ERROR"] });
  }
  const r = TillBill.safeParse(raw);
  if (!r.success || r.data.bill.billId !== billId || r.data.bill.storeId !== m[1]) throw new HttpProblem(502, "RAIL_ERROR", "The till answered an unexpected bill", { reasonCodes: ["RAIL_ERROR"] });
  const { bill, merchant } = r.data;
  const items = bill.items.map((i) => FulfillmentItem.parse({ sku: i.sku, qty: i.qty, unitPriceMinor: i.unitPriceMinor, name: i.name.slice(0, 140) }));
  if (items.reduce((s, i) => s + i.qty * i.unitPriceMinor, 0) !== bill.totalMinor) throw new HttpProblem(502, "RAIL_ERROR", "The bill's items do not add up to its total", { reasonCodes: ["RAIL_ERROR"] });
  return { billId, merchantSlug: bill.storeId, merchantName: merchant.name, items, totalMinor: bill.totalMinor, currency: bill.currency, status: bill.status };
}

/** POST /merchant-bills/:billId/propose. A pending proposal for the same bill is returned instead of a second one. */
export async function proposeBill(userId: string, billId: string): Promise<MerchantBillProposeResponse> {
  const bill = await fetchBill(billId);
  if (bill.status === "PAID") throw new HttpProblem(409, "BILL_ALREADY_PAID", "This bill is already paid");
  const db = getDb();
  const pending = (
    await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.userId, userId), eq(proposals.status, "PENDING_APPROVAL"), sql`${proposals.draft}->'fulfillment'->>'billId' = ${billId}`))
      .orderBy(desc(proposals.createdAt))
      .limit(1)
  )[0];
  if (pending && pending.draft.amountMinor === bill.totalMinor && pending.draft.currency === bill.currency) {
    return { proposalId: pending.id, decision: pending.decision, reasonCodes: pending.reasonCodes, summary: "This bill is already waiting for your approval.", bill };
  }
  const name = bill.merchantName.trim().toLowerCase();
  const payee = (await db.select().from(payees).where(eq(payees.userId, userId)))
    .filter((p) => p.name.trim().toLowerCase() === name && p.status !== "BLOCKED")
    .sort((a, b) => (a.status === "VERIFIED" ? 0 : 1) - (b.status === "VERIFIED" ? 0 : 1))[0];
  if (!payee) {
    throw new HttpProblem(422, "MERCHANT_NOT_A_PAYEE", `${bill.merchantName} is not one of your payees. Add it first, then scan the bill again.`);
  }
  const r = await proposeOrder({
    userId,
    createdBy: "USER",
    payeeId: payee.id,
    amountMinor: bill.totalMinor,
    currency: bill.currency,
    purpose: `${bill.merchantName} bill`,
    items: bill.items.map((i) => ({ sku: i.sku, name: i.name ?? i.sku, quantity: i.qty, unitPriceMinor: i.unitPriceMinor })),
    category: "eating_out",
    fulfillment: { merchant: bill.merchantSlug, channel: "TILL", billId, items: bill.items },
  });
  if (r.decision === "REFUSE") await reportTillDecline(bill.merchantSlug, billId, r.reasonCodes[0] ?? "REFUSED");
  return { proposalId: r.proposalId, decision: r.decision, reasonCodes: r.reasonCodes, summary: r.summary, bill };
}
