import { eq } from "drizzle-orm";

import type { ReaderDocType } from "@kassa/shared";

import { getDb } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
import { agentDocuments } from "../../db/schema.intel.ts";
import { currentAgentMode, recordingEnabled } from "../ai/mode.ts";
import { DocumentError, loadDocument, sourceOf } from "./documents.ts";
import type { UntrustedSource } from "./extract.ts";
import { readUntrusted as readCore, type ReadOptions } from "./reader.ts";
import type { ReaderResult } from "./schemas.ts";

/*
 * Reader public API: readDocument(docId), readUntrusted(kind, source).
 * The Reader is the only path for untrusted text (I10). LIVE/REPLAY/RECORD follow the agent mode.
 */

export type { ReaderResult, ReaderChecks } from "./schemas.ts";
export type { UntrustedSource } from "./extract.ts";
export { verifyExtraction, READER_INSTRUCTIONS } from "./reader.ts";
export { storeDocument, loadDocument, DocumentError, MAX_DOCUMENT_BYTES, ACCEPTED_MEDIA_TYPES } from "./documents.ts";

async function modeOptions(opts: ReadOptions): Promise<ReadOptions> {
  if (opts.model) return opts;
  const replay = (await currentAgentMode()) === "REPLAY";
  return { ...opts, replay, record: !replay && recordingEnabled() };
}

/** Read any untrusted content (email, notification text, screenshot) of a known kind. */
export async function readUntrusted(kind: ReaderDocType, source: UntrustedSource | string, opts: ReadOptions = {}): Promise<ReaderResult> {
  const src: UntrustedSource = typeof source === "string" ? { type: "text", text: source } : source;
  return readCore(kind, src, await modeOptions(opts));
}

/** The user's own names as the Reader's payee check knows them (users.displayName; there is no separate legal name). */
async function accountHolderNames(userId: string): Promise<string[]> {
  const u = (await getDb().select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)))[0];
  return u?.displayName ? [u.displayName] : [];
}

/** Read an uploaded document (cached per doc). `kind` defaults to the upload's kind, else invoice. */
export async function readDocument(docId: string, opts: ReadOptions & { userId?: string; kind?: ReaderDocType } = {}): Promise<ReaderResult> {
  const row = await loadDocument(docId, opts.userId);
  if (!row) throw new DocumentError("DOC_NOT_FOUND", "Document not found");
  const kind = opts.kind ?? row.kind ?? "invoice";
  if (row.readerResult && (row.readerResult as { kind?: string }).kind === kind) return row.readerResult as unknown as ReaderResult;
  // The reader's own name is never accepted as an invoice's payee (the "Bill to" person, not the creditor).
  const holder = opts.accountHolderNames ?? (await accountHolderNames(row.userId));
  const result = await readCore(kind, sourceOf(row), { ...(await modeOptions(opts)), accountHolderNames: holder });
  await getDb()
    .update(agentDocuments)
    .set({ kind, readerResult: result as unknown as Record<string, unknown> })
    .where(eq(agentDocuments.id, docId));
  return result;
}
