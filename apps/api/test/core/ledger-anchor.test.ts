/* Public-chain anchoring of signed ledger checkpoints (src/modules/ledger/anchor.ts), against an in-memory chain. */
import { eq } from "drizzle-orm";
import { fromHex, keccak256, parseTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { ledgerCheckpoints, ledgerEntries } from "../../src/db/schema.ts";
import {
  ANCHOR_DOMAIN,
  anchorCheckpoints,
  anchorMemo,
  listCheckpoints,
  parseAnchorMemo,
  verifyAnchors,
  type AnchorClient,
} from "../../src/modules/ledger/anchor.ts";
import { anchorNewestCheckpoint, anchorsInLedger, autoAnchorTick, publicAnchors } from "../../src/modules/ledger/autoAnchor.ts";
import { ledger } from "../../src/modules/ledger/index.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();

function fakeChain(chainId = 11155111) {
  const txs = new Map<Hex, Hex>();
  let block = 100;
  const client: AnchorClient & { txs: Map<Hex, Hex> } = {
    chainId,
    network: "Sepolia",
    account: "0x00000000000000000000000000000000000000aa",
    txs,
    explorerTxUrl: (h) => `https://sepolia.etherscan.io/tx/${h}`,
    async send(data) {
      const txHash = keccak256(toHex(`${txs.size}:${data}`));
      txs.set(txHash, data);
      return { txHash, blockNumber: block++ };
    },
    async inputOf(txHash) {
      return txs.get(txHash) ?? null;
    },
  };
  return client;
}

async function appendEntries(n: number) {
  for (let i = 0; i < n; i++) await ledger.append("E", { i });
}

describe("ledger anchoring", () => {
  beforeEach(async () => {
    await t.reset();
  });

  it("writes a plain-text memo that parses back, and rejects anything else", () => {
    const cp = { seq: 20, headHash: "abc_DEF-123", keyId: "k-1" };
    const memo = anchorMemo(cp);
    expect(memo).toBe(`${ANCHOR_DOMAIN}:20:abc_DEF-123:k-1`);
    expect(parseAnchorMemo(fromHex(toHex(memo), "string"))).toEqual(cp);
    expect(parseAnchorMemo("hello")).toBeNull();
    expect(parseAnchorMemo(`${ANCHOR_DOMAIN}:0:abc:k`)).toBeNull();
    expect(parseAnchorMemo(`${ANCHOR_DOMAIN}:20:abc:k:extra`)).toBeNull();
    expect(parseAnchorMemo(`${ANCHOR_DOMAIN}:20:a b:k`)).toBeNull();
  });

  it("anchors each checkpoint once and verifies it against the chain and the ledger", async () => {
    await appendEntries(45);
    const chain = fakeChain();
    const cps = await listCheckpoints(getDb());
    expect(cps.map((c) => c.seq)).toEqual([20, 40]);

    const first = await anchorCheckpoints(cps, [], chain);
    expect(first.conflicts).toEqual([]);
    expect(first.added.map((a) => a.seq)).toEqual([20, 40]);
    expect(first.added[0]).toMatchObject({ chainId: 11155111, explorerUrl: expect.stringContaining("/tx/0x") });

    const again = await anchorCheckpoints(cps, first.added, chain);
    expect(again.added).toEqual([]);
    expect(chain.txs.size).toBe(2);

    const checks = await verifyAnchors(first.added, chain, cps);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("flags a checkpoint rewritten after anchoring and does not anchor past it", async () => {
    await appendEntries(45);
    const chain = fakeChain();
    const { added } = await anchorCheckpoints(await listCheckpoints(getDb()), [], chain);
    await getDb().update(ledgerCheckpoints).set({ headHash: "forged" }).where(eq(ledgerCheckpoints.seq, 20));
    await appendEntries(20); // a new checkpoint at 60

    const cps = await listCheckpoints(getDb());
    const checks = await verifyAnchors(added, chain, cps);
    expect(checks.find((c) => c.seq === 20)).toMatchObject({ ok: false, problem: expect.stringMatching(/rewritten/) });
    expect(checks.find((c) => c.seq === 40)?.ok).toBe(true);

    const next = await anchorCheckpoints(cps, added, chain);
    expect(next.conflicts.map((c) => c.seq)).toEqual([20]);
    expect(next.added).toEqual([]);
  });

  it("flags a record whose transaction is missing, foreign, or says something else", async () => {
    await appendEntries(20);
    const chain = fakeChain();
    const cps = await listCheckpoints(getDb());
    const [rec] = (await anchorCheckpoints(cps, [], chain)).added;
    const other = await chain.send(toHex("not an anchor"));

    const checks = await verifyAnchors(
      [
        { ...rec!, txHash: keccak256(toHex("missing")) },
        { ...rec!, txHash: other.txHash },
        { ...rec!, headHash: "edited-record" },
        { ...rec!, chainId: 1 },
      ],
      chain,
    );
    expect(checks.map((c) => c.problem)).toEqual([
      "transaction not found on chain",
      "transaction input is not a Kassa anchor memo",
      "on-chain memo differs from the anchor record",
      "anchor is on chain 1, client is on 11155111",
    ]);
  });

  it("puts the memo in the input of a zero-value self-transaction", async () => {
    const account = privateKeyToAccount(keccak256(toHex("kassa anchor test key")));
    const memo = anchorMemo({ seq: 20, headHash: "h", keyId: "k" });
    const signed = await account.signTransaction({
      chainId: sepolia.id,
      type: "eip1559",
      to: account.address,
      value: 0n,
      data: toHex(memo),
      nonce: 0,
      gas: 30_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    });
    const tx = parseTransaction(signed);
    expect(tx.to?.toLowerCase()).toBe(account.address.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    expect(parseAnchorMemo(fromHex(tx.data!, "string"))).toEqual({ seq: 20, headHash: "h", keyId: "k" });
  });

  it("scheduled: anchors only the newest checkpoint, once, and records it in the ledger (2026-10-19)", async () => {
    await appendEntries(45);
    const chain = fakeChain();
    const first = await anchorNewestCheckpoint(chain);
    expect(first).toMatchObject({ kind: "anchored", anchor: { seq: 40, chainId: 11155111 } });
    expect(chain.txs.size).toBe(1);
    const recorded = await anchorsInLedger();
    expect(recorded).toEqual([expect.objectContaining({ seq: 40, txHash: first.kind === "anchored" ? first.anchor.txHash : "" })]);
    expect(await anchorNewestCheckpoint(chain)).toEqual({ kind: "up-to-date", seq: 40 });

    // The recorded anchors verify against the chain and the ledger, and the public list shows them.
    expect((await verifyAnchors(recorded, chain, await listCheckpoints(getDb()))).every((c) => c.ok)).toBe(true);
    const pub = await publicAnchors();
    expect(pub).toMatchObject({ network: "Sepolia", chainId: 11155111, scheduled: false, account: null, latestCheckpoint: { seq: 40 } });
    expect(pub.anchors).toEqual([expect.objectContaining({ seq: 40, ledgerHeadHash: recorded[0]!.headHash })]);
  });

  it("scheduled: a checkpoint rewritten after anchoring stops it, ledgered once", async () => {
    await appendEntries(25);
    const chain = fakeChain();
    await anchorNewestCheckpoint(chain);
    await getDb().update(ledgerCheckpoints).set({ headHash: "forged" }).where(eq(ledgerCheckpoints.seq, 20));
    await appendEntries(20);
    expect(await anchorNewestCheckpoint(chain)).toEqual({ kind: "conflict", seqs: [20] });
    expect(await anchorNewestCheckpoint(chain)).toEqual({ kind: "conflict", seqs: [20] });
    expect(chain.txs.size).toBe(1);
    const conflicts = await getDb().select().from(ledgerEntries).where(eq(ledgerEntries.type, "LEDGER_ANCHOR_CONFLICT"));
    expect(conflicts).toHaveLength(1);
  });

  it("scheduled: off without a key; with one, at most one anchor per interval", async () => {
    await appendEntries(45);
    expect(await autoAnchorTick(null)).toBeNull();
    const chain = fakeChain();
    expect(await autoAnchorTick(chain)).toMatchObject({ kind: "anchored" });
    await appendEntries(20);
    expect(await autoAnchorTick(chain)).toBeNull();
    expect(chain.txs.size).toBe(1);
  });
});
