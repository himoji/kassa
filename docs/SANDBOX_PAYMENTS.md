# Sandbox payments: EU, China, US

Kassa never moves real money. Bank payouts go to a Wise-shaped bank, either Kassa's own mock bank
(`apps/mock-world`, the default) or Wise's sandbox (when `WISE_SANDBOX_TOKEN` is set). Both take the same
requests (quotes v3, recipient accounts v1, transfers v1, fund v3, balances v4).

## What a payee needs, per region

| Where | Currency | Scheme in Kassa | Fields | Wise recipient type |
| --- | --- | --- | --- | --- |
| EU (SEPA) and other IBAN countries | EUR, HUF, KZT, … | `IBAN` | name, IBAN (no BIC needed for SEPA) | `iban` |
| China | CNY | `CN_ALIPAY` | name, Alipay ID (email or mainland mobile) | `chinese_alipay` |
| China | CNY | `CN_UNIONPAY` | name, UnionPay card number (62…, 16–19 digits, Luhn) | `chinese_card` |
| US | USD | `US_ACH` | name, ABA routing number (checksum), account number, checking/savings | `aba` |
| Anything else | any | `OTHER` | merchant ID for QR handoffs; bank transfers can't reach it | none |

The rules live in one place, `packages/shared/src/payeeAccount.ts`, used by the app form, the API (`POST /payees`)
and the mock bank, so a typo is caught before the 24-hour cooling period starts. A payee account is still one string
(encrypted at rest, hashed for the cooling and change checks): a plain IBAN, `ALIPAY:<id>`, `UNIONPAY:<card>` or
`ACH:<routing>:<account>:<CHECKING|SAVINGS>`.

## Flows that work end to end

- **Within the EU:** EUR to an IBAN, from the EUR wallet.
- **EU → China:** CNY to an Alipay ID or a UnionPay card, funded from the cheapest wallet balance (EUR, KZT, …).
- **China → EU:** Li Wei (CNY wallet) pays EUR tuition to an IBAN (`apps/api/test/demos/cn3-li-wei.test.ts`).
- **US:** USD to a US account by ACH.

`apps/api/test/demos/eu-china-payouts.test.ts` runs the first, second and fourth through the real mock bank, and the
Alipay payout again against recorded Wise sandbox responses.

## Test details that pass validation

These are public test numbers, not real people's accounts.

- IBAN: `DE89 3704 0044 0532 0130 00` (Germany), `HU42 1177 3016 1111 1018 0000 0000` (Hungary)
- Alipay ID: `li.wei@example.cn` or `138 0013 8000`
- UnionPay card: `6200 0000 0000 0005`
- ACH: routing `021000021`, account `123456789`

## Using the real Wise sandbox

1. Make a free account at <https://sandbox.transferwise.tech> and create an API token under Settings → API tokens.
2. Top up the sandbox balance (the sandbox lets you add test money in EUR, USD and other currencies).
3. Set these in `.env`, then restart the API:

   ```
   WISE_SANDBOX_TOKEN=<sandbox token>
   WISE_PROFILE_ID=<optional; defaults to the token's first profile>
   ```

What changes:

- Quotes, fees and recipient checks come from Wise. Wise's own errors (for example a missing field) appear on the
  payment as the reason it failed.
- One sandbox profile stands in for every Kassa user, so balances are the sandbox account's.
- Wise refuses balance funding with a personal token for EU/UK profiles (strong customer authentication). Kassa then
  starts the transfer with the sandbox's simulation endpoint instead, and every status poll moves it one state on
  (processing, funds converted, sent).
- `WISE_API_URL` must be a sandbox host; the API refuses to start with a live Wise URL.
- Known gap: Wise asks for the recipient's address on USD (ACH) recipients. Kassa doesn't collect it yet, so in Wise
  mode US payouts fail with Wise's "address" error. They work against the mock bank.

## Test money in, and paying another Kassa user

**Add money** (Home → Add money) opens a stand-in for the phone's wallet sheet: Apple Pay, Google Pay, Samsung Pay or a
test card. Confirming calls `POST /api/wallet/top-ups`. No real wallet, card or money is involved:

- With `STRIPE_SECRET_KEY=sk_test_…` the tap becomes a Stripe test-mode PaymentIntent on Stripe's test card
  (`pm_card_visa`), so the charge shows up in the Stripe test dashboard. Without it the tap is simulated (`sim_tap_…`).
- The amount is then credited to the user's capped wallet in the sandbox bank: mock-world `POST /bank/top-ups`, or the
  Wise sandbox's `POST /v1/simulation/balance/topup`.
- Each top-up is idempotent (the app sends one key per attempt), ledgered as `WALLET_TOPUP`, and a day's top-ups are
  capped by the user's signed per-day cap. Top-ups need the capped-wallet money mode.

**Kassa ID.** Every user has a public handle such as `KSA-ZVMS-3NXE` (Settings, or the Send screen). Another user adds
it as a payee ("Kassa user"); it cools down for 24 hours like any payee. **Send** (Home → Send) proposes a payment to
any saved payee with `POST /api/payees/:id/pay`; the order sheet then asks for the passkey exactly as for an agent's
order. In mock mode the bank transfer is delivered into the other user's wallet when it reaches
`outgoing_payment_sent`, and mock-world sends a signed `wallet.received` remittance webhook: the receiver gets a
"Dana sent you 50.00 EUR" notification and a `WALLET_RECEIVED` ledger entry. The Wise sandbox has one profile, so
Kassa-to-Kassa runs on mock-world only.

Demo: Add money €50 → Settings shows your Kassa ID → as Dana add Li Wei by `KSA-ZVMS-3NXE` → advance the demo clock
25 h → Send → approve → advance 2 h → Li Wei's HUF balance is up. Covered by `apps/api/test/demos/wallet-p2p.test.ts`.

## Card payments

Card rails (one-time cards, pay in place) use Stripe test mode when `STRIPE_SECRET_KEY` is a `sk_test_` key, and a
fake issuer otherwise. Nothing there changes per region.
