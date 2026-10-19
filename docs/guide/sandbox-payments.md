# Sandbox payments: EU, China, US

No real money moves. Payouts go to Kassa's mock bank (`apps/mock-world`, default) or Wise's sandbox (with `WISE_SANDBOX_TOKEN`); both take the same requests (quotes v3, recipient accounts v1, transfers v1, fund v3, balances v4).

## What a payee needs, per region

| Where | Currency | Scheme in Kassa | Fields | Wise recipient type |
| --- | --- | --- | --- | --- |
| EU (SEPA) and other IBAN countries | EUR, HUF, KZT, … | `IBAN` | name, IBAN (no BIC for SEPA) | `iban` |
| China | CNY | `CN_ALIPAY` | name, Alipay ID (email or mainland mobile) | `chinese_alipay` |
| China | CNY | `CN_UNIONPAY` | name, UnionPay card number (62…, 16–19 digits, Luhn) | `chinese_card` |
| US | USD | `US_ACH` | name, ABA routing number (checksum), account number, checking/savings | `aba` |
| Anything else | any | `OTHER` | merchant ID for QR handoffs; no bank transfers | none |

Validation lives in `packages/shared/src/payeeAccount.ts` (app form, `POST /payees`, mock bank), so typos fail before the 24-hour cooling starts. Stored formats: a plain IBAN, `ALIPAY:<id>`, `UNIONPAY:<card>`, `ACH:<routing>:<account>:<CHECKING|SAVINGS>`.

## Flows that work end to end

- **Within the EU:** EUR to an IBAN.
- **EU → China:** CNY to Alipay or UnionPay, funded from the cheapest wallet balance.
- **China → EU:** Li Wei (CNY wallet) pays EUR tuition to an IBAN (`apps/api/test/demos/cn3-li-wei.test.ts`).
- **US:** USD by ACH.

`apps/api/test/demos/eu-china-payouts.test.ts` runs the first, second and fourth through the mock bank, and the Alipay payout against recorded Wise sandbox responses.

## Test details that pass validation

- IBAN: `DE89 3704 0044 0532 0130 00` (Germany), `HU42 1177 3016 1111 1018 0000 0000` (Hungary)
- Alipay ID: `li.wei@example.cn` or `138 0013 8000`
- UnionPay card: `6200 0000 0000 0005`
- ACH: routing `021000021`, account `123456789`

## Using the real Wise sandbox

1. Create an account at <https://sandbox.transferwise.tech> and an API token (Settings → API tokens).
2. Add test money to the sandbox balance.
3. Set in `.env` and restart the API:

   ```
   WISE_SANDBOX_TOKEN=<sandbox token>
   WISE_PROFILE_ID=<optional; defaults to the token's first profile>
   ```

Then quotes, fees, recipient checks and errors come from Wise, and one sandbox profile stands in for every user. Wise refuses balance funding with a personal token for EU/UK profiles, so Kassa uses the sandbox simulation endpoint (each status poll advances one state). `WISE_API_URL` must be a sandbox host. Known gap: Kassa doesn't collect the address Wise needs for USD (ACH) recipients, so US payouts fail in Wise mode (they work on the mock bank).

## Test money in, and paying another Kassa user

**Add money** (Home → Add money): a stand-in wallet sheet calling `POST /api/wallet/top-ups`. With `STRIPE_SECRET_KEY=sk_test_…` it makes a Stripe test PaymentIntent on `pm_card_visa`; otherwise simulated (`sim_tap_…`). The amount is credited via mock-world `POST /bank/top-ups` or Wise `POST /v1/simulation/balance/topup`. Top-ups are idempotent, ledgered as `WALLET_TOPUP`, capped by the signed per-day cap, and need the capped-wallet money mode.

**Kassa ID** (e.g. `KSA-ZVMS-3NXE`, in Settings or Send): another user adds it as a "Kassa user" payee (24 h cooling). **Send** (`POST /api/payees/:id/pay`) asks for the passkey like an agent order. On mock-world only, the transfer lands in the receiver's wallet at `outgoing_payment_sent` with a signed `wallet.received` webhook, a notification and a `WALLET_RECEIVED` ledger entry.

Demo: Add money €50 → Settings shows your Kassa ID → as Dana add Li Wei by `KSA-ZVMS-3NXE` → advance the demo clock 25 h → Send → approve → advance 2 h → Li Wei's HUF balance is up. Covered by `apps/api/test/demos/wallet-p2p.test.ts`.

## Linked cards and banks

Settings → Linked accounts (or From → Link a card or bank on Send). `POST /api/funding-sources/card/start` or `/bank/start` creates a PENDING account; `POST /api/funding-sources/:id/confirm` needs the passkey (a 428 round trip) and, for a bank, the one-tenge code. Only ACTIVE accounts can be used; removal never touches past payments. The account is part of what the passkey signs; at execution Kassa pulls the amount into the wallet and pays out. A declined card pays nothing.

| Piece | Demo | Production |
| --- | --- | --- |
| Link a card | Stripe test card (Visa 4242, Mastercard 4444, or the declined 0341); saved via SetupIntent with `STRIPE_SECRET_KEY=sk_test_…`, else simulated | Same, live keys, through a licensed partner |
| Link a bank (EU or Kaspi / Halyk in KZ) | Mock bank: last 4 digits and a one-tenge code | Open banking (EU), the KZ Open API or a bank partnership |
| Pull from the linked account | Stripe test PaymentIntent (off session) or simulated charge; simulated bank debit | Same rails, live |
| Payout | Mock bank, instant once funded (`MOCK_BANK_INSTANT`, on by default outside tests) | Wise Platform or a licensed payout partner |
| "Delivered in 1.2 s" | Approval to mock-bank payout, labelled simulated | Depends on the corridor |

Dana's seed has a confirmed test Visa and Kaspi Gold account. Tests: `apps/api/test/core/linked-accounts.test.ts`.

## School portals

Four fictitious schools (Budapest, Debrecen, Vienna, Almaty), portal at `/mock/schools/:id/portal?studentId=`. Add a Tuition recipient via Find your school: `POST /api/schools/:id/lookup` shows the open invoice, `POST /api/schools/:id/link` adds the school (24 h cooling) and the invoice as a bill. Both need `dateOfBirth` to match the school's file (`POST /mock/schools/:id/invoices`; Kassa does not keep it).

- Seeded: Dana `KZ26-0417` 2005-03-14, Li Wei `CN26-0331` 2004-09-21. Other IDs' dates are derived with `MOCK_HMAC_SECRET`.
- Wrong date or unknown ID: `STUDENT_NOT_VERIFIED`.
- Judge build: the seeded student ID needs no date.
- `POST /api/obligations/:id/pay` pays a bill now, once.

A payout to the school's IBAN with the invoice reference triggers a signed `school` webhook (`POST /api/webhooks/mock/school`), accepted only for a matching transfer Kassa sent; Kassa records the receipt and notifies the user. Production: a partner such as Flywire or Convera. Tests: `apps/api/test/core/schools.test.ts`, `apps/mock-world/test/schools.test.ts`.

## Card payments

One-time cards and pay in place use Stripe test mode with a `sk_test_` `STRIPE_SECRET_KEY`, else a fake issuer. Same in every region.
