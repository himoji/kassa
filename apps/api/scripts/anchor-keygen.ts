#!/usr/bin/env bun
/*
 * `bun run ledger:anchor:keygen`: makes a fresh, testnet-only anchor account for ANCHOR_PRIVATE_KEY.
 * The key goes to .anchor-key at the repo root (gitignored, mode 600) and is never printed; this prints the address
 * to fund from a Sepolia faucet and the commands that hand the key to Vercel. An existing .anchor-key is kept, so
 * running it again only re-prints the address.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const file = resolve(import.meta.dir, "../../../.anchor-key");
const created = !existsSync(file);
if (created) {
  writeFileSync(file, generatePrivateKey(), { mode: 0o600 });
  chmodSync(file, 0o600);
}
const key = readFileSync(file, "utf8").trim() as `0x${string}`;
const { address } = privateKeyToAccount(key);

console.log(`${created ? "Created" : "Kept"} .anchor-key (testnet only; never reuse it on mainnet).

1. Fund ${address} with a little Sepolia ETH (0.01 is plenty), for example:
     https://cloud.google.com/application/web3/faucet/ethereum/sepolia
     https://sepolia-faucet.pk910.de/?address=${address}
2. Check it: https://sepolia.etherscan.io/address/${address}
3. Anchor from this machine:     ANCHOR_PRIVATE_KEY=$(cat .anchor-key) bun run ledger:anchor
   Or schedule it on Vercel:      vercel env add ANCHOR_PRIVATE_KEY production < .anchor-key
                                  vercel deploy --prod
4. Confirm:                       curl -s https://<your-deployment>/api/public/anchors   ("scheduled": true)`);
