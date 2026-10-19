# HTTP API

Fastify, everything under `/api` (147 routes), used by the app, KassaLite, the Shortcuts and the simulation. Schemas are zod objects in [`packages/shared/src`](https://github.com/himoji/kassa/tree/main/packages/shared/src) (`dto.ts`, `appDto.ts`, `privacyDto.ts`), validated on both sides.

## Conventions

- **Auth:** session cookie (`client: "web"`) or bearer token (`client: "native"`). All but the public routes need a signed-in user.
- **Money:** integer minor units with a currency; `{ "amountMinor": 240000, "currency": "EUR" }` is EUR 2,400.00.
- **Errors:** RFC 9457 problem details (`application/problem+json`) with a stable `code` and, for rules, `reasonCodes`.
- **Passkey-gated writes** sign exactly what will happen. Orders: `GET /api/orders/:proposalId` gives `webauthnOptions` (challenge = canonical order hash), then `POST …/approve` with the assertion. Mandates, onboarding and purchase orders: an `…/options` call first. Other gated writes (loosening a rule, erasing data, linking an account) answer **428 `PASSKEY_REQUIRED`** with a `challengeId` and WebAuthn options; resend the same body with `challengeId` and `assertion`.
- **Rate limits** per IP: 600/min overall, 20 auth, 30 sensitive writes ([Environment](./environment.md)).

Examples: [Call the API](../examples/api-basics.md), [An agent turn](../examples/agent-turn.md), [Import a bank statement](../examples/statement-import.md), [Credit record](../examples/credit-record.md).

## Health and public (no sign-in)

| Path | Methods |
| --- | --- |
| `/api/fx/rates` | GET |
| `/api/health` | GET |
| `/api/public/anchors` | GET |
| `/api/public/credit-record/:file` | GET |
| `/api/public/keys` | GET |
| `/api/public/verify/:id` | GET |

## Sign-in and devices

Passkey register/login (options, then verify), refresh, logout, backup codes, KassaLite pairing, dev sign-in (`DEV_LOGIN` or judge build only).

| Path | Methods |
| --- | --- |
| `/api/auth/demo` | GET |
| `/api/auth/dev/assert` | POST |
| `/api/auth/dev/login` | POST |
| `/api/auth/login/options` | POST |
| `/api/auth/login/verify` | POST |
| `/api/auth/logout` | POST |
| `/api/auth/pair/complete` | POST |
| `/api/auth/pair/start` | POST |
| `/api/auth/recovery-codes` | GET, POST |
| `/api/auth/recovery/options` | POST |
| `/api/auth/recovery/verify` | POST |
| `/api/auth/refresh` | POST |
| `/api/auth/register/options` | POST |
| `/api/auth/register/verify` | POST |
| `/api/devices` | GET, POST |
| `/api/devices/:id` | DELETE |
| `/api/devices/shortcut` | POST |

## Profile, settings and rules

Presets, caps, mandates, onboarding confirmation, freeze. Loosening needs the passkey (428 PASSKEY_REQUIRED); most loosenings apply after 24 h.

| Path | Methods |
| --- | --- |
| `/api/caps` | GET |
| `/api/freeze` | POST |
| `/api/mandates` | GET, POST |
| `/api/mandates/:id/revoke` | POST |
| `/api/mandates/options` | POST |
| `/api/me` | GET, PATCH |
| `/api/onboarding/confirm` | POST |
| `/api/onboarding/confirm/options` | POST |
| `/api/onboarding/conversation` | GET |
| `/api/onboarding/history` | POST |
| `/api/onboarding/message` | POST |
| `/api/rule-changes` | GET |
| `/api/settings` | PATCH |
| `/api/unfreeze` | POST |

## Agent

Streamed chat turns, conversations, Reader document upload, voice transcription.

| Path | Methods |
| --- | --- |
| `/api/agent/activity` | GET |
| `/api/agent/conversations` | GET |
| `/api/agent/conversations/:id` | PATCH, DELETE |
| `/api/agent/conversations/:id/messages` | GET |
| `/api/agent/documents` | POST |
| `/api/agent/message` | POST |
| `/api/agent/transcribe` | POST |

## Orders and payments

Proposals and passkey approval, conversions between own balances, card intents, QR handoff, merchant bills.

| Path | Methods |
| --- | --- |
| `/api/conversions` | POST |
| `/api/handoff/:paymentId` | GET |
| `/api/merchant-bills/:billId` | GET |
| `/api/merchant-bills/:billId/propose` | POST |
| `/api/orders/:proposalId` | GET |
| `/api/orders/:proposalId/approve` | POST |
| `/api/orders/:proposalId/reject` | POST |
| `/api/payments/:paymentId/intent` | POST |
| `/api/payments/:paymentId/intent/simulate-success` | POST |
| `/api/proposals` | GET |
| `/api/shop-orders` | GET |
| `/api/shop-orders/:id` | GET |

## Money

Balances, transactions, bills, cards, linked accounts, top-ups, budgets, forecasts, fee x-ray.

| Path | Methods |
| --- | --- |
| `/api/balances` | GET |
| `/api/budgets` | GET, PUT |
| `/api/cards` | GET, POST |
| `/api/cards/:id` | DELETE |
| `/api/cards/fees` | GET |
| `/api/forecast` | GET |
| `/api/funding-sources` | GET |
| `/api/funding-sources/:id` | DELETE |
| `/api/funding-sources/:id/confirm` | POST |
| `/api/funding-sources/bank/start` | POST |
| `/api/funding-sources/card/start` | POST |
| `/api/insights/spending` | GET |
| `/api/obligations` | GET, POST |
| `/api/obligations/:id` | DELETE |
| `/api/obligations/:id/pay` | POST |
| `/api/plan/advice` | POST |
| `/api/send/quote` | GET |
| `/api/transactions` | GET |
| `/api/transactions/:id` | GET |
| `/api/transactions/:id/category` | POST |
| `/api/wallet` | GET |
| `/api/wallet/top-ups` | POST |

## Payees and schools

Recipients with 24-hour cooling, verification, school directory with invoices by student ID.

| Path | Methods |
| --- | --- |
| `/api/payees` | GET, POST |
| `/api/payees/:id` | PATCH, DELETE |
| `/api/payees/:id/pay` | POST |
| `/api/payees/:id/school-invoices` | POST |
| `/api/payees/:id/verify-callback` | POST |
| `/api/schools` | GET |
| `/api/schools/:id/link` | POST |
| `/api/schools/:id/lookup` | POST |

## Capture

iPhone Shortcut card taps and settlements, wallet notifications, voice Shortcut.

| Path | Methods |
| --- | --- |
| `/api/capture/event` | POST |
| `/api/capture/recent` | GET |
| `/api/capture/settlement` | POST |
| `/api/capture/shortcut` | POST |
| `/api/capture/voice` | POST |

## Statements and data

Statement import (preview, then commit), money history, full export.

| Path | Methods |
| --- | --- |
| `/api/export` | GET |
| `/api/history` | GET |
| `/api/import/commit` | POST |
| `/api/import/file` | POST |
| `/api/import/preview` | POST |

## Privacy and identity

AI notice and consent, PIPL consent, export, restriction and erasure (passkey-signed), identity check.

| Path | Methods |
| --- | --- |
| `/api/kyc` | GET |
| `/api/kyc/start` | POST |
| `/api/privacy/ai-consent` | POST |
| `/api/privacy/ai-notice` | GET |
| `/api/privacy/erase` | POST |
| `/api/privacy/export` | GET |
| `/api/privacy/pipl-consent` | POST |
| `/api/privacy/restrict` | POST |

## Credit record and ledger

| Path | Methods |
| --- | --- |
| `/api/credit-record/export` | POST |
| `/api/ledger` | GET |

## Notifications

| Path | Methods |
| --- | --- |
| `/api/notifications` | GET |
| `/api/notifications/:id/read` | POST |

## Business mode

Stock forecast, inventory, passkey-signed purchase orders (hidden in the app by default).

| Path | Methods |
| --- | --- |
| `/api/business/forecast` | GET |
| `/api/business/inventory` | GET |
| `/api/business/purchase-orders` | GET |
| `/api/business/purchase-orders/:id` | GET |
| `/api/business/purchase-orders/:id/send` | POST |
| `/api/business/purchase-orders/:id/sign` | POST |
| `/api/business/purchase-orders/:id/sign/options` | POST |
| `/api/business/sales/today` | GET |

## Webhooks (mock world and Stripe)

HMAC-signed callbacks from the mock bank, QR wallet, POS, shop, school, supplier and remittance sender; Stripe test mode.

| Path | Methods |
| --- | --- |
| `/api/rails/fake-issuing/authorize` | POST |
| `/api/webhooks/mock/bank` | POST |
| `/api/webhooks/mock/pos` | POST |
| `/api/webhooks/mock/qr` | POST |
| `/api/webhooks/mock/remittance` | POST |
| `/api/webhooks/mock/school` | POST |
| `/api/webhooks/mock/shop` | POST |
| `/api/webhooks/mock/supplier` | POST |
| `/api/webhooks/stripe` | POST |

## Demo (DEMO_ENABLED only)

Demo clock, reset, scenario triggers, the Stage. Admin calls need the `x-kassa-demo-token` header; `money-from-home` and `run-due-payments` act on the signed-in user only.

| Path | Methods |
| --- | --- |
| `/api/demo/agent-mode` | POST |
| `/api/demo/clock` | GET |
| `/api/demo/clock/advance` | POST |
| `/api/demo/clock/mode` | POST |
| `/api/demo/cooling` | POST |
| `/api/demo/money-from-home` | POST |
| `/api/demo/reset` | POST |
| `/api/demo/run-due-payments` | POST |
| `/api/demo/stage/document` | POST |
| `/api/demo/stage/settlement` | POST |
| `/api/demo/stage/shortcut-token` | POST |
| `/api/demo/trigger/:scenario` | POST |
