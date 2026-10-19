# Issue and verify a credit record

Proof of on-time payments for a student with no local credit history. Kassa signs a summary of the chosen period and items with Ed25519, records it in the ledger, and publishes a verify page, JSON and PDF. Only selected items are shared.

## Issue one

App: **Settings → Credit record**. API:

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

`items`: any of `INCOME`, `BILLS`, `BUDGETS`, `PAYMENTS`.

## What the reader sees

No sign-in needed:

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

The holder's full name is bound as a keyed hash: the page shows an initial and answers match/no match for a name the reader enters. `simulated: true` marks seed history, not real payments.

## Check it offline

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

`credit:verify` recomputes the RFC 8785 (JCS) SHA-256 and checks the Ed25519 signature: v3 signs `"kassa:credit-record:v3:" + sha256` with the credit record key; older records sign the bare hash with the ledger key. `--key` also takes a URL, e.g. `--key https://kassa-judge.vercel.app/api/public/keys`.

Edit one figure (e.g. `summary.billsTotal`) and rerun: `hashMatches` and `ok` turn `false`, exit code 1.

Code: `apps/api/src/modules/credit-record/`, `apps/api/scripts/credit-verify.ts`; app screen: `apps/mobile/src/app/credit-record.tsx`.
