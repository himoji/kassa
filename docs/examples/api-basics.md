# Call the API

Sign in as Dana with the dev sign-in and read her money. All routes: [HTTP API reference](../reference/http-api.md).

## 1. Sign in

`POST /api/auth/dev/login` exists only with `DEMO_ENABLED=true` and `DEV_LOGIN=true` (or on the judge build). `demoClaim: true` signs in as Dana; `client: "native"` returns bearer tokens instead of cookies.

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

```bash
TOKEN=$(curl -s localhost:4000/api/auth/dev/login -H 'content-type: application/json' \
  -H 'origin: http://localhost:8081' -d '{"demoClaim":true,"client":"native"}' | jq -r .tokens.accessToken)
auth=(-H "authorization: Bearer $TOKEN")
```

::: tip Errors are RFC 9457 problem details
`type`, `title`, `status`, `detail` and a machine-readable `code`. Without `client`:

```json
{ "type": "/problems/VALIDATION_FAILED", "status": 400, "code": "VALIDATION_FAILED",
  "detail": "Request does not match the schema",
  "details": [{ "instancePath": "/client", "message": "Invalid option: expected one of \"web\"|\"native\"" }] }
```
:::

## 2. Balances in every currency

Integer minor units (`amountMinor`) plus a home-currency equivalent.

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
  "amountMinor": 240000,
  "currency": "EUR",
  "dueDate": "2026-10-31",
  "coverage": "CONVERTIBLE",
  "conversions": [
    { "fromCurrency": "KZT", "toCurrency": "EUR", "amountMinor": 175734, "estimatedDebitMinor": 89999900, "routeId": "kzt-mock-bank" },
    { "fromCurrency": "USD", "toCurrency": "EUR", "amountMinor": 34316, "estimatedDebitMinor": 38843, "routeId": "usd-mock-bank" }
  ],
  …
}
```

`CONVERTIBLE`: no single balance covers EUR 2,400, but converting KZT and USD into EUR would. Rent shows `COVERED` with its cheapest route.

## 4. The limits the rules enforce

```bash
curl -s "${auth[@]}" localhost:4000/api/caps
```

```json
{ "caps": { "currency": "KZT", "perPaymentMinor": 150000000, "perDayMinor": 200000000,
            "perMonthMinor": 300000000, "smallAutoMinor": 1000000, "reserveMinor": 5000000 } }
```

Below `smallAutoMinor` (KZT 10,000) a payment to a verified payee can go through alone; above it needs a passkey or signed mandate; nothing exceeds the caps. Raising a cap needs the passkey; loosening other rules waits 24 hours ([self-assessment](../security/self-assessment.md), invariant I8).

## 5. The ledger

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

Each `hash` covers the entry and the previous `hash`, so editing one entry breaks all later ones. See [Verify the ledger and anchors](./verify-ledger.md).

## Public endpoints (no sign-in)

| Route | Returns |
| --- | --- |
| `GET /api/health` | Service and migration status |
| `GET /api/fx/rates` | Today's reference rates (ECB via Frankfurter and the National Bank of Kazakhstan, or `fixtures/fx-rates.json` with `FX_OFFLINE=1`) |
| `GET /api/public/keys` | Issuer's Ed25519 public keys (JWKS) |
| `GET /api/public/anchors` | Sepolia ledger anchors, with explorer links |
| `GET /api/public/verify/:id` | A credit record's verification result |
