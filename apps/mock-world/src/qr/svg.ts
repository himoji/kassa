import { createRequire } from "node:module";

/*
 * (M3) QR code images for the counter till (the bill's Kassa app link). `qrcode` ships no types and the workspace has
 * no @types for it, so the one function used is typed here.
 */
type QrToString = (text: string, options: { type: "svg"; margin?: number; errorCorrectionLevel?: "L" | "M" | "Q" | "H" }) => Promise<string>;
const qrcode = createRequire(import.meta.url)("qrcode") as { toString: QrToString };

/** An SVG QR code for `text`. */
export function qrSvg(text: string): Promise<string> {
  return qrcode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}
