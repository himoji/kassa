# Call the API

The app talks to a Fastify API under `/api`. This example signs in as Dana with the development sign-in and reads her money. The full route list is in the [HTTP API reference](../reference/http-api.md).

## 1. Sign in

`POST /api/auth/dev/login` exists only with `DEMO_ENABLED=true` and `DEV_LOGIN=true` (or on the judge build). `demoClaim: true` signs in as the seeded hero, Dana; `client: "native"` returns bearer tokens instead of cookies.

```bash
curl -s localhost:4000/api/auth/dev/login \
  -H 'content-type: application/json' -H 'origin: http://localhost:8081' \
  -d '{"demoClaim":true,"client":"native"}'
```

```json
{
  "user": { "id": "c83d27e3-4e03-570f-8fea-87db32399c12", "displayName": "Dana" },
  "onboarded": false,
  "tokens": {
    "accessToken": "eyJhbGciOiJIUzI1NiJ9…",
    "accessTokenExpiresAt": "2026-10-19T07:51:53.000Z",
    "refreshToken": "eyJhbGciOiJIUzI1NiJ9…"
  }
}
```

Keep the access token for the next calls:

```bash
TOKEN=$(curl -s localhost:4000/api/auth/dev/login -H 'content-type: application/json' \
  -H 'origin: http://localhost:8081' -d '{"demoClaim":true,"client":"native"}' | jq -r .tokens.accessToken)
auth=(-H "authorization: Bearer $TOKEN")
```

::: tip Errors are RFC 9457 problem details
Every error has `type`, `title`, `status`, `detail` and a machine-readable `code`. Leaving out `client` above gives:

```json
{ "type": "/problems/VALIDATION_FAILED", "status": 400, "code": "VALIDATION_FAILED",
  "detail": "Request does not match the schema",
  "details": [{ "instancePath": "/client", "message": "Invalid option: expected one of \"web\"|\"native\"" }] }
```
:::

## 2. Balances in every currency

Money is always integer minor units (`amountMinor`), with a home-currency equivalent.

```bash
curl -s "${auth[@]}" localhost:4000/api/balances
```

```json
{
  "homeCurrency": "KZT",
  "homeTotalMinor": 142467687,
  "balances": [
    { "currency": "KZT", "amountMinor": 90000000, "homeAmountMinor": 90000000 },
    { "currency": "USD", "amountMinor": 45000, "homeAmountMinor": 20396145 },
    { "currency": "HUF", "amountMinor": 12000000, "homeAmountMinor": 16808278 },
    { "currency": "EUR", "amountMinor": 30000, "homeAmountMinor": 15263264 }
  ],
  "rateDate": "2026-10-19",
  "simulated": true
}
```

## 3. Bills, with how each one can be funded

```bash
curl -s "${auth[@]}" localhost:4000/api/obligations | jq '.obligations[0]'
```

```json
{
  "payeeName": "University in Budapest",
  "payeeStatus": "VERIFIED",
  "amountMinor": 240000,
  "currency": "EUR",
  "homeAmountMinor": 122106115,
  "dueDate": "2026-10-31",
  "recurrence": "TERM",
  "reference": "RF39RUB2026F04217",
  "category": "tuition",
  "coverage": "CONVERTIBLE",
  "conversions": [
    { "fromCurrency": "KZT", "toCurrency": "EUR", "amountMinor": 175734, "estimatedDebitMinor": 89999900, "routeId": "kzt-mock-bank" },
    { "fromCurrency": "USD", "toCurrency": "EUR", "amountMinor": 34316, "estimatedDebitMinor": 38843, "routeId": "usd-mock-bank" }
  ],
  "status": "DUE"
}
```

`coverage: "CONVERTIBLE"` means no single balance covers the EUR 2,400 tuition, but converting KZT and USD into EUR first would. Rent shows `"coverage": "COVERED"` with its cheapest route.

## 4. The limits the rules enforce

```bash
curl -s "${auth[@]}" localhost:4000/api/caps
```

```json
{ "caps": { "currency": "KZT", "perPaymentMinor": 150000000, "perDayMinor": 200000000,
            "perMonthMinor": 300000000, "smallAutoMinor": 1000000, "reserveMinor": 5000000 } }
```

Below `smallAutoMinor` (KZT 10,000) a payment to a verified payee can go through on its own; anything above needs a passkey or a signed mandate, and nothing can exceed the caps. Raising a cap needs the passkey; loosening other rules waits 24 hours ([self-assessment](../security/self-assessment.md), invariant I8).

## 5. The ledger

Every security-relevant event is a hash-chained entry.

```bash
curl -s "${auth[@]}" 'localhost:4000/api/ledger?limit=1'
```

```json
{
  "items": [{
    "seq": 7,
    "ts": "2026-10-27T09:00:27.832Z",
    "type": "AUTH_LOGIN_SUCCEEDED",
    "payload": { "client": "native", "method": "DEV_LOGIN", "userId": "c83d27e3-4e03-570f-8fea-87db32399c12" },
    "prevHash": "BSybGFcrSLOaEummh-5oAHrVCE_R_gNnXTo9UpjqKK0",
    "hash": "Y7WLvmMMesiqCk6LaxFCMZzvco98LShFX_F4wlgSvx0"
  }]
}
```

Each `hash` covers the entry and the previous `hash`, so changing any entry breaks every later one. See [Verify the ledger and anchors](./verify-ledger.md).

## Public endpoints (no sign-in)

| Route | Returns |
| --- | --- |
| `GET /api/health` | Service and migration status |
| `GET /api/fx/rates` | Today's reference rates (ECB via Frankfurter and the National Bank of Kazakhstan, or `fixtures/fx-rates.json` with `FX_OFFLINE=1`) |
| `GET /api/public/keys` | The issuer's Ed25519 public keys as a JWKS |
| `GET /api/public/anchors` | Ledger anchors on Sepolia, with explorer links |
| `GET /api/public/verify/:id` | A credit record's verification result |
