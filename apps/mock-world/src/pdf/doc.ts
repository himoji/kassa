import type { PDFFont, PDFPage, RGB } from "pdf-lib";
import { PDFDocument, PageSizes, StandardFonts, rgb } from "pdf-lib";

import type { FontFamily } from "../../../../fixtures/invoices/source.ts";

/*
 * Thin wrapper over pdf-lib (https://pdf-lib.js.org) for deterministic documents:
 * - `PDFDocument.create({ updateMetadata: false })` stops pdf-lib stamping the current time and
 *   its own producer; we set a fixed creation date and producer instead, so the same input gives
 *   byte-identical output (checked in test/invoices.test.ts).
 * - Only the 14 standard fonts (WinAnsi encoding, no embedding); text outside Windows-1252 throws.
 * Every page carries a "SIMULATED" footer (spec §0: everything mocked is labelled).
 */

export const FIXED_PDF_DATE = new Date("2026-10-01T00:00:00.000Z");

export const COLORS = {
  ink: rgb(0.1, 0.1, 0.12),
  muted: rgb(0.42, 0.44, 0.48),
  rule: rgb(0.8, 0.82, 0.85),
  accent: rgb(0.11, 0.33, 0.62),
  band: rgb(0.93, 0.95, 0.98),
  white: rgb(1, 1, 1),
  warn: rgb(0.7, 0.25, 0.1),
};

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

const FAMILY: Record<FontFamily, [StandardFonts, StandardFonts, StandardFonts]> = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique],
};

export interface TextOpts {
  size?: number;
  font?: keyof Fonts;
  color?: RGB;
  align?: "left" | "right" | "center";
}

export class Pen {
  readonly width: number;
  readonly height: number;

  constructor(
    readonly page: PDFPage,
    readonly fonts: Fonts,
  ) {
    const { width, height } = page.getSize();
    this.width = width;
    this.height = height;
  }

  /** Draw one run of text. Each label value is drawn in a single call so text extraction keeps it contiguous. */
  text(value: string, x: number, y: number, opts: TextOpts = {}): void {
    const size = opts.size ?? 10;
    const font = this.fonts[opts.font ?? "regular"];
    const w = font.widthOfTextAtSize(value, size);
    const dx = opts.align === "right" ? -w : opts.align === "center" ? -w / 2 : 0;
    this.page.drawText(value, { x: x + dx, y, size, font, color: opts.color ?? COLORS.ink });
  }

  textWidth(value: string, size = 10, font: keyof Fonts = "regular"): number {
    return this.fonts[font].widthOfTextAtSize(value, size);
  }

  lines(values: string[], x: number, y: number, opts: TextOpts & { leading?: number } = {}): number {
    const leading = opts.leading ?? (opts.size ?? 10) * 1.35;
    values.forEach((v, i) => this.text(v, x, y - i * leading, opts));
    return y - values.length * leading;
  }

  rule(x1: number, y: number, x2: number, thickness = 0.6, color: RGB = COLORS.rule): void {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  box(x: number, y: number, width: number, height: number, opts: { fill?: RGB; border?: RGB; borderWidth?: number } = {}): void {
    this.page.drawRectangle({
      x,
      y,
      width,
      height,
      ...(opts.fill ? { color: opts.fill } : {}),
      ...(opts.border ? { borderColor: opts.border, borderWidth: opts.borderWidth ?? 0.8 } : {}),
    });
  }
}

export interface DocMeta {
  title: string;
  subject?: string;
  font?: FontFamily;
  size?: [number, number];
}

/** Create a deterministic one-page document and hand a Pen to `draw`. */
export async function renderPdf(meta: DocMeta, draw: (pen: Pen) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(meta.title);
  if (meta.subject) doc.setSubject(meta.subject);
  doc.setCreator("Kassa mock-world (simulated)");
  doc.setProducer("pdf-lib");
  doc.setCreationDate(FIXED_PDF_DATE);
  doc.setModificationDate(FIXED_PDF_DATE);
  const [r, b, i] = FAMILY[meta.font ?? "helvetica"];
  const fonts: Fonts = {
    regular: await doc.embedFont(r),
    bold: await doc.embedFont(b),
    italic: await doc.embedFont(i),
  };
  const page = doc.addPage(meta.size ?? PageSizes.A4);
  const pen = new Pen(page, fonts);
  draw(pen);
  const footer = "SIMULATED DOCUMENT - Kassa demo, not a real document";
  const footerSize = Math.min(7, (7 * (pen.width - 16)) / pen.textWidth(footer, 7));
  pen.text(footer, pen.width / 2, 22, {
    size: footerSize,
    color: COLORS.muted,
    align: "center",
  });
  return doc.save({ useObjectStreams: false });
}
