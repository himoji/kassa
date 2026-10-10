/**
 * Local data: export and wipe (GDPR access / erasure, on-device half).
 *
 * `exportLocalData` returns what the storage adapter holds as pretty JSON,
 * minus anything that works as a credential (auth tokens, secrets), plus the
 * signed-in user's profile when you pass it; `shareDataExport` writes it to
 * `my-data-<date>.json` and opens the share sheet. `wipeLocalData` removes
 * every key except the user's UI preferences and the consent decision, resets
 * the analytics identity and runs the `onWipeLocalData` hooks (the data module
 * clears its cache there). `useSignOutCleanup` (root layout) runs it on every
 * sign-out. Server-side data (the account, your tables, analytics vendors) is
 * the auth module's `deleteAccount()`, `@/lib/account-data` and your backend's
 * job - see docs/privacy.
 */
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

import { analytics } from "@/lib/analytics";
import { shareText } from "@/lib/share";
import type { AuthUser } from "@/lib/auth";
import { storage } from "@/lib/storage";

/** Preferences that should survive a wipe: they are the user's, not about the user. */
export const WIPE_KEEP_KEYS: readonly string[] = [
  "readynative:theme-mode",
  "readynative:language",
  "readynative:consent",
  "readynative:onboarding",
];

/**
 * Storage keys that hold credentials, never exported (Supabase keeps its session under
 * `sb-<project>-auth-token`). A credential in a shared file is a session anyone can use.
 */
export const EXPORT_SECRET_KEY = /auth-token|token|secret|password|credential|cookie|api[-_]?key/i;

/** Property names redacted wherever they appear inside an exported value. */
const SECRET_FIELD =
  /^(access_?token|refresh_?token|provider_?token|provider_?refresh_?token|id_?token|session_?token|token|secret|client_?secret|password|cookie|api_?key)$/i;

const REDACTED = "[redacted]";

async function allKeys(): Promise<string[]> {
  if (!storage.keys) {
    throw new Error("The storage adapter has no keys(); add it to export or wipe local data");
  }
  return storage.keys();
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_FIELD.test(key) ? REDACTED : redact(inner);
  }
  return out;
}

export interface ExportOptions {
  /** The signed-in user (`auth.useSession().user`); exported as `account`. */
  user?: AuthUser | null;
  now?: Date;
}

export async function exportLocalData(opts: ExportOptions = {}): Promise<string> {
  const data: Record<string, unknown> = {};
  for (const key of (await allKeys()).sort()) {
    if (EXPORT_SECRET_KEY.test(key)) continue;
    const raw = await storage.getItem(key);
    if (raw === null) continue;
    try {
      data[key] = redact(JSON.parse(raw) as unknown);
    } catch {
      data[key] = raw;
    }
  }
  const exportedAt = (opts.now ?? new Date()).toISOString();
  const account = opts.user ? { account: { ...opts.user } } : {};
  return JSON.stringify({ exportedAt, ...account, data }, null, 2);
}

/** `my-data-2026-09-24.json` */
export function exportFileName(now = new Date()): string {
  return `my-data-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Writes the export to the cache directory and opens the share sheet with the file
 * (save to Files, AirDrop, mail…). Web and devices without a share target get the JSON
 * as text instead. Resolves `true` when a sheet was shown.
 */
export async function shareDataExport(
  json: string,
  opts: { title?: string; now?: Date } = {}
): Promise<boolean> {
  if (Platform.OS !== "web" && (await Sharing.isAvailableAsync())) {
    const file = new File(Paths.cache, exportFileName(opts.now));
    file.create({ overwrite: true });
    file.write(json);
    try {
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/json",
        UTI: "public.json",
        dialogTitle: opts.title,
      });
    } finally {
      // The share sheet has handed the file over (or was dismissed); no copy stays behind.
      deleteQuietly(file);
    }
    return true;
  }
  return shareText({ message: json, title: opts.title });
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch (err) {
    console.warn("[privacy] could not delete", file.uri, err);
  }
}

/** Export files left in the cache (an interrupted share); removed on every wipe. */
export function deleteExportFiles(): void {
  if (Platform.OS === "web") return;
  try {
    for (const entry of Paths.cache.list()) {
      if (entry instanceof File && /^my-data-.*\.json$/.test(entry.name)) deleteQuietly(entry);
    }
  } catch (err) {
    console.warn("[privacy] could not list the cache directory", err);
  }
}

export interface WipeOptions {
  /** Keys to leave in place; defaults to `WIPE_KEEP_KEYS`. */
  keep?: readonly string[];
}

type WipeHook = () => void | Promise<void>;

const wipeHooks = new Set<WipeHook>();

/**
 * Run `hook` on every wipe (sign-out, account deletion). The data module clears its
 * query cache here so the next user never sees the previous user's responses.
 */
export function onWipeLocalData(hook: WipeHook): () => void {
  wipeHooks.add(hook);
  return () => {
    wipeHooks.delete(hook);
  };
}

/**
 * Deletes per key rather than `clear()`, so persisted stores that are still in
 * memory (theme, onboarding, consent) never race a full clear and re-write
 * stale state.
 */
export async function wipeLocalData(opts: WipeOptions = {}): Promise<string[]> {
  const keep = new Set(opts.keep ?? WIPE_KEEP_KEYS);
  const removed: string[] = [];
  for (const key of await allKeys()) {
    if (keep.has(key)) continue;
    await storage.removeItem(key);
    removed.push(key);
  }
  deleteExportFiles();
  // The analytics module keeps the user's opt-out across its own reset.
  analytics.reset();
  // Every hook runs even when one fails; the first failure is rethrown afterwards.
  let failure: unknown;
  for (const hook of wipeHooks) {
    try {
      await hook();
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure !== undefined) throw failure;
  return removed;
}
