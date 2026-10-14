# Kassa test catalogue

Workspace totals from the run of 2026-10-14 (see "Changelog" at the end). Per-file rows below were last counted on 2026-10-12, after the final fix pass; files added since then are counted in the totals and listed where they matter for security.

## How to run
- Everything: `bun run typecheck && bun run lint && bun run test` (turbo; all workspaces incl. mobile jest).
- API only: `bun run --cwd apps/api test`; one folder: `bun run --cwd apps/api vitest run test/attacks --reporter=verbose` (also `invariants`, `security`, `core`, `rules`, `screening`, `intel`, `demos`, `naive`, `sim`).
- Attack evidence: `bun run evidence:attacks` → `docs/evidence/attacks.json`, `docs/evidence/naive-baseline.json`.
- Ledger: `bun run db:migrate && bun run seed && bun run ledger:verify`.
- Simulation (personas, demos): `bun run sim …` — see `docs/evidence/sim/RUNBOOK.md`.

## Summary
| Workspace | Files | Tests | Result |
|---|---|---|---|
| apps/api | 104 | 828 (+1 opt-in live smoke test, skipped) | all pass |
| apps/mock-world | 9 | 338 | all pass |
| packages/shared | 7 | 53 | all pass |
| apps/mobile (jest) | 65 | 527 | all pass |

Guarded attack suite: **0 of 8 attacks paid**; naive baseline (no rules): **8 of 8 paid** (`docs/evidence/attacks.json`, A1 to A8). A9 was added later and is refused by its own test; it is not in the naive baseline.

## Attacks (`apps/api/test/attacks/`)
| File | Threat | Expected | Actual | Maps to |
|---|---|---|---|---|
| A1.test.ts | Hidden instruction in supplier price list (end to end) | no proposal for hidden account; REFUSE_SOURCE_MISMATCH; nothing paid | 4 passed | A1; I10 |
| A2.test.ts | "Landlord new IBAN" email | new COOLING payee; rent stays on verified account | 2 passed | A2; I7, I10 |
| A3.test.ts | Payment without approval, forged approval, replay | NO_APPROVAL, BAD_SIGNATURE, NONCE_USED; no money; ledgered | 4 passed | A3; I2, I4 |
| A4.test.ts | Loosen caps without passkey / before signing | passkey required; REFUSE_CAP until signed; signed raise instant; preset loosening 24 h; tightening instant | 9 passed | A4; I8 |
| A5.test.ts | Swapped QR (checked when shown, X7) | QR_PAYEE_MISMATCH up front; approve refused; no pay action | 3 passed | A5; I2, I3 |
| A6.test.ts | Sanctions (Cyrillic, transliterated, fuzzy) | REFUSE_SANCTIONS | 6 passed | A6; I9 |
| A7.test.ts | Fake POS trigger 10× (end to end) | logged only; ASK TRIGGER_ORIGIN; REFUSE_CAP | 4 passed | A7; I6 |
| A8.test.ts | Lying confirmation; tampered order | canonical values shown; ORDER_HASH_MISMATCH | 3 passed | A8; I3 |
| A9.test.ts | Swapped bank details on a supplier invoice (Budapest IBAN, Shanghai QR merchant) | INVOICE_ACCOUNT_MISMATCH; ledgered; owner notified; no proposal, no payment; genuine invoice still matches | 2 passed | A9; Verification of Payee |

## Invariants (`apps/api/test/invariants/`)
| File | Expected | Actual | Maps to |
|---|---|---|---|
| I1-I13.test.ts | one block per invariant (I1 = transitive import graph) | 16 passed | I1–I13 |

## Security (`apps/api/test/security/`)
| File | Threat / flow | Expected | Actual | Maps to |
|---|---|---|---|---|
| bola.test.ts | Cross-user access | 404 for other users' objects; audited | 5 passed | OWASP API1 |
| http-hardening.test.ts | Deny-by-default, headers, CORS, CSRF, body limit, rate limits, demo token | gated routes; 403/413/429; constant-time token | 18 passed | OWASP API4/API8 |
| llm-redaction.test.ts | Planner prompts; PAN storage | no personal data in prompts; no full PAN | 3 passed | I11; PCI DSS scope |
| privacy.test.ts | GDPR export/rectify/erase/restrict/consent | crypto-shred erasure; ledger still verifies | 9 passed | GDPR Art. 15–20 |
| unfreeze-retention.test.ts | Unfreeze as loosening; retention purge | 24 h + passkey; purge job | 6 passed | I8 |
| webhook-replay.test.ts | Replay + malicious bank sequences | WEBHOOK_REPLAYED; STATUS_REGRESSION, PAYMENT_FINAL, NOT_FUNDED, … | 12 passed | I13 |
| erase-refresh.test.ts | Refresh after erasure (X5) | every refresh token of an erased user → 401 ACCOUNT_ERASED; normal refresh still works | 3 passed | GDPR Art. 17; I2 |
| payee-verify.test.ts | Payee verification needs a passkey (X3a) | 428 PASSKEY_REQUIRED; challenge bound to the payee; single use | 5 passed | AAL2 re-authentication; I7 |
| pipl-consent.test.ts | Separate cross-border consent, region CN (Y3) | 403 PIPL_CONSENT_REQUIRED; POST /privacy/pipl-consent gives and withdraws; erasure clears | 6 passed | PIPL Art. 38–39 |
| seed-privacy.test.ts | Seeded users have no implicit consent (Y2) | no AI consent by default; opt-in only via `{ aiConsent: true }`; no cross-persona data | 3 passed | GDPR Art. 7 |
| x10-triggers.test.ts | Device tokens, bank notification text, base-rules tampering (X10) | 401 for bad or revoked tokens; tampered base rules → BAD_SIGNATURE; injected text creates nothing | 12 passed | I2, I6 |

## Core (`apps/api/test/core/`)
| File | Flow | Actual | Maps to |
|---|---|---|---|
| auth.test.ts | passkey registration/login, single-use challenges, refresh rotation | 6 passed | I2 |
| flow.test.ts | end-to-end T2 (ask) and T1 (mandate) money paths | 2 passed | tiers |
| funding.test.ts | funding route bound into the signed order; INSUFFICIENT_FUNDS before signing | 5 passed | I2, I3 |
| ledger.test.ts | hash chain, checkpoints, tamper, forgery, concurrency | 7 passed | I12 |
| ledger-head.test.ts | signed ledger head: tail truncation, re-hashed tail, deleted head (X6) | 6 passed | I12 |
| obligation-settlement.test.ts | no double payment per obligation period | 8 passed | idempotency |
| order-expiry.test.ts | expired orders are re-issued, never re-signed; 410 ORDER_EXPIRED (X8) | 3 passed | I3, I4 |
| orders-onboarding.test.ts | canonical order over HTTP; expiry; BOLA | 5 passed | I3 |
| payees-mandates.test.ts | COOLING payees; IBAN validation; mandate passkey + 24 h | 4 passed | I7, I8 |
| payment-notifications.test.ts | PAYMENT_SENT / PAYMENT_FAILED for every rail, once per outcome (X9) | 5 passed | UX; I9 |
| payments.test.ts | independent verification in the payments module | 15 passed | I2–I5, I9 |
| payments-cap.test.ts | cross-currency daily cap in the home currency; pre-check; fail closed (X2) | 4 passed | I5 |
| payments-cap-currency.test.ts | cap in PAYMENTS_DAILY_CAP_CURRENCY (KZT) converted to CNY, rounded down, fail closed | 3 passed | I5 |
| scheduler-demo.test.ts | scheduler, demo clock, rent autopay idempotent | 3 passed | I8 |
| settings-derived.test.ts | PATCH /settings returns `derivedChanges` and notifies SETTINGS_DERIVED_CHANGE | 2 passed | Y6 |
| summary-reasons.test.ts | order summary ends with reasonsSentenceEn(codes); reasonCodes stay structured | 1 passed | Y6 |
| webhooks.test.ts | HMAC webhooks; one-time card (second charge declined) | 7 passed | I13 |
| dev-login-pairing.test.ts | dev sign-in is off unless DEMO_ENABLED + DEV_LOGIN + a local or tunnel RP_ID; dev assert refused for KassaLite; KassaLite pairing | added after 2026-10-12 | SECURITY.md §7.0 |

## Rules, screening
| File | Flow | Actual | Maps to |
|---|---|---|---|
| rules/decide.test.ts | §10 evaluation order steps 1–9 | 49 passed | I6–I9 |
| rules/risk.test.ts | risk features, weights, score | 16 passed | risk score |
| rules/trigger-auto.test.ts | trigger drafts AUTO only inside a mandate | 3 passed | I6 |
| rules/mandate-scope.test.ts | mandate scope bound to the obligation: payee, category, period, amount ≤ bill (X1) | 10 passed | I2; PSD2 RTS Art. 5 |
| rules/small-auto-budget.test.ts | small-auto per-day budget, enforced in rules and payments (X3b) | 4 passed | I2 |
| screening/screening.test.ts | sanctions fuzzy + transliteration; IBAN; QR threshold | 32 passed | I9 |
| screening/every-rail.test.ts | sanctions screening on every rail, and at payee creation (X4) | 8 passed | I9 |

## Intelligence (`apps/api/test/intel/`)
| File | Flow | Actual |
|---|---|---|
| agent-loop.test.ts | 11 tools, propose_order only write; REFUSE stops loop; replay | 10 passed |
| reader.test.ts / reader-cross-turn.test.ts | evidence checks; mismatches carried across turns | 11 / 5 passed |
| redact.test.ts / redact-enum.test.ts | IBAN, PAN (Luhn), email, phone, names; enum passthrough | 11 / 7 passed |
| redact-ids.test.ts | UUIDs are never redacted; 5,000 random UUIDs; same-name payees (Y1) | 8 passed |
| parsers.test.ts, normalize-dedupe.test.ts, categorize.test.ts | capture parsing, dedupe, categorisation | 37 / 61 / 18 passed |
| y5-log-expense-catalog.test.ts | log_expense keywords; catalog placeholders (Y5) | 13 passed |
| y6-user-text.test.ts | plain-language reasons, merchant names, derived settings, placeholders (Y6) | 7 passed |
| fx-rates.test.ts, fx-routes.test.ts, forecast-fees.test.ts | rates, route optimizer, coverage forecast, fee x-ray | 18 / 9 / 18 passed |
| forecast-routes-y4.test.ts | top-up suggestion covers the first shortfall; same-currency routes (Y4) | 4 passed |
| budget-pace.test.ts, integration.test.ts, onboarding-replay.test.ts, record.test.ts, registry.test.ts, search-catalog-ref.test.ts, cn-recordings.test.ts | budgets, cross-module flows, replay, provider registry | 7 / 3 / 2 / 2 / 6 / 3 / 5 passed |

## Demos, baseline, sim
| File | Flow | Actual |
|---|---|---|
| demos/cn1-shanghai-handoff.test.ts | Shanghai handoff in CNY; swapped QR cancelled | 4 passed |
| demos/cn2-wallet-capture.test.ts | Alipay/WeChat capture; 4% hidden card fee | 3 passed |
| demos/cn3-li-wei.test.ts | second persona, CNY→EUR tuition; BOLA 404 | 8 passed |
| demos/wallet-p2p.test.ts | Add money (simulated wallet tap, test money) and Send to another Kassa user by Kassa ID ([SANDBOX_PAYMENTS.md](SANDBOX_PAYMENTS.md)) | added after 2026-10-12 |
| naive/naive-baseline.test.ts | raw agent intent without rules: 8 of 8 attacks pay | 10 passed |
| sim/sim-smoke.test.ts | sim CLI end to end on ports 4190–4192 | 1 passed |
| sim/sim-down.test.ts | `sim down` kills the whole daemon tree; a test sim stops when its owner dies (Y7) | 2 passed |

## Persona and attacker runs (Haiku 5.5 acting as user + planner, no real LLM)
- `docs/evidence/sim/p1/REPORT.md` — average user
- `docs/evidence/sim/p2/REPORT.md` — careful user
- `docs/evidence/sim/p3/REPORT.md` — bad actor
- `docs/evidence/sim/cn/REPORT.md` — Chinese-context demos + compromised planner
- `docs/evidence/sim/security/REPORT.md` — security scenario review (C1–C6, S1–S9, T1–T3)
- `docs/evidence/sim/SUMMARY.md` — summary

## Changelog
- 2026-10-12: catalogue created from the review run. Final fix pass: counts refreshed from the final `bun run test` (api 72 files / 633 tests, mock-world 6 / 279, shared 4 / 34, mobile 46 / 410) and rows added for the new and changed test files (X1–X10, Y1–Y7, cap currency, settings derived changes).
- 2026-10-14: workspace totals refreshed (api 101 files / 821 tests, mock-world 9 / 338, shared 7 / 53, mobile 65 / 526). Rows added for A9, dev sign-in and wallet P2P. Shared and mock-world totals re-run with `npx vitest run`; api and mobile totals from the team's latest full run.
- 2026-10-14 (later): totals re-run with `bun run test` after the live-AI round (api 104 files / 828 tests, 1 opt-in live smoke test skipped; mobile 65 / 527).
