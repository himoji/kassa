#!/usr/bin/env bun
/*
 * `bun run ledger:anchor:verify`: re-read every transaction in docs/evidence/anchors.json from the chain and check its
 * memo against the record and against the ledger's current checkpoints. Needs no key. `--no-db` checks the chain
 * against the evidence file only (for a reviewer without the database). Exits 1 on any mismatch.
 *
 * `--url <origin>` (2026-10-19): a deployment's scheduled anchors instead of the evidence file (GET <origin>/api/public/anchors,
 * ledger/autoAnchor.ts): each transaction on the chain against the record, and the deployment's current checkpoint at
 * that seq against the chain. Needs neither the database nor a key.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { closeDb, getDb } from "../src/db/client.ts";
import { anchorChain, listCheckpoints, verifyAnchors, viemReader, type AnchorEvidence, type AnchorRecord, type CheckpointRef } from "../src/modules/ledger/anchor.ts";

const urlArg = process.argv.indexOf("--url");
const origin = urlArg >= 0 ? process.argv[urlArg + 1]?.replace(/\/+$/, "") : undefined;

type PublicAnchors = { network: string; chainId: number; account: string | null; anchors: (AnchorRecord & { ledgerHeadHash: string | null })[] };

let source: string;
let network: string;
let anchors: AnchorRecord[];
let checkpoints: CheckpointRef[] | undefined;
const useDb = !origin && !process.argv.includes("--no-db");

if (origin) {
  const res = await fetch(`${origin}/api/public/anchors`);
  if (!res.ok) {
    console.error(`GET ${origin}/api/public/anchors answered ${res.status}`);
    process.exit(2);
  }
  const body = (await res.json()) as PublicAnchors;
  source = `${origin}/api/public/anchors`;
  network = body.network;
  anchors = body.anchors;
  // The deployment's current checkpoint at each anchored seq (absent = the ledger no longer has it).
  checkpoints = body.anchors.flatMap((a) => (a.ledgerHeadHash ? [{ seq: a.seq, headHash: a.ledgerHeadHash, keyId: a.keyId }] : []));
} else {
  const file = fileURLToPath(new URL("../../../docs/evidence/anchors.json", import.meta.url));
  const evidence = JSON.parse(readFileSync(file, "utf8")) as AnchorEvidence;
  source = "docs/evidence/anchors.json";
  network = evidence.network;
  anchors = evidence.anchors;
  checkpoints = useDb ? await listCheckpoints(getDb()) : undefined;
}

const chain = anchorChain(process.env.ANCHOR_CHAIN ?? (network.toLowerCase() === "holesky" ? "holesky" : "sepolia"));
const checks = await verifyAnchors(anchors, viemReader({ chain, rpcUrl: process.env.ANCHOR_RPC_URL }), checkpoints);
const ok = checks.length > 0 && checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, source, network, againstLedger: checkpoints !== undefined, checks }, null, 2));
if (useDb) await closeDb();
process.exit(ok ? 0 : 1);
