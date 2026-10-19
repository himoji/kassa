# On-chain anchoring

Every 20 ledger entries Kassa writes an Ed25519-signed checkpoint. `bun run ledger:anchor` publishes each unanchored checkpoint on an EVM testnet (Sepolia by default) as a zero-value self-transaction whose input data is the plain-text memo

```text
kassa:ledger-anchor:v1:<seq>:<headHash>:<keyId>
```

It also adds a `LEDGER_ANCHORED` ledger entry and records the list, with explorer links, in `docs/evidence/anchors.json`.

```bash
ANCHOR_PRIVATE_KEY=0x... bun run ledger:anchor     # a testnet-only account with a little test ETH from a faucet
bun run ledger:anchor:verify                       # chain vs. evidence file vs. current ledger; exits 1 on any mismatch
bun run ledger:anchor:verify --no-db               # chain vs. evidence file only, for a reviewer without the database
bun run ledger:anchor:verify --url https://kassa-judge.vercel.app   # a live deployment's anchors, no database or key
```

## Turn it on for a deployment

The key is never pasted or printed.

```bash
bun run ledger:anchor:keygen                                   # writes .anchor-key (gitignored), prints its address and faucet links
# fund that address with ~0.01 Sepolia ETH from a faucet, then:
vercel env add ANCHOR_PRIVATE_KEY production < .anchor-key     # in the linked Vercel project (e.g. kassa-judge)
vercel deploy --prod
curl -s https://kassa-judge.vercel.app/api/public/anchors      # "scheduled": true; the first anchor lands within ANCHOR_INTERVAL_MINUTES
```

To anchor once locally: `ANCHOR_PRIVATE_KEY=$(cat .anchor-key) bun run ledger:anchor`.

## Published anchors

The two signed checkpoints of a `bun run sim story` ledger (seq 20 and 40), on Sepolia from `0x0a65C50fe68977eB9b62673446eB9581A000f464`:

| Seq | Transaction |
| --- | --- |
| 20 | [0x83b2b7b9…a36fba13](https://sepolia.etherscan.io/tx/0x83b2b7b9adaec23116b02ee00663d5437d8e5220977a0a70716ef364a36fba13) |
| 40 | [0xd889b246…39848b2d](https://sepolia.etherscan.io/tx/0xd889b2467b7d646b0c30d89c033da8193e3bb0d3ca378214a75610ab39848b2d) |

Listed in [`anchors.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/anchors.json), verified against that ledger in [`ledger-verify.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/ledger-verify.json).

## Options

| Variable | Meaning |
| --- | --- |
| `ANCHOR_PRIVATE_KEY` | Testnet-only key. Unset: nothing anchored, `GET /api/public/anchors` says `"scheduled": false` |
| `ANCHOR_CHAIN` | `sepolia` (default) or `holesky` |
| `ANCHOR_RPC_URL` | Default `https://ethereum-sepolia-rpc.publicnode.com` on Sepolia (viem's default often never answers), the chain's public RPC on Holesky |
| `ANCHOR_EXPLORER_URL` | Base of explorer links |
| `ANCHOR_INTERVAL_MINUTES` | At most one scheduled anchor per interval (default 60) |

## Scheduled anchoring

With `ANCHOR_PRIVATE_KEY` set, the deployment's scheduler anchors the newest signed checkpoint at most once per `ANCHOR_INTERVAL_MINUTES`; its hash covers every earlier entry. A checkpoint rewritten after anchoring stops the job (`LEDGER_ANCHOR_CONFLICT`). `GET /api/public/anchors` lists anchors with explorer links. Its `signer` field says whether the anchor account can pay the gas: `"funded": false` means no test ETH, so scheduled anchors fail and the list stays empty until it is funded; `"funded": null` means the RPC did not answer (set `ANCHOR_RPC_URL`).

## What it proves, and what it does not

- A checkpoint changed or removed after anchoring no longer matches its immutable transaction. This closes the rollback gap (risk R28 in the [self-assessment](../security/self-assessment.md)) up to the last anchored checkpoint.
- No money or tokens move (value 0, test gas only), no personal data goes on chain (only checkpoint hash and key id), and the anchor key is separate from every Kassa signing key.

Code: `apps/api/src/modules/ledger/anchor.ts`, `autoAnchor.ts`, `apps/api/scripts/ledger-anchor.ts`, `ledger-anchor-verify.ts`, `anchor-keygen.ts`; tests: `apps/api/test/core/ledger-anchor.test.ts`.
