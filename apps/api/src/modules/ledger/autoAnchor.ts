/*
 * (added 2026-10-19) Scheduled anchoring of the deployment's own ledger (anchor.ts), for a build reviewers use (the
 * judge build) rather than a ledger anchored once by hand (`bun run ledger:anchor`).
 *
 * With ANCHOR_PRIVATE_KEY set, the scheduler (scheduler/index.ts, job "ledgerAnchor") anchors at most once per
 * ANCHOR_INTERVAL_MINUTES, across every instance (a shared counter, http/rate-limit-store.ts): only the newest signed
 * checkpoint not anchored yet. Its headHash covers every entry before it (the chain), so one transaction per interval
 * anchors the whole ledger up to it and keeps the test gas small. Each anchor is a LEDGER_ANCHORED ledger entry; those
 * entries are the anchor list (GET /api/public/anchors, `bun run ledger:anchor:verify --url <origin>`).
 *
 * A checkpoint that differs from what was anchored for its seq (the ledger was rewritten after anchoring) stops the
 * job: anchoring past it would hide the rewrite. It is ledgered once as LEDGER_ANCHOR_CONFLICT.
 */
import { privateKeyToAccount } from "viem/accounts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Hex } from "viem";

import { getDb, type DbOrTx } from "../../db/client.ts";
import { ledgerEntries } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { incrCounter } from "../../http/rate-limit-store.ts";
import { ANCHOR_DOMAIN, anchorChain, anchorCheckpoints, listCheckpoints, viemAnchorClient, type AnchorClient, type AnchorRecord } from "./anchor.ts";
import { ledger } from "./index.ts";

/** Every anchor recorded in the ledger (LEDGER_ANCHORED), oldest first. */
export async function anchorsInLedger(db: DbOrTx = getDb()): Promise<AnchorRecord[]> {
  const rows = await db.select({ payload: ledgerEntries.payload }).from(ledgerEntries).where(eq(ledgerEntries.type, "LEDGER_ANCHORED")).orderBy(ledgerEntries.seq);
  return rows.map((r) => {
    const p = r.payload as Omit<AnchorRecord, "explorerUrl"> & { explorerUrl?: string | null };
    return { seq: p.seq, headHash: p.headHash, keyId: p.keyId, chainId: p.chainId, txHash: p.txHash, blockNumber: p.blockNumber, explorerUrl: p.explorerUrl ?? null };
  });
}

export type AutoAnchorResult =
  | { kind: "anchored"; anchor: AnchorRecord }
  | { kind: "up-to-date"; seq: number | null }
  | { kind: "conflict"; seqs: number[] };

/** Anchors the newest checkpoint if it has no anchor on the client's chain (see top). */
export async function anchorNewestCheckpoint(client: AnchorClient, db: DbOrTx = getDb()): Promise<AutoAnchorResult> {
  const checkpoints = await listCheckpoints(db);
  const existing = (await anchorsInLedger(db)).filter((a) => a.chainId === client.chainId);
  const bySeq = new Map(checkpoints.map((c) => [c.seq, c]));
  const rewritten = existing.filter((a) => {
    const cp = bySeq.get(a.seq);
    return cp !== undefined && (cp.headHash !== a.headHash || cp.keyId !== a.keyId);
  });
  if (rewritten.length > 0) {
    const seqs = rewritten.map((a) => a.seq);
    const known = await db
      .select({ seq: ledgerEntries.seq })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.type, "LEDGER_ANCHOR_CONFLICT"), sql`${ledgerEntries.payload}->>'chainId' = ${String(client.chainId)}`))
      .orderBy(desc(ledgerEntries.seq))
      .limit(1);
    if (known.length === 0) await ledger.append("LEDGER_ANCHOR_CONFLICT", { chainId: client.chainId, seqs });
    return { kind: "conflict", seqs };
  }
  const newest = checkpoints.at(-1);
  if (!newest || existing.some((a) => a.seq === newest.seq)) return { kind: "up-to-date", seq: newest?.seq ?? null };
  const { added } = await anchorCheckpoints([newest], existing, client);
  const anchor = added[0]!;
  await ledger.append("LEDGER_ANCHORED", { ...anchor, auto: true });
  return { kind: "anchored", anchor };
}

let cachedClient: AnchorClient | null = null;

function configuredClient(): AnchorClient | null {
  const e = env();
  if (!e.ANCHOR_PRIVATE_KEY) return null;
  cachedClient ??= viemAnchorClient({ chain: anchorChain(e.ANCHOR_CHAIN), rpcUrl: e.ANCHOR_RPC_URL, privateKey: e.ANCHOR_PRIVATE_KEY as Hex, explorerUrl: e.ANCHOR_EXPLORER_URL });
  return cachedClient;
}

/** Scheduler job: nothing without ANCHOR_PRIVATE_KEY; otherwise one anchor per interval for the whole deployment. */
export async function autoAnchorTick(client: AnchorClient | null = configuredClient()): Promise<AutoAnchorResult | null> {
  if (!client) return null;
  const windowMs = env().ANCHOR_INTERVAL_MINUTES * 60_000;
  const hit = await incrCounter("job:ledger-anchor", String(client.chainId), windowMs);
  if (hit.current > 1) return null;
  return anchorNewestCheckpoint(client);
}

/** How long the public list waits for the signer's balance before it reports it as unknown. */
const BALANCE_TIMEOUT_MS = 3_000;

/**
 * (2026-10-19) The anchor account pays the gas: with no test ETH every scheduled anchor fails and the list stays empty
 * with no sign of why. The public list says whether the account can pay (null: the RPC did not answer in time).
 */
async function signerStatus(client: AnchorClient): Promise<{ balanceWei: string | null; funded: boolean | null; note: string | null }> {
  if (!client.balance) return { balanceWei: null, funded: null, note: null };
  const balance = await Promise.race([client.balance().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), BALANCE_TIMEOUT_MS).unref?.())]);
  if (balance === null) return { balanceWei: null, funded: null, note: "The chain's RPC did not answer; set ANCHOR_RPC_URL to a reliable endpoint." };
  const funded = balance > 0n;
  return { balanceWei: balance.toString(), funded, note: funded ? null : `The anchor account ${client.account} has no test ETH for gas, so scheduled anchors cannot be sent until it is funded.` };
}

/** GET /api/public/anchors: what was anchored, where, and whether this deployment anchors on a schedule. */
export async function publicAnchors(client: AnchorClient | null = configuredClient()) {
  const e = env();
  const chain = anchorChain(e.ANCHOR_CHAIN);
  const db = getDb();
  const [anchors, checkpoints, signer] = await Promise.all([anchorsInLedger(db), listCheckpoints(db), client ? signerStatus(client) : null]);
  const onChain = anchors.filter((a) => a.chainId === chain.id);
  return {
    domain: ANCHOR_DOMAIN,
    network: chain.name,
    chainId: chain.id,
    scheduled: Boolean(e.ANCHOR_PRIVATE_KEY),
    account: e.ANCHOR_PRIVATE_KEY ? privateKeyToAccount(e.ANCHOR_PRIVATE_KEY as Hex).address : null,
    intervalMinutes: e.ANCHOR_INTERVAL_MINUTES,
    signer,
    latestCheckpoint: checkpoints.at(-1) ?? null,
    // Newest first; each with the ledger's current checkpoint at that seq, so a reader can compare it with the chain.
    anchors: onChain
      .slice(-100)
      .reverse()
      .map((a) => ({ ...a, ledgerHeadHash: checkpoints.find((c) => c.seq === a.seq)?.headHash ?? null })),
  };
}
