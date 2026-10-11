/*
 * Minimal single-page PDF (ISO 32000-1:2008): one Helvetica text stream, WinAnsi-safe ASCII only, with a
 * correct cross-reference table (§7.5.4) so any viewer opens it. No dependency needed for a text record.
 */
function esc(s: string): string {
  // PDF literal string escapes (§7.3.4.2); non-ASCII replaced (standard 14 fonts are not Unicode).
  return s.replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
}

export function textPdf(lines: string[]): Uint8Array {
  const content = ["BT", "/F1 11 Tf", "14 TL", "56 786 Td", ...lines.map((l) => `(${esc(l)}) '`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
