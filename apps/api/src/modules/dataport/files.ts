import { inflateRawSync } from "node:zlib";

/*
 * File readers for imports (read.ts). Every upload is untrusted: the format comes from the bytes, never from the
 * client's name or type, sizes are capped, and nothing here executes or follows anything in a file.
 *  - PDF (ISO 32000, "%PDF-"): text per page and ruled tables, through pdf-parse (pdf.js), the Reader's library.
 *  - XLSX (ECMA-376 Office Open XML, a ZIP): read with node:zlib and a small XML scan of the first worksheets; formulas
 *    are never evaluated, only their cached values are read. Legacy XLS (OLE2, D0 CF 11 E0) is refused with a hint.
 *  - CSV / TSV (RFC 4180): UTF-8, UTF-16 (BOM) or Windows-1251 (Russian and Kazakh bank exports), delimiter , ; tab |.
 *  - OFX / QFX (Open Financial Exchange 1.x SGML and 2.x XML): STMTTRN blocks.
 *  - JSON and plain text.
 */

export type FileFormat = "pdf" | "xlsx" | "csv" | "json" | "ofx" | "text";

export class FileFormatError extends Error {}

/** Upload cap per file (also the multipart limit in routes.ts). */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
/** Cells read from one spreadsheet (protects memory from a zip bomb of a sheet). */
const MAX_CELLS = 400_000;
/** Uncompressed bytes read from one XLSX part. */
const MAX_XML_BYTES = 60 * 1024 * 1024;

const startsWith = (b: Uint8Array, ...bytes: number[]) => bytes.every((x, i) => b[i] === x);

/** Decode text: BOM first, then strict UTF-8, else Windows-1251 when the bytes look Cyrillic, else Windows-1252. */
export function decodeText(b: Uint8Array): string {
  if (startsWith(b, 0xef, 0xbb, 0xbf)) return new TextDecoder("utf-8").decode(b.subarray(3));
  if (startsWith(b, 0xff, 0xfe)) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (startsWith(b, 0xfe, 0xff)) return new TextDecoder("utf-16be").decode(b.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    // In Windows-1251 Cyrillic letters are 0xC0–0xFF; in Windows-1252 that range is rarer accented Latin.
    let high = 0;
    for (const x of b.subarray(0, 20_000)) if (x >= 0xc0) high++;
    return new TextDecoder(high > 20 ? "windows-1251" : "windows-1252").decode(b);
  }
}

export function sniffFormat(b: Uint8Array): FileFormat | { unsupported: string } {
  if (startsWith(b, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "pdf";
  if (startsWith(b, 0x50, 0x4b, 0x03, 0x04)) {
    const names = zipEntries(b).map((e) => e.name);
    if (names.includes("xl/workbook.xml")) return "xlsx";
    if (names.includes("content.xml")) return { unsupported: "This looks like an OpenDocument spreadsheet. Save it as XLSX or CSV and try again." };
    return { unsupported: "This ZIP file is not a spreadsheet Kassa can read. Upload a PDF, XLSX, CSV or JSON statement." };
  }
  if (startsWith(b, 0xd0, 0xcf, 0x11, 0xe0)) return { unsupported: "This is an old Excel file (.xls). Open it and save it as .xlsx or .csv, then upload that." };
  if (startsWith(b, 0x89, 0x50, 0x4e, 0x47) || startsWith(b, 0xff, 0xd8, 0xff)) return { unsupported: "This is a photo. Upload the statement as a PDF, or send the photo in the chat so Kassa can read it." };
  const head = decodeText(b.subarray(0, 4096)).trimStart();
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  if (/^(?:OFXHEADER|<\?xml[^>]*>\s*<\?OFX|<OFX>)/i.test(head)) return "ofx";
  return looksDelimited(decodeText(b.subarray(0, 64 * 1024))) ? "csv" : "text";
}

// ---------- CSV ----------

const DELIMITERS = [",", ";", "\t", "|"] as const;

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

/** The delimiter that splits most lines into the same number of columns (≥ 2), or null. */
export function detectDelimiter(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 60);
  if (lines.length < 2) return null;
  let best: { d: string; score: number } | null = null;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d)).filter((c) => c > 0);
    if (counts.length < Math.max(2, lines.length * 0.5)) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [mode, hits] = [...freq].sort((a, b) => b[1] - a[1])[0]!;
    const score = hits * mode;
    if (mode >= 1 && (!best || score > best.score)) best = { d, score };
  }
  return best?.d ?? null;
}

function looksDelimited(text: string): boolean {
  return detectDelimiter(text) !== null;
}

/** RFC 4180 rows (quoted fields, doubled quotes, line breaks inside quotes). */
export function parseCsv(text: string, delimiter = detectDelimiter(text) ?? ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"' && field.trim() === "") {
      q = true;
      field = "";
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
    if (rows.length * 8 > MAX_CELLS) break;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

// ---------- XLSX ----------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** ZIP central directory (APPNOTE 6.3.x). */
function zipEntries(b: Uint8Array): ZipEntry[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    out.push({
      name: new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen)),
      method: v.getUint16(p + 10, true),
      compressedSize: v.getUint32(p + 20, true),
      size: v.getUint32(p + 24, true),
      localOffset: v.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function zipRead(b: Uint8Array, e: ZipEntry): string {
  if (e.size > MAX_XML_BYTES) throw new FileFormatError("This spreadsheet is too large to import.");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const start = e.localOffset + 30 + v.getUint16(e.localOffset + 26, true) + v.getUint16(e.localOffset + 28, true);
  const raw = b.subarray(start, start + e.compressedSize);
  const data = e.method === 0 ? raw : e.method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_XML_BYTES }) : null;
  if (!data) throw new FileFormatError("This spreadsheet uses a compression Kassa cannot read. Save it as CSV.");
  return new TextDecoder().decode(data);
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (XML_ENTITIES[e] ?? m),
  );

/** "BC12" → 54 (zero-based column of a cell reference). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export interface Sheet {
  name: string;
  rows: (string | number)[][];
}

/** Worksheets (up to 5) as rows of cached cell values: shared strings, inline strings, numbers. */
export function readXlsx(b: Uint8Array): Sheet[] {
  const entries = zipEntries(b);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const shared: string[] = [];
  const sst = byName.get("xl/sharedStrings.xml");
  if (sst) for (const si of zipRead(b, sst).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unxml([...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const workbook = byName.get("xl/workbook.xml") ? zipRead(b, byName.get("xl/workbook.xml")!) : "";
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unxml(m[1]!));
  const sheetFiles = entries.map((e) => e.name).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  let cells = 0;
  return sheetFiles.slice(0, 5).map((file, i) => {
    const xml = zipRead(b, byName.get(file)!);
    const rows: (string | number)[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: (string | number)[] = [];
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (++cells > MAX_CELLS) throw new FileFormatError("This spreadsheet is too large to import.");
        const attrs = c[1]!;
        const body = c[2] ?? "";
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: string | number = "";
        if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
        else if (type === "str" || type === "e") value = v !== undefined ? unxml(v) : "";
        else if (v !== undefined) value = Number.isFinite(Number(v)) ? Number(v) : unxml(v);
        const at = ref ? columnIndex(ref) : row.length;
        while (row.length < at) row.push("");
        row[at] = value;
      }
      if (row.some((x) => x !== "")) rows.push(row);
    }
    return { name: names[i] ?? `Sheet${i + 1}`, rows };
  });
}

// ---------- OFX ----------

/** OFX statement transactions as records (DTPOSTED, TRNAMT, NAME / MEMO, CURDEF). */
export function readOfx(text: string): { currency: string | null; records: Record<string, string>[] } {
  const tag = (block: string, name: string) => new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block)?.[1]?.trim() ?? "";
  const currency = tag(text, "CURDEF") || null;
  const records = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|<\/BANKTRANLIST>)/gi)].map((m) => {
    const b = m[1]!;
    const d = tag(b, "DTPOSTED");
    return {
      date: d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d,
      amount: tag(b, "TRNAMT"),
      description: [tag(b, "NAME"), tag(b, "MEMO")].filter(Boolean).join(" "),
      currency: tag(b, "CURRENCY") ? tag(tag(b, "CURRENCY"), "CURSYM") : "",
    };
  });
  return { currency, records };
}

// ---------- PDF ----------

export interface PdfContent {
  pages: { num: number; text: string }[];
  /** Ruled tables per page, cells as text; empty when the PDF has none or they cannot be read. */
  tables: { page: number; rows: string[][] }[];
  text: string;
}

/** Text per page and ruled tables (pdf-parse; loaded on first use, as the Reader does). */
export async function readPdf(data: Uint8Array): Promise<PdfContent> {
  const { PDFParse } = await import("pdf-parse");
  const textParser = new PDFParse({ data: data.slice() });
  let pages: { num: number; text: string }[];
  try {
    pages = (await textParser.getText()).pages.map((p) => ({ num: p.num, text: p.text }));
  } catch {
    throw new FileFormatError("This PDF could not be read. If it is password-protected, download it again without a password.");
  } finally {
    await textParser.destroy();
  }
  const tables: PdfContent["tables"] = [];
  // Table detection draws the page's lines; without a canvas some PDFs cannot be measured. Text lines still work.
  const tableParser = new PDFParse({ data: data.slice() });
  try {
    const res = await tableParser.getTable();
    for (const p of res.pages) for (const t of p.tables) tables.push({ page: p.num, rows: t.map((r) => r.map((c) => String(c ?? ""))) });
  } catch {
    tables.length = 0;
  } finally {
    await tableParser.destroy().catch(() => {});
  }
  return { pages, tables, text: pages.map((p) => p.text).join("\n") };
}
