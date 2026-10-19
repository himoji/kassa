# Verify the ledger and anchors

Every security-relevant event (logins, payees, proposals, approvals, payments, webhooks, refusals) is a ledger entry. Entries are hash-chained over their RFC 8785 (JCS) canonical form, every 20 entries a checkpoint is signed with Ed25519, a signed head anchor catches a truncated tail, and checkpoints are anchored on Sepolia. Three commands check all of it.

## 1. The hash chain and checkpoints

Run against the local database (stop `bun run dev` first: PGlite allows one process):

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

That is a fresh seed with a few logins, so there is no checkpoint yet. The committed report for the simulated story run says:

```bash
jq '{ok, entries, checkpoints: (.checkpoints | length), problems}' docs/evidence/ledger-verify.json
```

```json
{ "ok": true, "entries": 57, "checkpoints": 2, "problems": [] }
```

::: warning
`ledger:verify` writes its report to `docs/evidence/ledger-verify.json`. Run `git checkout docs/evidence/ledger-verify.json` afterwards if you do not mean to replace the committed evidence.
:::

The command exits 1 on any mismatch: an edited payload, a removed entry, a checkpoint whose signature does not verify, or a head that does not match the signed head anchor.

## 2. The anchors on Sepolia, without a database

A reviewer can check the committed anchors against the chain with nothing but the repository:

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

It reads each transaction and compares its memo, `kassa:ledger-anchor:v1:<seq>:<headHash>:<keyId>`, with `docs/evidence/anchors.json`. You can also open the transactions on [Etherscan](https://sepolia.etherscan.io/tx/0x83b2b7b9adaec23116b02ee00663d5437d8e5220977a0a70716ef364a36fba13) and read the memo as text.

::: tip If it hangs
The default public Sepolia RPC can be slow or blocked behind some proxies. Point it at another one:

```bash
ANCHOR_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com bun run ledger:anchor:verify --no-db
```
:::

## 3. A live deployment's anchors

```bash
curl -s https://kassa-judge.vercel.app/api/public/anchors | jq '{network, scheduled, anchors: (.anchors | length)}'
bun run ledger:anchor:verify --url https://kassa-judge.vercel.app
```

`"scheduled": false` means the deployment has no `ANCHOR_PRIVATE_KEY` and anchors nothing on its own; see [On-chain anchoring](../guide/on-chain-anchoring.md).

## Try to break it

The [evidence room](https://kassa-sand.vercel.app/showcase) has an illustrative ledger you can tamper with in the browser. To try it on the real one, change one payload in the local database (for example with `psql` on a Postgres setup) and run `bun run ledger:verify` again: `ok` turns `false`, `problems` lists what no longer matches, and the command exits 1.

Code: `apps/api/src/modules/ledger/` (`internal.ts` writes entries and checkpoints, `anchor.ts` and `autoAnchor.ts` anchor them), `apps/api/scripts/ledger-verify.ts`.
