import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { HttpError, parseWith } from "../errors.ts";
import { inboxEmails, PAYEE_IDS, PAYEE_INVOICES, SUPPLIERS } from "../world/data.ts";

/*
 * Documents the agent reads through the Reader (spec §17): supplier catalogs and price lists,
 * payee invoices, and the e-mail inbox. All content is UNTRUSTED by design (A1, A2, swapped
 * invoice). PDFs are rendered once at startup (deterministic) and served from memory.
 */

export interface DocumentCache {
  priceLists: Record<"a" | "b", Uint8Array>;
  invoices: Record<string, Uint8Array>;
}

function sendPdf(reply: FastifyReply, bytes: Uint8Array, filename: string) {
  return reply
    .header("content-type", "application/pdf")
    .header("content-disposition", `inline; filename="${filename}"`)
    .header("cache-control", "no-store")
    .send(Buffer.from(bytes));
}

const SupplierParam = z.object({ id: z.enum(["a", "b"]) });

export function documentRoutes(app: FastifyInstance, deps: { docs: DocumentCache; publicUrl: string }): void {
  const base = `${deps.publicUrl}/mock`;

  app.get("/suppliers", async () => ({
    suppliers: Object.values(SUPPLIERS).map((s) => ({
      id: s.id,
      name: s.name,
      city: s.city,
      catalogUrl: `${base}/suppliers/${s.id}/catalog`,
      priceListUrl: `${base}/suppliers/${s.id}/price-list.pdf`,
    })),
    simulated: true,
  }));

  app.get("/suppliers/:id/catalog", async (req) => {
    const r = SupplierParam.safeParse(req.params);
    if (!r.success) throw new HttpError(404, "NOT_FOUND", "Unknown supplier");
    const s = SUPPLIERS[r.data.id];
    return {
      supplier: { id: s.id, name: s.name, city: s.city, country: s.country, mcc: s.mcc, iban: s.iban },
      currency: s.currency,
      items: s.items.map((i) => ({ ...i, currency: s.currency })),
      notes: s.notes,
      priceListUrl: `${base}/suppliers/${s.id}/price-list.pdf`,
      simulated: true,
    };
  });

  app.get("/suppliers/:id/price-list.pdf", async (req, reply) => {
    const r = SupplierParam.safeParse(req.params);
    if (!r.success) throw new HttpError(404, "NOT_FOUND", "Unknown supplier");
    return sendPdf(reply, deps.docs.priceLists[r.data.id], `price-list-${r.data.id}.pdf`);
  });

  app.get("/payees", async () => ({
    payees: Object.entries(PAYEE_INVOICES)
      .filter(([id]) => !id.includes("-"))
      .map(([id, spec]) => ({
        id,
        seedPayeeId: PAYEE_IDS[id] ?? null,
        name: spec.payment.payeeName,
        invoiceUrl: `${base}/payees/${id}/invoice.pdf`,
        ...(id === "university" ? { swappedVariantUrl: `${base}/payees/university/invoice.pdf?variant=swapped-account` } : {}),
      })),
    simulated: true,
  }));

  app.get("/payees/:id/invoice.pdf", async (req, reply) => {
    const { id } = parseWith(z.object({ id: z.string().min(1).max(40) }), req.params, "params");
    const { variant } = parseWith(z.object({ variant: z.enum(["swapped-account"]).optional() }), req.query, "query");
    const key = variant === "swapped-account" ? `${id}-swapped` : id;
    const bytes = deps.docs.invoices[key];
    if (!bytes || key.includes("-") !== (variant !== undefined)) {
      throw new HttpError(404, "NOT_FOUND", variant ? `No ${variant} variant for ${id}` : `Unknown payee ${id}`);
    }
    return sendPdf(reply, bytes, `invoice-${key}.pdf`);
  });

  app.get("/inbox", async () => {
    // `tag` is ground truth for tests; it is not part of what a mail client would show.
    const emails = inboxEmails(deps.publicUrl).map(({ tag: _tag, ...e }) => e);
    return { mailbox: "dana.seitkali@student.university-in-budapest.example", emails, simulated: true };
  });

  app.get("/inbox/:id", async (req) => {
    const { id } = parseWith(z.object({ id: z.string() }), req.params, "params");
    const email = inboxEmails(deps.publicUrl).find((e) => e.id === id);
    if (!email) throw new HttpError(404, "NOT_FOUND", "Unknown message");
    const { tag: _tag, ...rest } = email;
    return { ...rest, simulated: true };
  });
}
