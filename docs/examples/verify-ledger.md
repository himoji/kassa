# Verify the ledger and anchors

Every security-relevant event (logins, payees, proposals, approvals, payments, webhooks, refusals) is a ledger entry, hash-chained over its RFC 8785 (JCS) form. Every 20 entries a checkpoint is signed with Ed25519, a signed head anchor catches a truncated tail, and checkpoints are anchored on Sepolia.

## 1. The hash chain and checkpoints

Stop `bun run dev` first (PGlite allows one process):

```bash
bun run ledger:verify
```

```json
{
  "ok": true,
  "entries": 13,
  "checkpoints": 0,
  "headHash": "UdgsnhtZ4SriF18N9GcolWHVxghP9HUTmtRwBfHWrzg",
  "headAnchorSeq": 13,
  "problems": [],
  "verifiedAt": "2026-10-19T08:00:11.750Z"
}
```

A fresh seed has no checkpoint yet. The committed report for the simulated story run:

```bash
jq '{ok, entries, checkpoints: (.checkpoints | length), problems}' docs/evidence/ledger-verify.json
```

```json
{ "ok": true, "entries": 57, "checkpoints": 2, "problems": [] }
```

::: warning
`ledger:verify` overwrites `docs/evidence/ledger-verify.json`. Run `git checkout docs/evidence/ledger-verify.json` afterwards to keep the committed evidence.
:::

Exits 1 on an edited payload, a removed entry, a bad checkpoint signature, or a head that does not match the signed head anchor.

## 2. The anchors on Sepolia, without a database

```bash
bun run ledger:anchor:verify --no-db
```

```json
{
  "ok": true,
  "source": "docs/evidence/anchors.json",
  "network": "Sepolia",
  "againstLedger": false,
  "checks": [
    { "seq": 20, "txHash": "0x83b2b7b9adaec23116b02ee00663d5437d8e5220977a0a70716ef364a36fba13", "ok": true },
    { "seq": 40, "txHash": "0xd889b2467b7d646b0c30d89c033da8193e3bb0d3ca378214a75610ab39848b2d", "ok": true }
  ]
}
```

Compares each transaction's memo, `kassa:ledger-anchor:v1:<seq>:<headHash>:<keyId>`, with `docs/evidence/anchors.json`. The memo is readable on [Etherscan](https://sepolia.etherscan.io/tx/0x83b2b7b9adaec23116b02ee00663d5437d8e5220977a0a70716ef364a36fba13).

::: tip If it hangs
The default public Sepolia RPC can be slow or blocked behind proxies:

```bash
ANCHOR_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com bun run ledger:anchor:verify --no-db
```
:::

## 3. A live deployment's anchors

```bash
curl -s https://kassa-judge.vercel.app/api/public/anchors | jq '{network, scheduled, anchors: (.anchors | length)}'
bun run ledger:anchor:verify --url https://kassa-judge.vercel.app
```

`"scheduled": false`: no `ANCHOR_PRIVATE_KEY`, so it anchors nothing itself; see [On-chain anchoring](../guide/on-chain-anchoring.md).

## Try to break it

The [evidence room](https://kassa-sand.vercel.app/showcase) has an illustrative ledger to tamper with in the browser. On the real one, change a payload in the local database (e.g. `psql` on Postgres) and rerun `bun run ledger:verify`: `ok` turns `false`, `problems` lists the mismatches, exit code 1.

Code: `apps/api/src/modules/ledger/` (`internal.ts` writes entries and checkpoints, `anchor.ts` and `autoAnchor.ts` anchor them), `apps/api/scripts/ledger-verify.ts`.
