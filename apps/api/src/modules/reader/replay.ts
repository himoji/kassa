import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Base64url } from "@kassa/shared";

/*
 * Reader record/replay: the raw model extraction (before server checks) keyed by
 * base64url(sha256(kind + source)) where source = extracted text for PDFs / text, raw bytes for images, so REPLAY still runs every evidence check against the real source.
 */

export const READER_RECORDINGS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../fixtures/agent-recordings/reader");

export interface ReaderRecording {
  kind: string;
  sourceKind: "text" | "pdf" | "image";
  /** Only for images: the recorded transcription (evidence is checked against it). */
  transcript?: string;
  extraction: Record<string, unknown>;
}

export function sourceKey(kind: string, source: string | Uint8Array): string {
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
  const prefix = new TextEncoder().encode(`${kind}\u0000`);
  const all = new Uint8Array(prefix.length + bytes.length);
  all.set(prefix);
  all.set(bytes, prefix.length);
  return sha256Base64url(all);
}

export function loadReaderRecording(key: string, dir = READER_RECORDINGS_DIR): ReaderRecording | null {
  const p = resolve(dir, `${key}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as ReaderRecording;
}

export function saveReaderRecording(key: string, rec: ReaderRecording, dir = READER_RECORDINGS_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${key}.json`), `${JSON.stringify(rec, null, 2)}\n`);
}
