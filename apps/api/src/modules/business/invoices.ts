/*
 * (added 2026-10-15, Business M5) Supplier invoice three-way match: invoice ↔ passkey-signed purchase order ↔ verified
 * supplier payee. An invoice is untrusted input (it arrives in a signed mock-world webhook, but anyone can write an
 * invoice — e.g. a fraudster with "new bank details", attack A9). Checks, in order:
 *   1 supplier: the invoice names the PO's supplier                                 else INVOICE_ACCOUNT_MISMATCH
 *   2 account:  accountHash(the account the invoice asks to be paid) = the signed core's supplierAccountHash = the
 *               supplier payee's current hash, payee still VERIFIED                  else INVOICE_ACCOUNT_MISMATCH
 *               (EU: the IBAN; CN QR-wallet suppliers: the QR payee name, the account a MERCHANT_ID payee holds)
 *   3 amount:   same currency, 0 < amount ≤ the signed total                        else INVOICE_ABOVE_PO
 * A refusal is ledgered (INVOICE_REFUSED), kept on the PO (reason code + timeline) and the owner is notified; nothing
 * is proposed. A match creates ONE obligation (recurrence ONCE) and proposes its payment through rules with
 * {obligationId, purchaseOrderId}: always the owner's passkey (ASK T2; region CN → HANDOFF QR), PO_NOT_DELIVERED when
 * the goods have not arrived. A repeated invoice for an already matched PO changes nothing.
 */
import type { ReasonCode } from "@kassa/shared";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../db/client.ts";
import { merchants, obligations, payees, purchaseOrders, type PurchaseOrderInvoiceJson } from "../../db/schema.ts";
import { conflict } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { ledger } from "../ledger/index.ts";
import { notify } from "../notifications/service.ts";
import { accountHash } from "../payees/crypto.ts";
import { proposeOrder } from "../rules/index.ts";
import { normalizeName } from "../screening/normalize.ts";
import { localDay } from "./forecast.ts";

export const SupplierInvoice = z.object({
  invoiceId: z.string().min(1).max(64),
  supplierName: z.string().min(1).max(140),
  amountMinor: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  issuedAt: z.string().max(40),
  reference: z.string().max(140).nullable().optional(),
  account: z.discriminatedUnion("scheme", [
    z.object({ scheme: z.literal("IBAN"), iban: z.string().min(5).max(64) }),
    z.object({ scheme: z.literal("QR"), merchantId: z.string().min(1).max(64), payeeName: z.string().min(1).max(140) }),
  ]),
  pdfUrl: z.string().max(500).optional(),
});
export type SupplierInvoice = z.infer<typeof SupplierInvoice>;

export type InvoiceOutcome =
  | { refused: true; reasonCodes: ReasonCode[] }
  | { refused: false; duplicate: boolean; obligationId: string | null; proposalId: string | null; decision?: string; reasonCodes: ReasonCode[] };

const same = (a: string, b: string) => normalizeName(a, { stripLegal: true }) === normalizeName(b, { stripLegal: true });

/** The account string a payee of this scheme holds: the IBAN, or for a QR-wallet merchant its payee name. */
const invoiceAccount = (inv: SupplierInvoice) => (inv.account.scheme === "IBAN" ? inv.account.iban : inv.account.payeeName);

export async function handleInvoice(purchaseOrderId: string, inv: SupplierInvoice): Promise<InvoiceOutcome> {
  const db = getDb();
  const now = clock.now();
  const step = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`business:po-invoice:${purchaseOrderId}`}))`);
    const row = (await tx.select({ po: purchaseOrders, m: merchants }).from(purchaseOrders).innerJoin(merchants, eq(merchants.id, purchaseOrders.merchantId)).where(eq(purchaseOrders.id, purchaseOrderId)))[0]!;
    const { po, m } = row;
    const core = po.core!;
    if (po.obligationId) return { kind: "duplicate" as const, po };
    if (!["SENT", "CONFIRMED", "DELIVERED"].includes(po.status)) throw conflict("WEBHOOK_REJECTED", `An invoice cannot be matched to a ${po.status} purchase order`);
    const payee = (await tx.select().from(payees).where(eq(payees.id, core.supplierPayeeId)))[0];
    const invHash = accountHash(invoiceAccount(inv));

    let reason: ReasonCode | null = null;
    let detail = "";
    if (!same(inv.supplierName, core.supplierName)) [reason, detail] = ["INVOICE_ACCOUNT_MISMATCH", "SUPPLIER_MISMATCH"];
    else if (invHash !== core.supplierAccountHash || !payee || payee.accountHash !== core.supplierAccountHash || payee.status !== "VERIFIED") {
      [reason, detail] = ["INVOICE_ACCOUNT_MISMATCH", "ACCOUNT_NOT_VERIFIED_SUPPLIER_ACCOUNT"];
    } else if (inv.currency !== core.currency || inv.amountMinor <= 0 || inv.amountMinor > core.totalMinor) [reason, detail] = ["INVOICE_ABOVE_PO", "AMOUNT_ABOVE_SIGNED_TOTAL"];

    if (reason) {
      await tx
        .update(purchaseOrders)
        .set({
          reasonCodes: po.reasonCodes.includes(reason) ? po.reasonCodes : [...po.reasonCodes, reason],
          timeline: sql`${purchaseOrders.timeline} || ${JSON.stringify([{ status: "INVOICE_REFUSED", at: now.toISOString(), note: reason }])}::jsonb`,
          updatedAt: now,
        })
        .where(eq(purchaseOrders.id, po.id));
      // Hashes and amounts only: the account the fraudster asked for is evidence, not personal data of the owner.
      await ledger.append(
        "INVOICE_REFUSED",
        { userId: m.ownerUserId, merchantId: m.id, purchaseOrderId: po.id, invoiceId: inv.invoiceId, reasonCodes: [reason], detail, invoiceAccountHash: invHash, signedAccountHash: core.supplierAccountHash, amountMinor: inv.amountMinor, currency: inv.currency, signedTotalMinor: core.totalMinor },
        tx,
      );
      await notify(
        m.ownerUserId,
        {
          kind: "BUSINESS_INVOICE_REFUSED",
          title: reason === "INVOICE_ABOVE_PO" ? "Invoice above your purchase order" : "Invoice with different bank details",
          body:
            reason === "INVOICE_ABOVE_PO"
              ? `An invoice for your purchase order to ${core.supplierName} is for more than you signed, so it was refused. Nothing was paid.`
              : `An invoice for your purchase order to ${core.supplierName} asks you to pay an account that is not the supplier's verified account, so it was refused. Nothing was paid. Call the supplier on a number you already know before paying anything.`,
          data: { key: "business.invoiceRefused", params: { supplier: core.supplierName, reason }, purchaseOrderId: po.id, reasonCodes: [reason] },
        },
        tx,
      );
      return { kind: "refused" as const, reason };
    }

    const invoice: PurchaseOrderInvoiceJson = { invoiceId: inv.invoiceId, supplierName: inv.supplierName, amountMinor: inv.amountMinor, currency: inv.currency, accountHash: invHash, issuedAt: inv.issuedAt, reference: inv.reference ?? null };
    const [ob] = await tx
      .insert(obligations)
      .values({ userId: m.ownerUserId, payeeId: core.supplierPayeeId, amountMinor: inv.amountMinor, currency: inv.currency, dueDate: localDay(now, m.timezone), recurrence: "ONCE", reference: inv.invoiceId.slice(0, 64), category: "supplies" })
      .returning({ id: obligations.id });
    await tx
      .update(purchaseOrders)
      .set({ status: "INVOICED", invoice, obligationId: ob!.id, timeline: sql`${purchaseOrders.timeline} || ${JSON.stringify([{ status: "INVOICED", at: now.toISOString(), note: inv.invoiceId }])}::jsonb`, updatedAt: now })
      .where(eq(purchaseOrders.id, po.id));
    await ledger.append("INVOICE_MATCHED", { userId: m.ownerUserId, merchantId: m.id, purchaseOrderId: po.id, invoiceId: inv.invoiceId, obligationId: ob!.id, amountMinor: inv.amountMinor, currency: inv.currency, accountHash: invHash }, tx);
    return { kind: "matched" as const, po, m, obligationId: ob!.id, region: m.region };
  });

  if (step.kind === "refused") return { refused: true, reasonCodes: [step.reason] };
  if (step.kind === "duplicate") return { refused: false, duplicate: true, obligationId: step.po.obligationId, proposalId: step.po.proposalId, reasonCodes: [] };

  const core = step.po.core!;
  let r: Awaited<ReturnType<typeof proposeOrder>>;
  try {
    r = await proposeOrder({
    userId: step.m.ownerUserId,
    createdBy: "SCHEDULER",
    payeeId: core.supplierPayeeId,
    amountMinor: inv.amountMinor,
    currency: inv.currency,
    purpose: `Invoice ${inv.invoiceId}, purchase order to ${core.supplierName}`.slice(0, 140),
    // EU suppliers are paid by bank transfer; region CN always becomes a QR HANDOFF in rules.
    ...(step.region === "CN" ? {} : { rail: "BANK_TRANSFER" as const }),
    category: "supplies",
    obligationId: step.obligationId,
    purchaseOrderId: step.po.id,
    });
  } catch (err) {
    // The match stands (obligation + INVOICED); the payment can be proposed again from the obligation.
    await ledger.append("INVOICE_PROPOSAL_FAILED", { userId: step.m.ownerUserId, purchaseOrderId: step.po.id, obligationId: step.obligationId, error: (err as Error).message });
    return { refused: false, duplicate: false, obligationId: step.obligationId, proposalId: null, reasonCodes: [] };
  }
  await db.update(purchaseOrders).set({ proposalId: r.proposalId, updatedAt: clock.now() }).where(eq(purchaseOrders.id, step.po.id));
  return { refused: false, duplicate: false, obligationId: step.obligationId, proposalId: r.proposalId, decision: r.decision, reasonCodes: r.reasonCodes };
}
