#!/usr/bin/env bun
/*
 * `bun run ledger:verify` (spec §14, I12): recompute the hash chain, verify every checkpoint signature,
 * exit 1 on any mismatch. Writes the report to docs/evidence/ledger-verify.json (spec §19).
 * Uses LEDGER_CHECKPOINT_PUBLIC_KEY if set, else derives it from LEDGER_CHECKPOINT_KEY.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { closeDb } from "../src/db/client.ts";
import { clock } from "../src/modules/clock/index.ts";
import { ledger } from "../src/modules/ledger/index.ts";

const report = await ledger.verify();
const out = { ...report, verifiedAt: clock.now().toISOString() };
const dir = fileURLToPath(new URL("../../../docs/evidence/", import.meta.url));
try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}ledger-verify.json`, `${JSON.stringify(out, null, 2)}\n`);
} catch (err) {
  console.warn(`could not write evidence file: ${(err as Error).message}`);
}
console.log(JSON.stringify(out, null, 2));
await closeDb();
process.exit(report.ok ? 0 : 1);
