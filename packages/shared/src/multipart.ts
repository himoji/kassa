/**
 * A multipart/form-data body built by hand (RFC 7578). On native, `fetch` is expo/fetch, which rejects React Native's
 * `{ uri, name, type }` FormData parts ("Unsupported FormDataPart implementation") before anything is sent; the import
 * upload reads each picked file's bytes and sends this body instead, which every fetch accepts. Pure, so it is tested.
 */
export type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; type: string; bytes: Uint8Array };

const quoted = (s: string) => s.replace(/["\r\n\\]/g, "_");

export function multipartBody(parts: MultipartPart[], boundary: string): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\ncontent-disposition: form-data; name="${quoted(p.name)}"`;
    if ("bytes" in p) {
      // The name as UTF-8, as browsers send it (the API decodes parameters as UTF-8), so "Выписка.pdf" keeps its name.
      head += `; filename="${quoted(p.filename)}"\r\ncontent-type: ${p.type}`;
    }
    chunks.push(enc.encode(`${head}\r\n\r\n`));
    chunks.push("bytes" in p ? p.bytes : enc.encode(p.value));
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function newBoundary(): string {
  let s = "----KassaImport";
  for (let i = 0; i < 24; i++)
    s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)];
  return s;
}
