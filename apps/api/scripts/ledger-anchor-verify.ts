#!/usr/bin/env bun
/*
 * `bun run ledger:anchor:verify`: re-read every transaction in docs/evidence/anchors.json from the chain and check its
 * memo against the record and against the ledger's current checkpoints. Needs no key. `--no-db` checks the chain
 * against the evidence file only (for a reviewer without the database). Exits 1 on any mismatch.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { closeDb, getDb } from "../src/db/client.ts";
import { anchorChain, listCheckpoints, verifyAnchors, viemReader, type AnchorEvidence } from "../src/modules/ledger/anchor.ts";

const file = fileURLToPath(new URL("../../../docs/evidence/anchors.json", import.meta.url));
const evidence = JSON.parse(readFileSync(file, "utf8")) as AnchorEvidence;
const chain = anchorChain(process.env.ANCHOR_CHAIN ?? (evidence.network.toLowerCase() === "holesky" ? "holesky" : "sepolia"));
const useDb = !process.argv.includes("--no-db");

const checkpoints = useDb ? await listCheckpoints(getDb()) : undefined;
const checks = await verifyAnchors(evidence.anchors, viemReader({ chain, rpcUrl: process.env.ANCHOR_RPC_URL }), checkpoints);
const ok = checks.length > 0 && checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, network: evidence.network, againstLedger: useDb, checks }, null, 2));
if (useDb) await closeDb();
process.exit(ok ? 0 : 1);
