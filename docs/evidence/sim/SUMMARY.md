# Simulation summary — 2026-10-12

Five Haiku 5.5 testers, each on an isolated local stack (offline example FX, no real LLM — the tester plays user and planner). Reports in the sub-folders.

| Run | Who | Result | Money moved wrongly? |
|---|---|---|---|
| [p1](p1/REPORT.md) | Average user (SMART) | 19 PASS / 8 FAIL (UX: missing payment notifications, top-up sizing, catalog ref, categorisation) | No |
| [p2](p2/REPORT.md) | Careful user (ASK_ME) | core controls PASS; 2 privacy FAIL (pre-seeded consent, other persona in export), 2 UX | No |
| [p3](p3/REPORT.md) | Bad actor + second user | 38 HELD / 4 BROKEN (sanctions only on bank rail, refresh after erase, UUID mis-redaction, shared placeholder) | No (card issued for a sanctioned merchant, lapsed unused) |
| [cn](cn/REPORT.md) | Chinese demos + compromised planner | demos match; 1 BROKEN (rent mandate covers any payment to the landlord) | Bounded: HUF 1,000 to the verified landlord without passkey |
| [security](security/REPORT.md) | Scenario review C1–C6, S1–S9, T1–T3 | 14 COVERED, 4 WEAK, 0 MISSING; findings F1–F9 | — |

All findings are tracked in docs/spec/PHASE2_PLAN.md ("Final fix pass") and fixed with regression tests; the "Fix status" column below is updated after the pass.

## Fix status
(pending)
