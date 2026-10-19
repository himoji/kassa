# Simulation summary — 2026-10-12

Five LLM testers, each on an isolated local stack (offline example FX). The tester model played both the user and the planner through the API; Kassa's own model calls were replayed, so these runs test the product's guards, not its live planner. Reports in the sub-folders.

| Run | Who | Result | Money moved wrongly? |
|---|---|---|---|
| [p1](p1/REPORT.md) | Average user (SMART) | 19 PASS / 8 FAIL (UX: missing payment notifications, top-up sizing, catalog ref, categorisation) | No |
| [p2](p2/REPORT.md) | Careful user (ASK_ME) | core controls PASS; 2 privacy FAIL (pre-seeded consent, other persona in export), 2 UX | No |
| [p3](p3/REPORT.md) | Bad actor + second user | 38 HELD / 4 BROKEN (sanctions only on bank rail, refresh after erase, UUID mis-redaction, shared placeholder) | No (card issued for a sanctioned merchant, lapsed unused) |
| [cn](cn/REPORT.md) | Chinese demos + compromised planner | demos match; 1 BROKEN (rent mandate covers any payment to the landlord) | Bounded: HUF 1,000 to the verified landlord without passkey |
| [security](security/REPORT.md) | Scenario review C1–C6, S1–S9, T1–T3 | 14 COVERED, 4 WEAK, 0 MISSING; findings F1–F9 | — |

All findings were tracked in a final fix pass. 42 of the 46 rows below are fixed, each with a regression test; the other 4 (O5, F4, F7, F9) are accepted risks, bounded and recorded in SECURITY.md. The "Status" column is updated after the pass.

## Fix status

Test paths are relative to `apps/api/`. "Accepted risk" rows are bounded or accepted and are recorded in [SECURITY.md](../../SECURITY.md) (section given in the last column).

| Report | Finding | Fix item | Test file | Status |
|---|---|---|---|---|
| p1 | B3 no PAYMENT_SENT for tuition or pizza card charge | X9 | `test/core/payment-notifications.test.ts` | Fixed |
| p1 | B2 top-up sized to the horizon end, not the first shortfall | Y4 | `test/intel/forecast-routes-y4.test.ts` | Fixed |
| p1 | B6 `log_expense` "coffee" categorised as "other" | Y5 | `test/intel/y5-log-expense-catalog.test.ts` | Fixed |
| p1 | B8 `search_catalog` rejects the `payee_1` placeholder | Y5 | `test/intel/y5-log-expense-catalog.test.ts` | Fixed |
| p1 | B5 rent notice generic (no payee, amount, mandate) | X9 | `test/core/payment-notifications.test.ts` | Fixed |
| p1 | B9 signed max about 1% above the debit, margin unexplained | Y6 | `test/intel/y6-user-text.test.ts` | Fixed |
| p1 | B10 same-currency EUR→EUR route empty | Y4 | `test/intel/forecast-routes-y4.test.ts` | Fixed |
| p1 | B7 no `sim` command for recategorise | Y7 (harness, `scripts/sim/cli.ts`) | none (exercised by the sim runbook) | Fixed |
| p1 | B11 `demo clock` returns before the mock bank webhook lands | Y7 (harness, `scripts/sim/lib/commands.ts`) | none (exercised by the sim runbook) | Fixed |
| p2 | B1 AI consent pre-given for the claimed demo account | Y2 | `test/security/seed-privacy.test.ts` | Fixed |
| p2 | B2 export contains the other persona's identifiers | Y2 | `test/security/seed-privacy.test.ts` | Fixed |
| p2 | B3 expired order silently re-issued and re-signed | X8 | `test/core/order-expiry.test.ts` | Fixed |
| p2 | B6 preset change silently changes money mode | Y6 (+ `derivedChanges` and `SETTINGS_DERIVED_CHANGE`) | `test/core/settings-derived.test.ts`; `test/intel/y6-user-text.test.ts` | Fixed |
| p3 | B1 sanctions screening only on bank transfers (card issued for a sanctioned merchant) | X4 | `test/screening/every-rail.test.ts` | Fixed |
| p3 | B2 refresh still works for an erased user | X5 | `test/security/erase-refresh.test.ts` | Fixed |
| p3 | B3 redactor corrupts a UUID (card detector inside an id) | Y1 | `test/intel/redact-ids.test.ts` | Fixed |
| p3 | B4 same-name payees share one placeholder | Y1 | `test/intel/redact-ids.test.ts` | Fixed |
| p3 | O1 daily cap ASK, then refused at approval | X2 | `test/core/payments-cap.test.ts` | Fixed |
| p3 | O2 Reader account checked against document text, not the payee's account | Reader cross-turn checks (`readerChecksFor`, B1) | `test/intel/reader-cross-turn.test.ts` ("swapped-account invoice … is refused") | Fixed |
| p3 | O4 expired orders reopened on read | X8 | `test/core/order-expiry.test.ts` | Fixed |
| p3 | O5 daemon received SIGTERM mid-run (restarted) | Y7 (orphan daemons, `sim down`) | `test/sim/sim-down.test.ts` | Accepted risk (harness restart; SECURITY.md R13 for in-memory state) |
| cn | Part A: swapped-QR check runs after the passkey approval | X7 | `test/attacks/A5.test.ts` | Fixed |
| cn | Part A: PIPL separate consent not asked | Y3 | `test/security/pipl-consent.test.ts` | Fixed |
| cn | Part A: CNY notifications lack the KZT equivalent | Y6 | `test/intel/y6-user-text.test.ts` | Fixed |
| cn | Part A: normalised merchant keys leak into the UI | Y6 | `test/intel/y6-user-text.test.ts` | Fixed |
| cn | Part A: summaries show placeholders | Y6 | `test/intel/y6-user-text.test.ts` | Fixed |
| cn | Part A: raw reason codes in text | Y6 (`reasonsSentenceEn`, rules `summarize()`) | `test/core/summary-reasons.test.ts`; `test/intel/y6-user-text.test.ts` | Fixed |
| cn | Part A: `exampleValues: false` while example rates are used | Y6 | `test/intel/y6-user-text.test.ts` | Fixed |
| cn | Part A: D-CN3 top-up suggestion CNY→HUF far above the dated shortfall | Y4 | `test/intel/forecast-routes-y4.test.ts` | Fixed |
| cn | Part B B5a (bounded): HUF 1,000 to the verified landlord under the rent mandate, no passkey | X1 | `test/rules/mandate-scope.test.ts` | Fixed |
| cn | Part B B1d: no amount-vs-obligation check | X1 | `test/rules/mandate-scope.test.ts` | Fixed |
| security | F1 `verify-callback` with a session only; small auto then pays without a passkey (also C6) | X3a | `test/security/payee-verify.test.ts` | Fixed |
| security | F2 prompt-injected planner spends up to the daily cap through small auto | X3b | `test/rules/small-auto-budget.test.ts` | Fixed |
| security | F3 payments daily cap sums same-currency payments only (also R3) | X2 | `test/core/payments-cap.test.ts`; `test/core/payments-cap-currency.test.ts` | Fixed |
| security | F4 trigger drafts inside a mandate go AUTO | I6 (the mandate is the authorisation; X1 binds its scope) | `test/rules/trigger-auto.test.ts` | Accepted risk (SECURITY.md §3, I6) |
| security | F5 ledger tail truncation or re-hash after the last checkpoint undetected | X6 | `test/core/ledger-head.test.ts` | Fixed (rollback to an older head: SECURITY.md R28) |
| security | F6 sanctions screening only on bank transfers (card and QR payees unscreened) | X4 | `test/screening/every-rail.test.ts` | Fixed |
| security | F7 dictionary-based name redaction misses unknown names | Y1 (the redactor) | `test/intel/redact.test.ts` | Accepted risk (SECURITY.md R29) |
| security | F8 missing tests: wrong or revoked Shortcut token, injected notification text, payments base-rules negative | X10 | `test/security/x10-triggers.test.ts` | Fixed |
| security | F9 API and mock-world share `MOCK_HMAC_SECRET` | none in code | n/a | Accepted risk (SECURITY.md R26) |
| security | Stale docs: SECURITY R4 and R24 | docs | n/a | Fixed (SECURITY.md R4 mitigated, R24 closed) |
| security | C6 WEAK: post-cooling path untested | X3a | `test/security/payee-verify.test.ts` | Fixed |
| security | S1 WEAK: no payments-level negative for a missing base-rules assertion | X10 | `test/security/x10-triggers.test.ts` | Fixed |
| security | T2 WEAK: only the no-token Shortcut case tested | X10 | `test/security/x10-triggers.test.ts` | Fixed |
| security | T3 WEAK: no injected-notification fixture | X10 | `test/security/x10-triggers.test.ts` | Fixed |
| security | Process: orphaned sim daemons after sim-smoke runs | Y7 | `test/sim/sim-down.test.ts` | Fixed |

Other items recorded in the security review (for example, the `RUNBOOK.md` §5 gap list) are not part of the fix list; check [SECURITY.md](../../SECURITY.md) §7 for what is still open.
