# P2 — careful user (Dana, ASK_ME preset) — 2026-10-12

Isolated sim: SIM_DIR=.data/sim-p2, ports 4120/4121/4129. Tester: an LLM as user + planner. ledger-verify ok (40 entries).

| # | Step | Result | Note |
|---|---|---|---|
| 1a | Deliberate AI consent | FAIL | B1: claimed demo account is pre-consented (seed backdates consent to 2026-09-20); `--no-ai-consent` ignored |
| 1b | Data export contains only her data | FAIL | B2: export includes Li Wei's userId/slug via the seed's DEMO_SEEDED ledger entry |
| 2 | Preset → ASK_ME (tightening, instant) | PASS (B6) | B6: ASK_ME silently flips moneyMode CAPPED_WALLET → PAY_IN_PLACE |
| 3 | ASK for every order (incl. €96); reject → can't approve (NOT_PENDING); re-propose + approve | PASS | |
| 4 | Lower cap instant; raise needs passkey + 24 h | PASS | |
| 5 | Revoke rent mandate → no autopay at +3 d | PASS (weak) | ASK_ME already blocks autopay; rerun under SMART needed |
| 6 | Freeze → REFUSE_FROZEN; unfreeze passkey + 24 h | PASS | |
| 7 | Restrict processing → agent refuses PROCESSING_RESTRICTED | PASS | |

## Issues
- **B1 (privacy, high):** demo seed grants AI consent for the claimed account; consent must be given deliberately (GDPR Art. 7, EU AI Act Art. 50 notice).
- **B2 (privacy, high):** cross-user data in export — seed ledger entry references the second persona.
- **B3 (medium):** approving an expired order silently re-issues and re-signs a new canonical order (ledger seq 32) instead of telling the user it expired and showing the new order first.
- **B6 (medium):** preset change silently changes money mode; must be explicit and shown to the user.
(Report transcribed by the coordinator — the tester's file write was refused by the harness.)
