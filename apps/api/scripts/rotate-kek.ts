#!/usr/bin/env bun
/*
 * `bun scripts/rotate-kek.ts [--dry-run]` (R15): re-wrap every user_keys row from the old USER_KEK to the new one in
 * one transaction (privacy/keys.ts, `rewrapUserKeys`). Personal ledger fields are sealed under the per-user DEKs,
 * which do not change, so nothing else is rewritten and `ledger:verify` is unaffected.
 *
 * Keys come from the environment, never from arguments (shell history, process list):
 *   USER_KEK_PREVIOUS = the old KEK, USER_KEK = the new KEK (both 32 bytes, base64), DATABASE_URL as for the API.
 * Procedure: deploy the API with USER_KEK=new and USER_KEK_PREVIOUS=old (it wraps with the new KEK and still unwraps
 * rows of the old one), run this script with --dry-run, then without, then remove USER_KEK_PREVIOUS.
 * Prints the KEK ids (public: a truncated SHA-256) and row counts; never a key. Exit 1 on any error (nothing written).
 */
import { closeDb } from "../src/db/client.ts";
import { envKeyProvider, rewrapUserKeys, type RewrapReport } from "../src/modules/privacy/keys.ts";

export async function rotateKek(argv: readonly string[], vars: Readonly<Record<string, string | undefined>>, log: (line: string) => void = console.log): Promise<RewrapReport> {
  const unknown = argv.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) throw new Error(`unknown argument ${unknown[0]} (usage: rotate-kek.ts [--dry-run])`);
  const dryRun = argv.includes("--dry-run");
  if (!vars.USER_KEK_PREVIOUS || !vars.USER_KEK) throw new Error("set USER_KEK_PREVIOUS (old KEK) and USER_KEK (new KEK)");
  const from = envKeyProvider(vars.USER_KEK_PREVIOUS, undefined, "USER_KEK_PREVIOUS");
  const to = envKeyProvider(vars.USER_KEK, undefined, "USER_KEK");
  log(`${dryRun ? "dry run: " : ""}re-wrapping user keys from KEK ${from.kekId()} to KEK ${to.kekId()}`);
  const r = await rewrapUserKeys(from, to, { dryRun });
  log(`rows: ${r.total}; re-wrapped${dryRun ? " (not written)" : ""}: ${r.rewrapped}; already on the new KEK: ${r.alreadyCurrent}; shredded (left as is): ${r.shredded}`);
  return r;
}

if (import.meta.main) {
  try {
    await rotateKek(process.argv.slice(2), process.env);
    await closeDb();
  } catch (err) {
    console.error(`rotate-kek: ${(err as Error).message}`);
    await closeDb();
    process.exit(1);
  }
}
