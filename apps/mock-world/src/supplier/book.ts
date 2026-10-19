import { randomUUID } from "node:crypto";

import type { InvoiceSpec } from "../../../../fixtures/invoices/source.ts";
import type { Clock } from "../clock.ts";
import { type Collection, mapCollection, setCollection, valueCollection } from "../store/sync.ts";
import { HttpError } from "../errors.ts";
import { renderInvoice } from "../pdf/invoice.ts";
import type { WebhookSink } from "../webhooks.ts";
import { QR_MERCHANTS, type Supplier, SUPPLIERS } from "../world/data.ts";

/*
 * (added 2026-10-15, Business M5) The suppliers' purchase-order book (simulated third-party systems). Kassa sends a
 * passkey-signed PO (HMAC-authenticated POST); the supplier's portal confirms it, marks it delivered and issues the
 * invoice, each reported to Kassa as a signed "supplier" webhook (po.confirmed / po.delivered / po.invoiced).
 * Attack A9: the newer, cheaper suppliers B (Budapest) and D (Shanghai) can send an invoice for the established
 * supplier's PO (A's / C's) that names that supplier but asks to be paid to the attacker's own account.
 */

export type SupplierId = keyof typeof SUPPLIERS;
export const SUPPLIER_IDS = Object.keys(SUPPLIERS) as SupplierId[];
/** Attacker → the supplier whose purchase orders it can send a "new bank details" invoice for. */
export const ATTACK_TARGETS: Partial<Record<SupplierId, SupplierId>> = { b: "a", d: "c" };

export type PoLine = { supplierSku: string; packs: number; packSize: number; packPriceMinor: number; lineTotalMinor: number };
export type InvoiceAccount = { scheme: "IBAN"; iban: string } | { scheme: "QR"; merchantId: string; payeeName: string };

export interface SupplierInvoice {
  invoiceId: string;
  purchaseOrderId: string;
  /** Who actually issued it (the attacker for a swapped invoice). */
  issuedBy: SupplierId;
  supplierName: string;
  amountMinor: number;
  currency: string;
  account: InvoiceAccount;
  issuedAt: string;
  reference: string;
  swapped: boolean;
}

export interface SupplierPo {
  purchaseOrderId: string;
  poHash: string | null;
  supplierId: SupplierId;
  supplierName: string;
  merchant: { slug: string; name: string };
  currency: string;
  lines: PoLine[];
  totalMinor: number;
  deliverBy: string;
  status: "RECEIVED" | "CONFIRMED" | "DELIVERED" | "INVOICED";
  receivedAt: string;
  invoices: SupplierInvoice[];
}

export type ReceivedPo = Omit<SupplierPo, "supplierId" | "status" | "receivedAt" | "invoices">;

export function resolveSupplier(id: unknown): Supplier & { id: SupplierId } {
  const key = typeof id === "string" ? id.toLowerCase() : "";
  if (!(SUPPLIER_IDS as string[]).includes(key)) throw new HttpError(404, "NOT_FOUND", "Unknown supplier");
  return SUPPLIERS[key as SupplierId] as Supplier & { id: SupplierId };
}

/** The account a supplier is paid to: its IBAN (EU) or its QR-wallet merchant (CN). */
export function accountOf(s: Supplier): InvoiceAccount {
  return s.iban ? { scheme: "IBAN", iban: s.iban } : { scheme: "QR", merchantId: s.qrMerchantId, payeeName: QR_MERCHANTS[s.qrMerchantId]?.name ?? s.name };
}

export class SupplierBook {
  private readonly orders = new Map<string, SupplierPo>();
  private readonly delivered = new Set<string>();
  private seq = 0;

  constructor(private readonly deps: { clock: Clock; webhooks: WebhookSink; publicUrl: string }) {}

  reset(): void {
    this.orders.clear();
    this.delivered.clear();
    this.seq = 0;
  }

  /** Shared between instances (store/sync.ts). */
  collections(): Collection[] {
    return [
      mapCollection("supplier.po", this.orders),
      setCollection("supplier.delivered", this.delivered as Set<string | number>),
      valueCollection("supplier.invoiceSeq", () => this.seq, (v: number) => (this.seq = Math.max(this.seq, v))),
    ];
  }

  /** A PO from Kassa (already authenticated). Idempotent by purchaseOrderId. */
  async receive(po: ReceivedPo): Promise<{ order: SupplierPo; created: boolean }> {
    const existing = this.orders.get(po.purchaseOrderId);
    if (existing) return { order: existing, created: false };
    const supplier = SUPPLIER_IDS.map((id) => SUPPLIERS[id]).find((s) => s.name === po.supplierName);
    if (!supplier) throw new HttpError(404, "UNKNOWN_SUPPLIER", "No supplier with that name");
    const order: SupplierPo = { ...po, supplierId: supplier.id as SupplierId, status: "RECEIVED", receivedAt: (await this.deps.clock.now()).toISOString(), invoices: [] };
    this.orders.set(po.purchaseOrderId, order);
    return { order, created: true };
  }

  list(supplierId: SupplierId): SupplierPo[] {
    return [...this.orders.values()].filter((o) => o.supplierId === supplierId).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  get(purchaseOrderId: string): SupplierPo | undefined {
    return this.orders.get(purchaseOrderId);
  }

  private own(supplierId: SupplierId, purchaseOrderId: string): SupplierPo {
    const o = this.orders.get(purchaseOrderId);
    if (!o || o.supplierId !== supplierId) throw new HttpError(404, "NOT_FOUND", "Unknown purchase order");
    return o;
  }

  private send(type: string, o: SupplierPo, extra: Record<string, unknown> = {}, supplierName = o.supplierName): void {
    this.deps.webhooks.send("supplier", { eventId: randomUUID(), type, purchaseOrderId: o.purchaseOrderId, supplierName, ...extra, simulated: true });
  }

  confirm(supplierId: SupplierId, purchaseOrderId: string): SupplierPo {
    const o = this.own(supplierId, purchaseOrderId);
    if (o.status !== "RECEIVED") throw new HttpError(409, "BAD_STATE", `Order is ${o.status}`);
    o.status = "CONFIRMED";
    this.send("po.confirmed", o);
    return o;
  }

  deliver(supplierId: SupplierId, purchaseOrderId: string): SupplierPo {
    const o = this.own(supplierId, purchaseOrderId);
    if (o.status === "RECEIVED") throw new HttpError(409, "BAD_STATE", "Confirm the order first");
    if (this.delivered.has(o.purchaseOrderId)) throw new HttpError(409, "BAD_STATE", "Already delivered");
    this.delivered.add(o.purchaseOrderId);
    if (o.status !== "INVOICED") o.status = "DELIVERED";
    this.send("po.delivered", o, { lines: o.lines.map((l) => ({ supplierSku: l.supplierSku, packs: l.packs })) });
    return o;
  }

  isDelivered(purchaseOrderId: string): boolean {
    return this.delivered.has(purchaseOrderId);
  }

  private async issue(issuer: Supplier & { id: SupplierId }, o: SupplierPo, opts: { amountMinor?: number; swapped: boolean }): Promise<SupplierInvoice> {
    const named = SUPPLIERS[o.supplierId];
    const inv: SupplierInvoice = {
      invoiceId: `INV-${issuer.id.toUpperCase()}-${String(++this.seq).padStart(4, "0")}`,
      purchaseOrderId: o.purchaseOrderId,
      issuedBy: issuer.id,
      // A swapped invoice impersonates the PO's supplier: its name, the attacker's account.
      supplierName: named.name,
      amountMinor: opts.amountMinor ?? o.totalMinor,
      currency: o.currency,
      account: accountOf(issuer),
      issuedAt: (await this.deps.clock.now()).toISOString(),
      reference: `PO ${o.purchaseOrderId.slice(0, 8)}`,
      swapped: opts.swapped,
    };
    o.invoices.push(inv);
    if (!opts.swapped) o.status = "INVOICED";
    this.send(
      "po.invoiced",
      o,
      {
        invoice: {
          invoiceId: inv.invoiceId,
          supplierName: inv.supplierName,
          amountMinor: inv.amountMinor,
          currency: inv.currency,
          issuedAt: inv.issuedAt,
          reference: inv.reference,
          account: inv.account,
          pdfUrl: `${this.deps.publicUrl}/mock/supplier/${issuer.id}/invoices/${inv.invoiceId}/invoice.pdf`,
        },
      },
      inv.supplierName,
    );
    return inv;
  }

  async invoice(supplierId: SupplierId, purchaseOrderId: string, opts: { amountMinor?: number } = {}): Promise<SupplierInvoice> {
    const o = this.own(supplierId, purchaseOrderId);
    if (o.status === "RECEIVED") throw new HttpError(409, "BAD_STATE", "Confirm the order first");
    if (o.invoices.some((i) => !i.swapped)) throw new HttpError(409, "BAD_STATE", "Already invoiced");
    return this.issue(resolveSupplier(supplierId), o, { ...(opts.amountMinor !== undefined ? { amountMinor: opts.amountMinor } : {}), swapped: false });
  }

  /** A9: the attacker invoices the target supplier's PO with its own bank details (or QR merchant). */
  async swappedInvoice(attackerId: SupplierId, purchaseOrderId: string): Promise<SupplierInvoice> {
    const target = ATTACK_TARGETS[attackerId];
    if (!target) throw new HttpError(404, "NOT_FOUND", "No attack for this supplier");
    const o = this.own(target, purchaseOrderId);
    return this.issue(resolveSupplier(attackerId), o, { swapped: true });
  }

  findInvoice(issuer: SupplierId, invoiceId: string): { order: SupplierPo; invoice: SupplierInvoice } | null {
    for (const order of this.orders.values()) {
      const invoice = order.invoices.find((i) => i.invoiceId === invoiceId && i.issuedBy === issuer);
      if (invoice) return { order, invoice };
    }
    return null;
  }

  /** The invoice as a PDF (pdf/invoice.ts), payee name = the supplier named, account = the one it asks to be paid. */
  async invoicePdf(issuer: SupplierId, invoiceId: string): Promise<Uint8Array> {
    const f = this.findInvoice(issuer, invoiceId);
    if (!f) throw new HttpError(404, "NOT_FOUND", "Unknown invoice");
    const { order, invoice } = f;
    const named = SUPPLIERS[order.supplierId];
    const accountText = invoice.account.scheme === "IBAN" ? invoice.account.iban : `QRWALLET-${invoice.account.merchantId.toUpperCase()}`;
    const spec: InvoiceSpec = {
      id: invoice.invoiceId,
      layout: "classic",
      language: "en",
      font: "helvetica",
      issuer: { name: named.name, addressLines: [named.city, named.country] },
      billTo: { name: order.merchant.name, addressLines: [] },
      invoiceNumber: invoice.invoiceId,
      issueDate: invoice.issuedAt.slice(0, 10),
      dueDate: invoice.issuedAt.slice(0, 10),
      currency: invoice.currency,
      lines: [{ description: `Purchase order ${order.purchaseOrderId.slice(0, 8)}`, quantity: 1, unitPriceMinor: invoice.amountMinor }],
      payment: { payeeName: named.name, iban: accountText, reference: invoice.reference, ibanStyle: "electronic" },
      amountStyle: "en-code",
      dateStyle: "iso",
    };
    return (await renderInvoice(spec)).pdf;
  }
}
