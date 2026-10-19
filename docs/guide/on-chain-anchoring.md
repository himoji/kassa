# On-chain anchoring

Every 20 ledger entries Kassa writes a checkpoint signed with Ed25519. `bun run ledger:anchor` publishes each checkpoint not yet anchored on an EVM testnet (Sepolia by default): a zero-value transaction from the anchor account to itself, with the plain-text memo

```text
kassa:ledger-anchor:v1:<seq>:<headHash>:<keyId>
```

as its input data, so a block explorer shows it as text. It also adds a `LEDGER_ANCHORED` entry to the ledger and keeps the list, with explorer links, in `docs/evidence/anchors.json`.

```bash
ANCHOR_PRIVATE_KEY=0x... bun run ledger:anchor     # a testnet-only account with a little test ETH from a faucet
bun run ledger:anchor:verify                       # chain vs. evidence file vs. current ledger; exits 1 on any mismatch
bun run ledger:anchor:verify --no-db               # chain vs. evidence file only, for a reviewer without the database
bun run ledger:anchor:verify --url https://kassa-judge.vercel.app   # a live deployment's anchors, no database or key
```

## Turn it on for a deployment

Four steps, about five minutes. The key never needs to be pasted or printed.

```bash
bun run ledger:anchor:keygen                                   # writes .anchor-key (gitignored), prints its address and faucet links
# fund that address with ~0.01 Sepolia ETH from a faucet, then:
vercel env add ANCHOR_PRIVATE_KEY production < .anchor-key     # in the linked Vercel project (e.g. kassa-judge)
vercel deploy --prod
curl -s https://kassa-judge.vercel.app/api/public/anchors      # "scheduled": true; the first anchor lands within ANCHOR_INTERVAL_MINUTES
```

To anchor once from your own machine instead: `ANCHOR_PRIVATE_KEY=$(cat .anchor-key) bun run ledger:anchor`.

## Published anchors

The two signed checkpoints of a `bun run sim story` ledger (seq 20 and 40), on Sepolia from `0x0a65C50fe68977eB9b62673446eB9581A000f464`:

| Seq | Transaction |
| --- | --- |
| 20 | [0x83b2b7b9…a36fba13](https://sepolia.etherscan.io/tx/0x83b2b7b9adaec23116b02ee00663d5437d8e5220977a0a70716ef364a36fba13) |
| 40 | [0xd889b246…39848b2d](https://sepolia.etherscan.io/tx/0xd889b2467b7d646b0c30d89c033da8193e3bb0d3ca378214a75610ab39848b2d) |

They are listed in [`anchors.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/anchors.json) and verified against that ledger in [`ledger-verify.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/ledger-verify.json).

## Options

| Variable | Meaning |
| --- | --- |
| `ANCHOR_PRIVATE_KEY` | Testnet-only key. Unset: nothing is anchored and `GET /api/public/anchors` says `"scheduled": false` |
| `ANCHOR_CHAIN` | `sepolia` (default) or `holesky` |
| `ANCHOR_RPC_URL` | Defaults to `https://ethereum-sepolia-rpc.publicnode.com` on Sepolia (viem's own default often never answers) and the chain's public RPC on Holesky |
| `ANCHOR_EXPLORER_URL` | Base of the explorer links |
| `ANCHOR_INTERVAL_MINUTES` | Scheduled anchoring on a deployment: at most one anchor per interval (default 60) |

## Scheduled anchoring

With `ANCHOR_PRIVATE_KEY` set on a deployment, its scheduler anchors the newest signed checkpoint at most once per `ANCHOR_INTERVAL_MINUTES`. That checkpoint's hash covers every entry before it, so one transaction per interval anchors the whole ledger so far. A checkpoint rewritten after it was anchored stops the job (`LEDGER_ANCHOR_CONFLICT`). `GET /api/public/anchors` lists the anchors with explorer links. Its `signer` field says whether the anchor account can pay the gas: `"funded": false` with a note means the account has no test ETH, so every scheduled anchor fails and the list stays empty until it is funded; `"funded": null` means the RPC did not answer (set `ANCHOR_RPC_URL`).

## What it proves, and what it does not

- A checkpoint changed or removed after it was anchored no longer matches its transaction, and a mined transaction cannot be edited. It closes the rollback gap (risk R28 in the [self-assessment](../security/self-assessment.md)) up to the last anchored checkpoint.
- No money or tokens move (value 0, test gas only), no personal data goes on chain (only the checkpoint hash and key id), and the anchor key is separate from every Kassa signing key.

Code: `apps/api/src/modules/ledger/anchor.ts`, `autoAnchor.ts`, `apps/api/scripts/ledger-anchor.ts`, `ledger-anchor-verify.ts`, `anchor-keygen.ts`; tests: `apps/api/test/core/ledger-anchor.test.ts`.
