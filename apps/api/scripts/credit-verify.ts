#!/usr/bin/env bun
/*
 * `bun run credit:verify <record.json> [--key <jwks url or file>]`: check a credit record offline. The record is the
 * JSON a holder shares (GET /api/public/credit-record/<id>.json); the key is the issuer's JWKS (GET /api/public/keys,
 * a URL or a saved file). Without --key only the hash is checked. Exits 1 when anything does not verify.
 * A holder's name is bound with a keyed hash: check a name with the verify link (?name=), not offline.
 */
import { readFileSync } from "node:fs";

import { verifyCreditRecordOffline, type CreditRecordFile, type Jwks } from "../src/modules/credit-record/offline.ts";
import { jcsHash } from "@kassa/shared";

const args = process.argv.slice(2);
const keyAt = args.indexOf("--key");
const keySource = keyAt >= 0 ? args[keyAt + 1] : undefined;
const recordPath = args.find((a, i) => !a.startsWith("--") && i !== keyAt + 1);
if (!recordPath || (keyAt >= 0 && !keySource)) {
  console.error("usage: bun run credit:verify <record.json> [--key <https://…/api/public/keys | jwks.json>]");
  process.exit(2);
}

const file = JSON.parse(readFileSync(recordPath, "utf8")) as CreditRecordFile;
if (!keySource) {
  const hashMatches = jcsHash(file.bundle) === file.sha256;
  console.log(JSON.stringify({ ok: false, hashMatches, signatureChecked: false, note: "pass --key <jwks> to check the signature" }, null, 2));
  process.exit(1);
}
const jwks = (/^https?:\/\//.test(keySource) ? await (await fetch(keySource)).json() : JSON.parse(readFileSync(keySource, "utf8"))) as Jwks;
const result = verifyCreditRecordOffline(file, jwks);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
