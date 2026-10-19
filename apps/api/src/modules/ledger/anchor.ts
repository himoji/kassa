/*
 * Public-chain anchoring of signed ledger checkpoints (challenge bonus, on-chain exploration).
 *
 * Each checkpoint (seq, headHash, keyId) is written as the UTF-8 input data of a zero-value transaction from the
 * anchor account to itself on an EVM testnet (Sepolia by default). The memo is plain text, so a block explorer shows
 * it as-is. Anyone can later compare the memo with the ledger: an entry rewritten before seq changes headHash and no
 * longer matches the transaction, and a transaction cannot be edited once it is mined.
 *
 * No money moves: value is 0, the account only pays testnet gas. The anchor key is not a Kassa signing key.
 */
import { asc } from "drizzle-orm";
import {
  createPublicClient,
  createWalletClient,
  fromHex,
  http,
  toHex,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { holesky, sepolia } from "viem/chains";

import type { DbOrTx } from "../../db/client.ts";
import { ledgerCheckpoints } from "../../db/schema.ts";

export const ANCHOR_DOMAIN = "kassa:ledger-anchor:v1";

export type CheckpointRef = { seq: number; headHash: string; keyId: string };

export type AnchorRecord = CheckpointRef & {
  chainId: number;
  txHash: Hex;
  blockNumber: number;
  explorerUrl: string | null;
};

export type AnchorEvidence = {
  domain: typeof ANCHOR_DOMAIN;
  network: string;
  chainId: number;
  account: Hex;
  anchors: AnchorRecord[];
};

/** The one transport the anchoring needs; the viem client below implements it, tests pass a fake. */
export interface AnchorClient {
  readonly chainId: number;
  readonly network: string;
  readonly account: Hex;
  explorerTxUrl(txHash: Hex): string | null;
  /** Sends a zero-value transaction to the anchor account itself with `data` as input; resolves once mined. */
  send(data: Hex): Promise<{ txHash: Hex; blockNumber: number }>;
  /** The input data of a mined transaction, or null if the chain does not know it. */
  inputOf(txHash: Hex): Promise<Hex | null>;
}

export function anchorMemo(cp: CheckpointRef): string {
  return `${ANCHOR_DOMAIN}:${cp.seq}:${cp.headHash}:${cp.keyId}`;
}

/** Parses a memo written by anchorMemo; null for anything else. headHash and keyId are base64url (no ':'). */
export function parseAnchorMemo(memo: string): CheckpointRef | null {
  const prefix = `${ANCHOR_DOMAIN}:`;
  if (!memo.startsWith(prefix)) return null;
  const parts = memo.slice(prefix.length).split(":");
  if (parts.length !== 3) return null;
  const [seqText, headHash, keyId] = parts as [string, string, string];
  if (!/^[1-9][0-9]*$/.test(seqText) || !/^[A-Za-z0-9_-]+$/.test(headHash) || !/^[A-Za-z0-9_-]+$/.test(keyId)) {
    return null;
  }
  return { seq: Number(seqText), headHash, keyId };
}

export async function listCheckpoints(db: DbOrTx): Promise<CheckpointRef[]> {
  const rows = await db.select().from(ledgerCheckpoints).orderBy(asc(ledgerCheckpoints.seq));
  return rows.map((r) => ({ seq: r.seq, headHash: r.headHash, keyId: r.keyId }));
}

/**
 * Anchors every checkpoint that has no record yet on the client's chain. A checkpoint whose seq was anchored with a
 * different headHash is an error: the ledger was rewritten after it was anchored, and anchoring again would hide it.
 */
export async function anchorCheckpoints(
  checkpoints: CheckpointRef[],
  existing: AnchorRecord[],
  client: AnchorClient,
): Promise<{ added: AnchorRecord[]; conflicts: CheckpointRef[] }> {
  const onChain = new Map(existing.filter((a) => a.chainId === client.chainId).map((a) => [a.seq, a]));
  const added: AnchorRecord[] = [];
  const conflicts: CheckpointRef[] = [];
  for (const cp of checkpoints) {
    const prior = onChain.get(cp.seq);
    if (prior) {
      if (prior.headHash !== cp.headHash || prior.keyId !== cp.keyId) conflicts.push(cp);
      continue;
    }
    if (conflicts.length > 0) break; // never anchor past a rewritten checkpoint
    const { txHash, blockNumber } = await client.send(toHex(anchorMemo(cp)));
    added.push({ ...cp, chainId: client.chainId, txHash, blockNumber, explorerUrl: client.explorerTxUrl(txHash) });
  }
  return { added, conflicts };
}

export type AnchorCheck = { seq: number; txHash: Hex; ok: boolean; problem?: string };

/**
 * Re-reads each anchor transaction from the chain and checks its memo against the record and, when given, against
 * the ledger's current checkpoints.
 */
export async function verifyAnchors(
  anchors: AnchorRecord[],
  client: Pick<AnchorClient, "chainId" | "inputOf">,
  checkpoints?: CheckpointRef[],
): Promise<AnchorCheck[]> {
  const bySeq = checkpoints ? new Map(checkpoints.map((c) => [c.seq, c])) : null;
  const out: AnchorCheck[] = [];
  for (const a of anchors) {
    const fail = (problem: string) => out.push({ seq: a.seq, txHash: a.txHash, ok: false, problem });
    if (a.chainId !== client.chainId) {
      fail(`anchor is on chain ${a.chainId}, client is on ${client.chainId}`);
      continue;
    }
    const input = await client.inputOf(a.txHash);
    if (!input) {
      fail("transaction not found on chain");
      continue;
    }
    let memo: CheckpointRef | null = null;
    try {
      memo = parseAnchorMemo(fromHex(input, "string"));
    } catch {
      memo = null;
    }
    if (!memo) {
      fail("transaction input is not a Kassa anchor memo");
      continue;
    }
    if (memo.seq !== a.seq || memo.headHash !== a.headHash || memo.keyId !== a.keyId) {
      fail("on-chain memo differs from the anchor record");
      continue;
    }
    if (bySeq) {
      const cp = bySeq.get(a.seq);
      if (!cp) {
        fail("ledger has no checkpoint at this seq");
        continue;
      }
      if (cp.headHash !== memo.headHash || cp.keyId !== memo.keyId) {
        fail("ledger checkpoint differs from the anchored one (ledger rewritten after anchoring)");
        continue;
      }
    }
    out.push({ seq: a.seq, txHash: a.txHash, ok: true });
  }
  return out;
}

/**
 * viem's default Sepolia RPC (thirdweb) often accepts the connection and never answers, which hangs the anchor job
 * until the function times out; publicnode answers without a key. ANCHOR_RPC_URL still overrides both.
 */
const CHAINS: Record<string, Chain> = {
  sepolia: { ...sepolia, rpcUrls: { default: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] } } },
  holesky,
};

export function anchorChain(name: string): Chain {
  const chain = CHAINS[name];
  if (!chain) throw new Error(`ANCHOR_CHAIN must be one of ${Object.keys(CHAINS).join(", ")} (got "${name}")`);
  return chain;
}

function explorerFor(chain: Chain, override?: string) {
  const base = (override ?? chain.blockExplorers?.default.url)?.replace(/\/+$/, "");
  return (txHash: Hex) => (base ? `${base}/tx/${txHash}` : null);
}

/** Read-only client: enough for verifyAnchors, needs no key. */
export function viemReader(opts: { chain: Chain; rpcUrl?: string }) {
  const pub = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  return {
    chainId: opts.chain.id,
    async inputOf(txHash: Hex): Promise<Hex | null> {
      try {
        return (await pub.getTransaction({ hash: txHash })).input;
      } catch {
        return null;
      }
    },
  };
}

export function viemAnchorClient(opts: {
  chain: Chain;
  rpcUrl?: string;
  privateKey: Hex;
  explorerUrl?: string;
}): AnchorClient {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);
  const pub = createPublicClient({ chain: opts.chain, transport });
  const wallet = createWalletClient({ account, chain: opts.chain, transport });
  const reader = viemReader(opts);
  return {
    chainId: opts.chain.id,
    network: opts.chain.name,
    account: account.address,
    explorerTxUrl: explorerFor(opts.chain, opts.explorerUrl),
    async send(data) {
      const txHash = await wallet.sendTransaction({ to: account.address, value: 0n, data });
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`anchor transaction ${txHash} reverted`);
      return { txHash, blockNumber: Number(receipt.blockNumber) };
    },
    inputOf: reader.inputOf,
  };
}
