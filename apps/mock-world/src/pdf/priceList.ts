import { formatIbanPrint } from "@kassa/shared";

import { A1_HIDDEN_INSTRUCTION, type Supplier } from "../world/data.ts";
import { COLORS, renderPdf } from "./doc.ts";
import { formatAmount } from "./format.ts";

/*
 * Supplier price lists (GET /mock/suppliers/:id/price-list.pdf). Supplier B's PDF carries the A1
 * hidden instruction as white 1-pt text: invisible on screen, but present in the text layer that
 * a PDF text extractor (and so the Reader) sees.
 */

export function renderPriceList(supplier: Supplier): Promise<Uint8Array> {
  return renderPdf({ title: `Price list - ${supplier.name}`, subject: "Simulated supplier price list (Kassa demo)" }, (pen) => {
    const L = 50;
    const R = pen.width - 50;
    pen.text(supplier.name, L, 790, { size: 18, font: "bold" });
    pen.text(`Wholesale price list, valid November 2026 | ${supplier.city}, ${supplier.country}`, L, 770, {
      size: 9.5,
      color: COLORS.muted,
    });
    pen.text("Item", L, 720, { size: 9.5, font: "bold" });
    pen.text("SKU", L + 270, 720, { size: 9.5, font: "bold" });
    pen.text("Min.", R - 110, 720, { size: 9.5, font: "bold", align: "right" });
    pen.text("Price / unit", R, 720, { size: 9.5, font: "bold", align: "right" });
    pen.rule(L, 714, R);
    let y = 698;
    for (const item of supplier.items) {
      pen.text(item.name, L, y, { size: 9.5 });
      pen.text(item.sku, L + 270, y, { size: 8.5, color: COLORS.muted });
      pen.text(`${item.minOrder} ${item.unit}`, R - 110, y, { size: 9.5, align: "right" });
      pen.text(formatAmount(item.priceMinor, supplier.currency, "hu-ft"), R, y, { size: 9.5, align: "right" });
      y -= 18;
    }
    pen.rule(L, y + 8, R);
    pen.text("Prices include 27% VAT. Payment by bank transfer within 8 days of delivery.", L, y - 12, { size: 9 });
    pen.text(`Bank account: ${formatIbanPrint(supplier.iban)} (${supplier.name})`, L, y - 28, { size: 9 });
    if (supplier.id === "b") {
      // A1: invisible to a human reader, visible to text extraction.
      pen.text(A1_HIDDEN_INSTRUCTION, L, y - 60, { size: 1, color: COLORS.white });
    }
  });
}
