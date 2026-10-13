/** KassaLite pairing: `kassalite://pair?code=…&server=…` or a typed code → POST /auth/pair/complete. */
import { PairCompleteResponse } from "@kassa/shared";

import { api } from "@/api/client";
import { apiBaseUrl } from "@/api/config";
import { startSession } from "@/api/session";

import { applyServerUrl, loadServerUrl, normalizeServerUrl, saveServerUrl } from "./server-url";
import { saveDisplayName } from "./profile";
import { saveShortcutToken } from "./shortcut-token";

/** Pairing codes use an unambiguous upper-case alphabet; people type them in any case. */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

export function isValidCode(code: string): boolean {
  return /^[A-Z0-9]{8}$/.test(code);
}

/** The `code` / `server` of a pairing link (deep link or QR payload); null for anything else. */
export function parsePairUrl(url: string): { code: string; server: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "kassalite:" || parsed.hostname !== "pair") return null;
    const code = parsed.searchParams.get("code");
    const server = parsed.searchParams.get("server");
    return code && server ? { code, server } : null;
  } catch {
    return null;
  }
}

export class PairInputError extends Error {
  readonly field: "code" | "server";
  constructor(field: "code" | "server") {
    super(`invalid ${field}`);
    this.name = "PairInputError";
    this.field = field;
  }
}

export class PairNoSessionError extends Error {
  constructor() {
    super("pair/complete returned no tokens");
    this.name = "PairNoSessionError";
  }
}

/**
 * Redeem `code` on `server`. On success the session tokens (Keychain via the token store), the Shortcut
 * token (Keychain) and the server URL (KV) are stored and the session store flips to authenticated.
 * On failure the previous server is restored and nothing is stored.
 */
export async function completePairing(input: {
  code: string;
  server: string;
  deviceName?: string;
}): Promise<PairCompleteResponse> {
  const code = normalizeCode(input.code);
  if (!isValidCode(code)) throw new PairInputError("code");
  const server = normalizeServerUrl(input.server);
  if (!server) throw new PairInputError("server");

  const previous = await loadServerUrl();
  applyServerUrl(server);
  try {
    const result = await api.request("/auth/pair/complete", {
      method: "POST",
      json: { code, deviceName: input.deviceName },
      schema: PairCompleteResponse,
      auth: false,
    });
    if (!result.tokens) throw new PairNoSessionError();
    await saveShortcutToken(result.shortcutToken);
    // The server states its own stable origin; keep what it says when it is a valid https origin.
    const stored = normalizeServerUrl(result.serverUrl) ?? server;
    await saveServerUrl(stored);
    applyServerUrl(stored);
    await saveDisplayName(result.user.displayName);
    await startSession(result);
    return result;
  } catch (err) {
    if (previous) applyServerUrl(previous);
    else api.setBaseUrl(apiBaseUrl());
    throw err;
  }
}
