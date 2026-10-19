# HTTP API

The Fastify API serves everything under `/api` (147 routes). The app, KassaLite, the Shortcuts and the simulation all use these same routes. Request and response schemas are zod objects in [`packages/shared/src`](https://github.com/himoji/kassa/tree/main/packages/shared/src) (`dto.ts`, `appDto.ts`, `privacyDto.ts`), validated on both sides.

## Conventions

- **Auth.** A session cookie for the web app (`client: "web"`) or a bearer token (`client: "native"`). Everything except the public routes needs a signed-in user.
- **Money** is always an integer in minor units with a currency: `{ "amountMinor": 240000, "currency": "EUR" }` is EUR 2,400.00.
- **Errors** are RFC 9457 problem details (`application/problem+json`) with a stable `code` and, where rules are involved, `reasonCodes`.
- **Passkey-gated writes** sign exactly what will happen. Orders carry `webauthnOptions` whose challenge is the canonical order's hash (`GET /api/orders/:proposalId`, then `POST …/approve` with the assertion). Mandates, onboarding and purchase orders have an `…/options` call first. Other gated writes (loosening a rule, erasing data, linking an account) answer **428 `PASSKEY_REQUIRED`** with a `challengeId` and WebAuthn options; sign them and resend the same body with `challengeId` and `assertion`.
- **Rate limits** per IP: 600 requests a minute overall, 20 for auth, 30 for sensitive writes (configurable, see [Environment](./environment.md)).

Worked calls are in [Call the API](../examples/api-basics.md), [An agent turn](../examples/agent-turn.md), [Import a bank statement](../examples/statement-import.md) and [Credit record](../examples/credit-record.md).

## Health and public (no sign-in)

Status, issuer keys, anchors and credit-record verification. Safe to call from anywhere.

| Method | Path |
| --- | --- |
| GET | `/api/fx/rates` |
| GET | `/api/health` |
| GET | `/api/public/anchors` |
| GET | `/api/public/credit-record/:file` |
| GET | `/api/public/keys` |
| GET | `/api/public/verify/:id` |

## Sign-in and devices

Passkey registration and login (WebAuthn options, then verify), refresh, logout, backup codes, pairing KassaLite, and the dev sign-in (`DEV_LOGIN` or the judge build only).

| Method | Path |
| --- | --- |
| GET | `/api/auth/demo` |
| POST | `/api/auth/dev/assert` |
| POST | `/api/auth/dev/login` |
| POST | `/api/auth/login/options` |
| POST | `/api/auth/login/verify` |
| POST | `/api/auth/logout` |
| POST | `/api/auth/pair/complete` |
| POST | `/api/auth/pair/start` |
| GET | `/api/auth/recovery-codes` |
| POST | `/api/auth/recovery-codes` |
| POST | `/api/auth/recovery/options` |
| POST | `/api/auth/recovery/verify` |
| POST | `/api/auth/refresh` |
| POST | `/api/auth/register/options` |
| POST | `/api/auth/register/verify` |
| POST | `/api/devices` |
| GET | `/api/devices` |
| DELETE | `/api/devices/:id` |
| POST | `/api/devices/shortcut` |

## Profile, settings and rules

The signed rules: presets, caps, mandates, onboarding confirmation and the freeze switch. Loosening a rule needs the passkey (428 PASSKEY_REQUIRED) and most loosenings take effect after 24 h.

| Method | Path |
| --- | --- |
| GET | `/api/caps` |
| POST | `/api/freeze` |
| GET | `/api/mandates` |
| POST | `/api/mandates` |
| POST | `/api/mandates/:id/revoke` |
| POST | `/api/mandates/options` |
| GET | `/api/me` |
| PATCH | `/api/me` |
| POST | `/api/onboarding/confirm` |
| POST | `/api/onboarding/confirm/options` |
| GET | `/api/onboarding/conversation` |
| POST | `/api/onboarding/history` |
| POST | `/api/onboarding/message` |
| GET | `/api/rule-changes` |
| PATCH | `/api/settings` |
| POST | `/api/unfreeze` |

## Agent

Chat turns (streamed), conversations, document upload for the Reader, voice transcription.

| Method | Path |
| --- | --- |
| GET | `/api/agent/activity` |
| GET | `/api/agent/conversations` |
| PATCH | `/api/agent/conversations/:id` |
| DELETE | `/api/agent/conversations/:id` |
| GET | `/api/agent/conversations/:id/messages` |
| POST | `/api/agent/documents` |
| POST | `/api/agent/message` |
| POST | `/api/agent/transcribe` |

## Orders and payments

Proposals and their approval with the passkey, conversions between own balances, card intents, QR handoff and merchant bills.

| Method | Path |
| --- | --- |
| POST | `/api/conversions` |
| GET | `/api/handoff/:paymentId` |
| GET | `/api/merchant-bills/:billId` |
| POST | `/api/merchant-bills/:billId/propose` |
| GET | `/api/orders/:proposalId` |
| POST | `/api/orders/:proposalId/approve` |
| POST | `/api/orders/:proposalId/reject` |
| POST | `/api/payments/:paymentId/intent` |
| POST | `/api/payments/:paymentId/intent/simulate-success` |
| GET | `/api/proposals` |
| GET | `/api/shop-orders` |
| GET | `/api/shop-orders/:id` |

## Money

Balances, transactions, bills, cards, linked accounts, top-ups, budgets, forecasts and the fee x-ray.

| Method | Path |
| --- | --- |
| GET | `/api/balances` |
| GET | `/api/budgets` |
| PUT | `/api/budgets` |
| GET | `/api/cards` |
| POST | `/api/cards` |
| DELETE | `/api/cards/:id` |
| GET | `/api/cards/fees` |
| GET | `/api/forecast` |
| GET | `/api/funding-sources` |
| DELETE | `/api/funding-sources/:id` |
| POST | `/api/funding-sources/:id/confirm` |
| POST | `/api/funding-sources/bank/start` |
| POST | `/api/funding-sources/card/start` |
| GET | `/api/insights/spending` |
| GET | `/api/obligations` |
| POST | `/api/obligations` |
| DELETE | `/api/obligations/:id` |
| POST | `/api/obligations/:id/pay` |
| POST | `/api/plan/advice` |
| GET | `/api/send/quote` |
| GET | `/api/transactions` |
| GET | `/api/transactions/:id` |
| POST | `/api/transactions/:id/category` |
| GET | `/api/wallet` |
| POST | `/api/wallet/top-ups` |

## Payees and schools

Recipients with 24-hour cooling, verification, and the school directory with invoices by student ID.

| Method | Path |
| --- | --- |
| GET | `/api/payees` |
| POST | `/api/payees` |
| PATCH | `/api/payees/:id` |
| DELETE | `/api/payees/:id` |
| POST | `/api/payees/:id/pay` |
| POST | `/api/payees/:id/school-invoices` |
| POST | `/api/payees/:id/verify-callback` |
| GET | `/api/schools` |
| POST | `/api/schools/:id/link` |
| POST | `/api/schools/:id/lookup` |

## Capture

Card taps and settlements from the iPhone Shortcut, wallet notifications and the voice Shortcut.

| Method | Path |
| --- | --- |
| POST | `/api/capture/event` |
| GET | `/api/capture/recent` |
| POST | `/api/capture/settlement` |
| POST | `/api/capture/shortcut` |
| POST | `/api/capture/voice` |

## Statements and data

Statement import (preview, then commit), money history and the full export.

| Method | Path |
| --- | --- |
| GET | `/api/export` |
| GET | `/api/history` |
| POST | `/api/import/commit` |
| POST | `/api/import/file` |
| POST | `/api/import/preview` |

## Privacy and identity

AI notice and consent, PIPL consent, data export, restriction and erasure (passkey-signed), identity check.

| Method | Path |
| --- | --- |
| GET | `/api/kyc` |
| POST | `/api/kyc/start` |
| POST | `/api/privacy/ai-consent` |
| GET | `/api/privacy/ai-notice` |
| POST | `/api/privacy/erase` |
| GET | `/api/privacy/export` |
| POST | `/api/privacy/pipl-consent` |
| POST | `/api/privacy/restrict` |

## Credit record and ledger

Issue a signed credit record; read your ledger entries.

| Method | Path |
| --- | --- |
| POST | `/api/credit-record/export` |
| GET | `/api/ledger` |

## Notifications

| Method | Path |
| --- | --- |
| GET | `/api/notifications` |
| POST | `/api/notifications/:id/read` |

## Business mode

Stock forecast, inventory, purchase orders signed with the passkey (hidden in the app by default).

| Method | Path |
| --- | --- |
| GET | `/api/business/forecast` |
| GET | `/api/business/inventory` |
| GET | `/api/business/purchase-orders` |
| GET | `/api/business/purchase-orders/:id` |
| POST | `/api/business/purchase-orders/:id/send` |
| POST | `/api/business/purchase-orders/:id/sign` |
| POST | `/api/business/purchase-orders/:id/sign/options` |
| GET | `/api/business/sales/today` |

## Webhooks (mock world and Stripe)

Signed callbacks from the mock bank, QR wallet, POS, shop, school, supplier and remittance sender (HMAC), and Stripe test mode.

| Method | Path |
| --- | --- |
| POST | `/api/rails/fake-issuing/authorize` |
| POST | `/api/webhooks/mock/bank` |
| POST | `/api/webhooks/mock/pos` |
| POST | `/api/webhooks/mock/qr` |
| POST | `/api/webhooks/mock/remittance` |
| POST | `/api/webhooks/mock/school` |
| POST | `/api/webhooks/mock/shop` |
| POST | `/api/webhooks/mock/supplier` |
| POST | `/api/webhooks/stripe` |

## Demo (DEMO_ENABLED only)

Demo clock, reset, scenario triggers and the Stage. Admin calls need the `x-kassa-demo-token` header; `money-from-home` and `run-due-payments` act on the signed-in user only.

| Method | Path |
| --- | --- |
| POST | `/api/demo/agent-mode` |
| GET | `/api/demo/clock` |
| POST | `/api/demo/clock/advance` |
| POST | `/api/demo/clock/mode` |
| POST | `/api/demo/cooling` |
| POST | `/api/demo/money-from-home` |
| POST | `/api/demo/reset` |
| POST | `/api/demo/run-due-payments` |
| POST | `/api/demo/stage/document` |
| POST | `/api/demo/stage/settlement` |
| POST | `/api/demo/stage/shortcut-token` |
| POST | `/api/demo/trigger/:scenario` |

