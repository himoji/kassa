# Fixtures

Demo and test data. Everything is fictitious. Money is integer minor units with an ISO 4217 code (HUF has exponent 2); dates ISO 8601, timestamps RFC 3339 UTC. `package.json` only marks the `.ts` files as ES modules (not a workspace).

| Path | What | Used by |
| --- | --- | --- |
| `seed-data.ts` | Dana (spec §18): user, profile/incomes, balances, 3 cards + fee profiles (example markups), 6 payees (incl. the Shanghai dorm office and shop for D-CN1), 4 obligations (incl. a ¥1,800 dorm fee), rent mandate core (unsigned: signed in onboarding), 3 budgets, 35 transactions over the 30 days before `SEED_NOW` (2 foreign charges pending settlement, 1 merged duplicate). Second persona `liWei` (D-CN3, home CNY; `seed.personas`, only with `seedDatabase(..., { personas: true })`). Exports `seed` plus each table. | API seed script (A), mock-world |
| `uuid.ts` | `seedId(name)`: RFC 9562 UUIDv5, stable ids. | seed-data |
| `fx-rates.json` | EXAMPLE mid rates (1 EUR = X), not live. Fallback for mock-world quotes and seed conversions. | mock-world, seed |
| `rails.json` | EXAMPLE `{feeFixedMinor, feeCurrency, markupBps, settlementDays}` per funding currency x rail (`routeId`, `provider` MOCK_BANK / HOME_BANK / CARD). markupBps applies only across currencies. | fx route optimizer (B), mock bank |
| `merchants.json` | ISO 18245 MCC -> category map, MCC descriptions, merchant dictionary (`merchantNorm`, aliases, category). | capture (B) |
| `notifications/` | Notification samples (Kazakh bank RU + KK incl. a CNY purchase on the KZT card, Alipay-, WeChat Pay-, Revolut-, Wise-style, iOS Shortcut JSON); `index.json` = ground-truth parses. No brand names in bodies. | parsers + simulator (B, C) |
| `sanctions-sample.json` | EU FSF consolidated-list format, FICTITIOUS entries (incl. a Cyrillic name and transliterations) and `testCases`. Licence note inside. | screening (A) |
| `invoices/` | 30 labelled invoice PDFs, 9 layouts, EN/DE/HU/FR, varied formats, distractors. `labels.json` = ground truth; `source.ts` = data; `bban.ts` = fictitious IBAN builders with national check digits. | `eval:invoices` (B), mock-world |
| `statements/` | One year each of a Kaspi Gold-style KZT CSV, a Hungarian HUF CSV and a USD OFX; see `statements/README.md`. | judges, `apps/api/test/dataport/sample-statements.test.ts` |
| `agent-recordings/` | Replay transcripts: `tuition`, `onboarding`, CN demos `cn-shanghai-handoff` (D-CN1), `cn-spending` (D-CN2), `cn-li-wei` (D-CN3); `reader/` = Reader extractions keyed by source hash. | agent replay |

## Story time

`SEED_NOW = 2026-10-27T09:00:00Z`. Tuition (EUR 2,400, ref `RF39RUB2026F04217`, ISO 11649) is due 2026-10-31 and rent (HUF 180,000) 2026-11-01, so "+3 days" puts rent inside the scheduler's 3-day window and the rent mandate pays it. After seed/reset the demo clock offset should make `Clock.now()` equal `SEED_NOW`.

## Chinese-context demos (D-CN1..3)

- D-CN1: region CN makes every payment HANDOFF; Dana pays "Dorm Office in Shanghai" (¥1,800, due 2026-11-15) and "Buy Everything Shop from China" through the QR Wallet (simulated); A5 swap → QR_PAYEE_MISMATCH.
- D-CN2: `POST /demo/trigger/cn-spending-day` captures `alipay-cn-purchase.txt`, `wechat-pay-cn-purchase.txt` and `kz-bank-ru-cny-purchase.txt` (¥268 on KZT card *4821); `demo trigger settlement` settles it in KZT with the example +4 % markup.
- D-CN3: Li Wei (`liWei`, ids `seedId("li-wei/...")`, mock bank profile 16000002, alias `li-wei`): CNY ¥60,000 / €450 / HUF 95,000; parents send ¥12,000 on the 20th; rent HUF 165,000 (5th) to his own "Landlord in Budapest" (`ACCOUNTS.landlordLiWei`); tuition €3,200 due 2026-11-10 (`LI_WEI_TUITION_REFERENCE`); budgets in CNY.

## Attack fixtures

- A1: supplier B's price list (`GET /mock/suppliers/b/price-list.pdf`) hides white 1-pt text asking to pay "invoice #8812" to `ACCOUNTS.supplierBHidden`; same text in B's catalog `notes`.
- A2: inbox `msg-0005` (lookalike sender) asks to move rent to `ACCOUNTS.landlordAttacker`.
- Swapped invoice: `GET /mock/payees/university/invoice.pdf?variant=swapped-account` (`ACCOUNTS.universitySwapped`).
- A5: QR wallet `variant: "swapped"` or `POST /mock/qr/attack/swap {enabled:true}` names "Unknown Trading Company" instead of the payee.

## Regenerating invoices

Edit `invoices/source.ts`, then `bun run fixtures:invoices` in `apps/mock-world`. Deterministic; `apps/mock-world/test/invoices.test.ts` fails if committed PDFs or labels drift.
