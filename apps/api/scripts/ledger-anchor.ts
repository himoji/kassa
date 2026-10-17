#!/usr/bin/env bun
/*
 * `bun run ledger:anchor`: write every signed ledger checkpoint not yet anchored to an EVM testnet as the input data of
 * a zero-value self-transaction (src/modules/ledger/anchor.ts), record each one in the ledger (LEDGER_ANCHORED), and
 * keep the list in docs/evidence/anchors.json.
 *
 * Env: ANCHOR_PRIVATE_KEY (0x…, a testnet-only account with test ETH), ANCHOR_CHAIN (sepolia | holesky, default
 * sepolia), ANCHOR_RPC_URL (default: the chain's public RPC), ANCHOR_EXPLORER_URL (optional).
 * Exits 1 if a checkpoint was rewritten after it was anchored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";

import { closeDb, getDb } from "../src/db/client.ts";
import {
  ANCHOR_DOMAIN,
  anchorChain,
  anchorCheckpoints,
  listCheckpoints,
  viemAnchorClient,
  type AnchorEvidence,
} from "../src/modules/ledger/anchor.ts";
import { ledger } from "../src/modules/ledger/index.ts";

const privateKey = process.env.ANCHOR_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  console.error("Set ANCHOR_PRIVATE_KEY to a 0x-prefixed 32-byte hex key of a testnet-only account with test ETH.");
  process.exit(2);
}
const chain = anchorChain(process.env.ANCHOR_CHAIN ?? "sepolia");
const client = viemAnchorClient({
  chain,
  rpcUrl: process.env.ANCHOR_RPC_URL,
  privateKey: privateKey as Hex,
  explorerUrl: process.env.ANCHOR_EXPLORER_URL,
});

const dir = fileURLToPath(new URL("../../../docs/evidence/", import.meta.url));
const file = `${dir}anchors.json`;
const prior: AnchorEvidence | null = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as AnchorEvidence) : null;
const existing = prior?.anchors ?? [];

const checkpoints = await listCheckpoints(getDb());
console.log(`${checkpoints.length} checkpoint(s); anchoring on ${client.network} (chain ${client.chainId}) from ${client.account}`);
const { added, conflicts } = await anchorCheckpoints(checkpoints, existing, client);
for (const a of added) {
  await ledger.append("LEDGER_ANCHORED", {
    seq: a.seq,
    headHash: a.headHash,
    keyId: a.keyId,
    chainId: a.chainId,
    txHash: a.txHash,
    blockNumber: a.blockNumber,
  });
  console.log(`  seq ${a.seq} -> ${a.explorerUrl ?? a.txHash}`);
}

const evidence: AnchorEvidence = {
  domain: ANCHOR_DOMAIN,
  network: client.network,
  chainId: client.chainId,
  account: client.account,
  anchors: [...existing, ...added].sort((x, y) => x.chainId - y.chainId || x.seq - y.seq),
};
mkdirSync(dir, { recursive: true });
writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${added.length} new anchor(s); ${evidence.anchors.length} in docs/evidence/anchors.json`);

await closeDb();
if (conflicts.length > 0) {
  console.error(`checkpoint(s) ${conflicts.map((c) => c.seq).join(", ")} differ from their anchors: the ledger was rewritten`);
  process.exit(1);
}
