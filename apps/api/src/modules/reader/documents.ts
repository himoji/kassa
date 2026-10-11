import { and, eq } from "drizzle-orm";

import type { ReaderDocType } from "@kassa/shared";

import { getDb } from "../../db/client.ts";
import { agentDocuments } from "../../db/schema.intel.ts";
import { clock } from "../clock/index.ts";
import { IMAGE_MEDIA_TYPES, sniffMediaType, type UntrustedSource } from "./extract.ts";

/** Upload cap (POST /agent/documents). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_MEDIA_TYPES = ["application/pdf", "text/plain", "message/rfc822", ...IMAGE_MEDIA_TYPES] as const;

export class DocumentError extends Error {
  constructor(
    readonly code: "DOC_TOO_LARGE" | "DOC_UNSUPPORTED_TYPE" | "DOC_NOT_FOUND" | "DOC_EMPTY",
    message: string,
  ) {
    super(message);
  }
}

/** Determine the media type from magic bytes first (the client's Content-Type is untrusted). */
export function resolveMediaType(data: Uint8Array, declared: string | undefined): string {
  const sniffed = sniffMediaType(data);
  if (sniffed) return sniffed;
  const d = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (d === "text/plain" || d === "message/rfc822") return d;
  // Plain UTF-8 text without a declared type is accepted as text.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return "text/plain";
  } catch {
    return d || "application/octet-stream";
  }
}

export async function storeDocument(
  userId: string,
  doc: { data: Uint8Array; mediaType?: string; filename?: string | null; kind?: ReaderDocType | null; conversationId?: string | null },
): Promise<string> {
  if (doc.data.byteLength === 0) throw new DocumentError("DOC_EMPTY", "Empty upload");
  if (doc.data.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentError("DOC_TOO_LARGE", "Documents are limited to 10 MB");
  const mediaType = resolveMediaType(doc.data, doc.mediaType);
  if (!(ACCEPTED_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new DocumentError("DOC_UNSUPPORTED_TYPE", `Unsupported document type ${mediaType}; upload a PDF, image or text`);
  }
  const rows = await getDb()
    .insert(agentDocuments)
    .values({
      userId,
      conversationId: doc.conversationId ?? null,
      filename: doc.filename ?? null,
      mediaType,
      dataB64: Buffer.from(doc.data).toString("base64"),
      kind: doc.kind ?? null,
      createdAt: clock.now(),
    })
    .returning({ id: agentDocuments.id });
  return rows[0]!.id;
}

export async function loadDocument(docId: string, userId?: string) {
  const rows = await getDb()
    .select()
    .from(agentDocuments)
    .where(userId ? and(eq(agentDocuments.id, docId), eq(agentDocuments.userId, userId)) : eq(agentDocuments.id, docId));
  return rows[0] ?? null;
}

export function sourceOf(row: { mediaType: string; dataB64: string }): UntrustedSource {
  const data = new Uint8Array(Buffer.from(row.dataB64, "base64"));
  if (row.mediaType === "application/pdf") return { type: "pdf", data };
  if (row.mediaType.startsWith("image/")) return { type: "image", data, mediaType: row.mediaType };
  return { type: "text", text: new TextDecoder().decode(data) };
}
