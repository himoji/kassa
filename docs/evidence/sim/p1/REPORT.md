# P1 — average user (Dana, SMART preset) — 2026-10-12

Isolated sim: SIM_DIR=.data/sim-p1, ports 4110/4111/4119, offline example FX rates. Tester: an LLM acting as user + planner (Kassa's own model calls replayed).
Result: **19 PASS / 8 FAIL**; ledger-verify ok (39 entries). No security failures — all failures are UX/product issues.

| # | Step | Result | Note |
|---|---|---|---|
| 1 | Claim demo account | PASS | |
| 2 | Balances / forecast | FAIL | B2 top-up sized to horizon end, B1 |
| 3 | Planner answers "what's due" | PASS | |
| 4 | Tuition refused before funding (INSUFFICIENT_FUNDS) | PASS | |
| 5 | EUR→EUR routes | FAIL | B10 empty result |
| 6 | KZT→EUR routes | PASS | |
| 7 | Money from home | PASS | |
| 8 | Tuition proposal → ASK | PASS | |
| 9 | Canonical order hash matches | PASS | |
| 10 | Passkey approve | PASS | |
| 11 | Transfer reaches SENT | PASS | |
| 12 | Tuition PAYMENT_SENT notice | FAIL | B3 |
| 13 | Rent autopay at +3 d | PASS | |
| 14 | Rent notice details | FAIL | B5 generic text |
| 15 | Catalog search with seen placeholder | FAIL | B8 |
| 16 | Pizza → AUTO | PASS | |
| 17 | Checkout approved | PASS | |
| 18 | Second charge declined | PASS | |
| 19 | Pizza notice | FAIL | B3, B4 |
| 20–22 | Revolut / Wise / KZ bank capture + dedupe merge | PASS | |
| 23 | log_expense category | FAIL | B6 |
| 24 | Budget pace | PASS | |
| 25 | Recategorise | FAIL | B7 no sim command (API route exists) |
| 26 | Settlement fee x-ray | PASS | |
| 27 | ledger-verify | PASS | |

## Issues
- **B3 (high):** no PAYMENT_SENT notification for the tuition bank transfer or the pizza card charge (only rent produced one).
- **B2 (medium):** forecast HUF top-up suggestion KZT→HUF 37,905,000 by 11-01 while the 11-01 shortfall is 7,545,000 — sized to the end of the horizon, not the first shortfall.
- **B6 (medium):** `log_expense "coffee 1200 HUF"` → category "other"; capture files coffee under eating_out.
- **B8 (medium):** `search_catalog` rejects the `payee_1` placeholder the planner actually sees.
- **B5 (low):** rent autopay notice is a generic "Payment sent" without payee, amount, mandate.
- **B9 (low):** approval shows signed max ≈1% above the actual debit without explaining the margin.
- **B10 (low):** same-currency EUR→EUR route query returns nothing.
- **B7 (harness):** no `sim` command for recategorise.
- **B11 (harness):** `demo clock` returns before the mock bank webhook lands.
- Runbook fixes: capture source is `NOTIF_SIM`; approve is `as <p> approve`.

Evidence: `p1-week.json`, `ledger-verify.json` in this folder. (Report transcribed by the coordinator — the tester's file write was refused by the harness.)
