import qrcode from "qrcode";

/*
 * (M3) QR code images for the counter till (the bill's Kassa app link). A static import (types: @types/qrcode in the
 * root package.json), so bundlers and Vercel's file tracing see the dependency.
 */

/** An SVG QR code for `text`. */
export function qrSvg(text: string): Promise<string> {
  return qrcode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}
