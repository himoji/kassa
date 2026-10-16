# Security review — compromised agent, services and triggers (2026-10-12)

Reviewer: Haiku 5.5 (read-only; ran the Vitest suites and read the code). Scope: RUNBOOK §5 security scenarios C1–C6, S1–S9, T1–T3; invariants I1–I13; attack suite A1–A8. Transcribed by the coordinator (the reviewer's file write was refused by the harness). Findings F1–F9 were addressed in the follow-up fix pass.

## 1. Runs
| Command (apps/api) | Result |
|---|---|
| vitest test/attacks | 8 files, 34 passed |
| vitest test/invariants test/security test/naive | 8 files, 79 passed |
| vitest test/core test/rules test/screening test/sim | 15 files, 158 passed |
| vitest test/intel test/demos | 21 files, 248 passed |
| full API suite | 52 files, 519 passed |
| mock-world / shared | 279 / 34 passed |
| `bun run ledger:verify` (fresh seed) | ok (1 entry, 0 checkpoints — proves little on a fresh DB) |

## 2. Scenario verdicts
COVERED = test exists, passes and asserts the threat outcome; WEAK = passes but part of the threat isn't asserted.

| ID | Threat | Verdict | Evidence / reasoning |
|---|---|---|---|
| C1 | Planner pays directly | COVERED | intel/agent-loop (propose_order only write), invariants I1 (transitive import graph), attacks/A3, core/payments |
| C2 | Forged approval | COVERED | A3 BAD_SIGNATURE, core/payments tampered/tier upgrade |
| C3 | Replay | COVERED | A3 NONCE_USED / NOT_PENDING; assertion replay checked via order state only |
| C4 | Tampered order / lying confirmation | COVERED | core/payments ORDER_HASH_MISMATCH, core/orders-onboarding, A8 |
| C5 | Prompt injection (PDF, lookalike email) | COVERED | A1, A2 end to end; intel/reader, reader-cross-turn |
| C6 | Inject new payee; PII exfiltration | WEAK | Post-cooling path untested: verify-callback is session-only → payee VERIFIED → small auto without passkey (F1) |
| S1 | Stolen rules key | WEAK | T2/T1-mandate negatives real; no payments-level negative for missing base-rules assertion |
| S2 | Forged webhooks | COVERED | core/webhooks 401s, I13 |
| S3 | Replayed/stale webhooks | COVERED | security/webhook-replay |
| S4 | Swapped QR | COVERED | A5 end to end |
| S5 | Malicious Reader output | COVERED | intel/reader, agent-loop, reader-cross-turn |
| S6 | Tampered ledger row | COVERED | core/ledger; tail truncation after last checkpoint undetected (F5) |
| S7 | Demo token | COVERED | security/http-hardening |
| S8 | Fake issuing abuse | COVERED | core/webhooks (fake issuer only) |
| S9 | Malicious bank status | COVERED | security/webhook-replay; forward-valid lie accepted (honest limit) |
| T1 | POS 10× | COVERED | A7, rules/trigger-auto |
| T2 | Shortcut token abuse | WEAK | only no-token case tested |
| T3 | Notification injection | WEAK | no injected-text fixture; structure sound (capture doesn't import rules) |

Totals: COVERED 14, WEAK 4, MISSING 0, FAILING 0.

## 3. Findings (prioritised)
1. **F3 (high, confirmed):** payments daily cap sums same-currency payments only; mixed-currency day can exceed the home-currency cap. I5 test codifies per-currency. Fix: sum all non-failed payments of the day in home currency; test cross-currency.
2. **F1 (high, code reading):** `POST /payees/:id/verify-callback` verifies with a session only; small auto then pays the new payee without a passkey. Fix: passkey for verification and/or no small-auto for newly verified payees; test.
3. **F2 (medium, design):** a prompt-injected planner can spend up to the daily cap through repeated small-auto payments. Add a per-day AUTO count/amount budget and a sequence test.
4. **F5 (medium):** ledger tail (entries after the last checkpoint) can be truncated/re-hashed undetected. Fix: signed head anchor; test truncation.
5. **F6 (medium):** sanctions screening only on bank transfers; card and QR handoff payees unscreened.
6. **F4/F7/F8/F9 (medium–low):** trigger drafts inside mandates → AUTO; dictionary-based name redaction misses unknown names; missing tests for wrong/revoked Shortcut token, injected notification text, payments-level base-rules negative; API and mock-world share `MOCK_HMAC_SECRET`.
7. **Stale docs:** RUNBOOK §5 and SECURITY R4/R24 still list gaps that tests now cover.

## 4. Process
Reviewer killed 3 orphaned sim daemon trees (parent PID 1) left by sim-smoke runs; `sim-smoke` `afterAll` cleanup needs fixing. Ports 4000/4001/4099/4190–4192 clear afterwards.
