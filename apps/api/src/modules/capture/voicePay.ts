import { decodePayeeAccount } from "@kassa/shared";
import { and, eq, isNull, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { payees } from "../../db/schema.ts";
import { decryptAccount } from "../payees/crypto.ts";

/*
 * (2026-10-20) Who "send 15 euro to my friend Anna" may go to, decided by code before the voice turn starts
 * (POST /capture/voice). Only the user's own payable payees are candidates (not archived, not BLOCKED, with an
 * account): a spoken name never reaches anyone else. A payee matches by its whole name, and a person (PERSON,
 * OWN_ACCOUNT) also by one name token of ≥ 3 letters, the same rule the planner's redaction uses (agent/redact.ts);
 * accents are ignored ("Kovacs" = "Kovács"). A whole-name match wins over first-name matches. Then Kassa-wallet friends
 * first: one matching Kassa wallet is the recipient; several of them, or several other payees with no wallet among
 * them, are ambiguous and the turn asks which one instead of drafting anything.
 *
 * This only picks a recipient for a draft. The draft itself is always passkey-only (rules passkeyOnly): nothing is paid
 * until the user approves it with their passkey in the web app.
 */

export interface VoicePayee {
  id: string;
  name: string;
  /** Another Kassa user's wallet (account KASSA:<id>): the money lands in their Kassa at once. */
  kassaWallet: boolean;
}

export type VoiceRecipient = { kind: "NONE" } | { kind: "ONE"; payee: VoicePayee } | { kind: "AMBIGUOUS"; payees: VoicePayee[] };

const NATURAL = new Set(["PERSON", "OWN_ACCOUNT"]);

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const said = (text: string, term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(term).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "u").test(text);

type Row = { id: string; name: string; kind: string; status: string; replacesPayeeId: string | null; kassaWallet: boolean };

/** Pure matcher (tests): which of `rows` the transcript names. */
export function matchVoiceRecipient(transcript: string, rows: readonly Row[]): VoiceRecipient {
  const text = fold(transcript);
  const full = rows.filter((r) => r.name.trim().length >= 2 && said(text, fold(r.name.trim())));
  const byToken = rows.filter(
    (r) => NATURAL.has(r.kind) && fold(r.name).split(/\s+/).some((tok) => tok.length >= 3 && said(text, tok)),
  );
  let found = full.length > 0 ? full : byToken;
  // An account change (I7) leaves two payees of one person while the new one cools: the verified one is meant.
  found = found.filter((c) => !found.some((d) => d !== c && (d.replacesPayeeId === c.id || c.replacesPayeeId === d.id) && d.status === "VERIFIED" && c.status !== "VERIFIED"));
  const wallets = found.filter((r) => r.kassaWallet);
  const pool = wallets.length > 0 ? wallets : found;
  const out = (r: Row): VoicePayee => ({ id: r.id, name: r.name, kassaWallet: r.kassaWallet });
  if (pool.length === 0) return { kind: "NONE" };
  if (pool.length === 1) return { kind: "ONE", payee: out(pool[0]!) };
  return { kind: "AMBIGUOUS", payees: pool.map(out) };
}

export async function voiceRecipient(userId: string, transcript: string): Promise<VoiceRecipient> {
  const rows = await getDb()
    .select()
    .from(payees)
    .where(and(eq(payees.userId, userId), isNull(payees.archivedAt), isNotNull(payees.accountEnc)));
  return matchVoiceRecipient(
    transcript,
    rows
      .filter((r) => r.status !== "BLOCKED")
      .map((r) => {
        let kassaWallet = false;
        try {
          kassaWallet = decodePayeeAccount(decryptAccount(r.userId, r.accountEnc!, r.id)).scheme === "KASSA_USER";
        } catch {
          // An account that cannot be read is not a wallet friend; it can still be named (rules check it again).
        }
        return { id: r.id, name: r.name, kind: r.kind, status: r.status, replacesPayeeId: r.replacesPayeeId, kassaWallet };
      }),
  );
}
