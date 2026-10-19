# Issue and verify a credit record

A student with no local credit history can show a landlord or bank that they pay on time. Kassa issues a summary of the chosen period and items, signs it with Ed25519, records it in the ledger, and publishes a verify page, a JSON file and a PDF. Only the selected items are shared.

## Issue one

In the app: **Settings → Credit record**, pick a period and what to include. Through the API:

```bash
curl -s "${auth[@]}" -H 'content-type: application/json' -H 'origin: http://localhost:8081' \
  -d '{"from":"2026-05-01","to":"2026-10-27","items":["BILLS","INCOME"]}' \
  localhost:4000/api/credit-record/export
```

```json
{
  "verifyId": "T2ZdYzfqDQrZNbujnWqknw",
  "verifyUrl": "http://localhost:8081/verify/T2ZdYzfqDQrZNbujnWqknw",
  "jsonUrl": "http://localhost:8081/api/public/credit-record/T2ZdYzfqDQrZNbujnWqknw.json",
  "pdfUrl": "http://localhost:8081/api/public/credit-record/T2ZdYzfqDQrZNbujnWqknw.pdf",
  "sha256": "Muo3LdlBjl0HQJAaW8xvBrqKW4uRrgaoa9R-KSuVY1M",
  "createdAt": "2026-10-27T09:11:22.761Z"
}
```

`items` can be any of `INCOME`, `BILLS`, `BUDGETS` and `PAYMENTS`.

## What the reader sees

The verify page, or its API, needs no sign-in:

```bash
curl -s localhost:4000/api/public/verify/T2ZdYzfqDQrZNbujnWqknw
```

```json
{
  "verifyId": "T2ZdYzfqDQrZNbujnWqknw",
  "valid": true,
  "version": 3,
  "period": { "from": "2026-05-01", "to": "2026-10-27" },
  "holder": "D.",
  "holderNameSource": "KYC",
  "items": ["BILLS", "INCOME"],
  "summary": { "monthsCovered": 6, "billsPaidOnTime": 8, "billsTotal": 8, "incomeMonths": 6 },
  "sha256": "Muo3LdlBjl0HQJAaW8xvBrqKW4uRrgaoa9R-KSuVY1M",
  "keyId": "2fdvWSMpvXt_Iij8PtgLhNiOwEXEhZM0ZAR3l9q43BA",
  "importedHistory": { "source": "seed", "simulated": true, "openedOn": "2026-03-01" },
  "simulated": true
}
```

The record binds the holder's full name as a keyed hash: the page shows only an initial, and checks a name the reader was told (match or no match) without revealing it. `simulated: true` marks history that came from seed data rather than real payments.

## Check it offline

A landlord does not have to trust Kassa's server. Save the record and the issuer's public keys, then verify locally:

```bash
curl -s localhost:4000/api/public/credit-record/T2ZdYzfqDQrZNbujnWqknw.json -o record.json
curl -s localhost:4000/api/public/keys -o jwks.json
bun run credit:verify record.json --key jwks.json
```

```json
{
  "ok": true,
  "hashMatches": true,
  "keyFound": true,
  "signatureValid": true,
  "version": 3,
  "keyId": "2fdvWSMpvXt_Iij8PtgLhNiOwEXEhZM0ZAR3l9q43BA"
}
```

`credit:verify` recomputes the RFC 8785 (JCS) SHA-256 of the bundle and checks the Ed25519 signature: version 3 signs `"kassa:credit-record:v3:" + sha256` with the credit record key; older records sign the bare hash with the ledger key. `--key` also accepts a URL, for example `--key https://kassa-judge.vercel.app/api/public/keys`.

Change one figure in the bundle (for example `summary.billsTotal`) and run it again: `hashMatches` and `ok` turn `false` and the command exits 1.

Code: `apps/api/src/modules/credit-record/`, `apps/api/scripts/credit-verify.ts`; app screen: `apps/mobile/src/app/credit-record.tsx`.
