# Kassa test catalogue

Counts from the 2026-10-12 review run (before the final fix pass; see "Changelog" at the end for later additions).

## How to run
- Everything: `bun run typecheck && bun run lint && bun run test` (turbo; all workspaces incl. mobile jest).
- API only: `bun run --cwd apps/api test`; one folder: `bun run --cwd apps/api vitest run test/attacks --reporter=verbose` (also `invariants`, `security`, `core`, `rules`, `screening`, `intel`, `demos`, `naive`, `sim`).
- Attack evidence: `bun run evidence:attacks` → `docs/evidence/attacks.json`, `docs/evidence/naive-baseline.json`.
- Ledger: `bun run db:migrate && bun run seed && bun run ledger:verify`.
- Simulation (personas, demos): `bun run sim …` — see `docs/evidence/sim/RUNBOOK.md`.

## Summary
| Workspace | Files | Tests | Result |
|---|---|---|---|
| apps/api | 52 | 519 | all pass |
| apps/mock-world | 6 | 279 | all pass |
| packages/shared | 4 | 34 | all pass |
| apps/mobile (jest) | 46 | 395 | all pass |

Guarded attack suite: **0 of 8 attacks paid**; naive baseline (no rules): **8 of 8 paid**.

## Attacks (`apps/api/test/attacks/`)
| File | Threat | Expected | Actual | Maps to |
|---|---|---|---|---|
| A1.test.ts | Hidden instruction in supplier price list (end to end) | no proposal for hidden account; REFUSE_SOURCE_MISMATCH; nothing paid | 4 passed | A1; I10 |
| A2.test.ts | "Landlord new IBAN" email | new COOLING payee; rent stays on verified account | 2 passed | A2; I7, I10 |
| A3.test.ts | Payment without approval, forged approval, replay | NO_APPROVAL, BAD_SIGNATURE, NONCE_USED; no money; ledgered | 4 passed | A3; I2, I4 |
| A4.test.ts | Loosen caps without passkey / before 24 h | passkey required; REFUSE_CAP until effective; tightening instant | 8 passed | A4; I8 |
| A5.test.ts | Swapped QR | QR_PAYEE_MISMATCH; CANCELED; no pay action | 3 passed | A5; I2, I3 |
| A6.test.ts | Sanctions (Cyrillic, transliterated, fuzzy) | REFUSE_SANCTIONS | 6 passed | A6; I9 |
| A7.test.ts | Fake POS trigger 10× | logged only; ASK TRIGGER_ORIGIN; REFUSE_CAP | 4 passed | A7; I6 |
| A8.test.ts | Lying confirmation; tampered order | canonical values shown; ORDER_HASH_MISMATCH | 3 passed | A8; I3 |

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

## Core (`apps/api/test/core/`)
| File | Flow | Actual | Maps to |
|---|---|---|---|
| auth.test.ts | passkey registration/login, single-use challenges, refresh rotation | 6 passed | I2 |
| flow.test.ts | end-to-end T2 (ask) and T1 (mandate) money paths | 2 passed | tiers |
| funding.test.ts | funding route bound into the signed order; INSUFFICIENT_FUNDS before signing | 5 passed | I2, I3 |
| ledger.test.ts | hash chain, checkpoints, tamper, forgery, concurrency | 7 passed | I12 |
| obligation-settlement.test.ts | no double payment per obligation period | 8 passed | idempotency |
| orders-onboarding.test.ts | canonical order over HTTP; expiry; BOLA | 5 passed | I3 |
| payees-mandates.test.ts | COOLING payees; IBAN validation; mandate passkey + 24 h | 4 passed | I7, I8 |
| payments.test.ts | independent verification in the payments module | 15 passed | I2–I5, I9 |
| scheduler-demo.test.ts | scheduler, demo clock, rent autopay idempotent | 3 passed | I8 |
| webhooks.test.ts | HMAC webhooks; one-time card (second charge declined) | 7 passed | I13 |

## Rules, screening
| File | Flow | Actual | Maps to |
|---|---|---|---|
| rules/decide.test.ts | §10 evaluation order steps 1–9 | 44 passed | I6–I9 |
| rules/risk.test.ts | risk features, weights, score | 16 passed | risk score |
| rules/trigger-auto.test.ts | trigger drafts AUTO only inside a mandate | 3 passed | I6 |
| screening/screening.test.ts | sanctions fuzzy + transliteration; IBAN; QR threshold | 32 passed | I9 |

## Intelligence (`apps/api/test/intel/`)
| File | Flow | Actual |
|---|---|---|
| agent-loop.test.ts | 11 tools, propose_order only write; REFUSE stops loop; replay | 10 passed |
| reader.test.ts / reader-cross-turn.test.ts | evidence checks; mismatches carried across turns | 11 / 5 passed |
| redact.test.ts / redact-enum.test.ts | IBAN, PAN (Luhn), email, phone, names; enum passthrough | 11 / 7 passed |
| parsers.test.ts, normalize-dedupe.test.ts, categorize.test.ts | capture parsing, dedupe, categorisation | 37 / 61 / 18 passed |
| fx-rates.test.ts, fx-routes.test.ts, forecast-fees.test.ts | rates, route optimizer, coverage forecast, fee x-ray | 18 / 9 / 18 passed |
| budget-pace.test.ts, integration.test.ts, onboarding-replay.test.ts, record.test.ts, registry.test.ts, search-catalog-ref.test.ts, cn-recordings.test.ts | budgets, cross-module flows, replay, provider registry | 7 / 3 / 2 / 2 / 6 / 3 / 5 passed |

## Demos, baseline, sim
| File | Flow | Actual |
|---|---|---|
| demos/cn1-shanghai-handoff.test.ts | Shanghai handoff in CNY; swapped QR cancelled | 4 passed |
| demos/cn2-wallet-capture.test.ts | Alipay/WeChat capture; 4% hidden card fee | 3 passed |
| demos/cn3-li-wei.test.ts | second persona, CNY→EUR tuition; BOLA 404 | 8 passed |
| naive/naive-baseline.test.ts | raw agent intent without rules: 8 of 8 attacks pay | 10 passed |
| sim/sim-smoke.test.ts | sim CLI end to end on ports 4190–4192 | 1 passed |

## Persona and attacker runs (Haiku 5.5 acting as user + planner, no real LLM)
- `docs/evidence/sim/p1/REPORT.md` — average user
- `docs/evidence/sim/p2/REPORT.md` — careful user
- `docs/evidence/sim/p3/REPORT.md` — bad actor
- `docs/evidence/sim/cn/REPORT.md` — Chinese-context demos + compromised planner
- `docs/evidence/sim/security/REPORT.md` — security scenario review (C1–C6, S1–S9, T1–T3)
- `docs/evidence/sim/SUMMARY.md` — summary

## Changelog
- 2026-10-12: catalogue created from the review run.
