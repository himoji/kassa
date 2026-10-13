/** Untrusted source handed to the Reader. */
export type UntrustedSource =
  | { type: "text"; text: string }
  | { type: "pdf"; data: Uint8Array }
  | { type: "image"; data: Uint8Array; mediaType: string };

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** Max text handed to the Reader (protects the context window; invoices are short). */
export const MAX_SOURCE_CHARS = 40_000;

export async function pdfToText(data: Uint8Array): Promise<string> {
  // Loaded on first use: pdfjs-dist sets up canvas polyfills (@napi-rs/canvas) when it loads, which should never
  // stop the API from starting where PDFs are not read.
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data });
  try {
    const res = await parser.getText();
    return res.text;
  } finally {
    await parser.destroy();
  }
}

/** Sniff a media type from magic bytes (PDF 1.x / ISO 32000 "%PDF-", PNG, JPEG, WebP, GIF). */
export function sniffMediaType(data: Uint8Array): string | null {
  const b = data;
  const str = (n: number) => String.fromCharCode(...b.slice(0, n));
  if (str(5) === "%PDF-") return "application/pdf";
  if (b[0] === 0x89 && str(4).slice(1) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (str(4) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (str(4) === "GIF8") return "image/gif";
  return null;
}
