# Statement import and "Kassa learns your history": plan

Date: 2026-10-15. Status: in progress (this file is updated as items land).

## Why

Kassa's pitch is an agent that knows your past and acts from it. Before this work it learned the past only from the
onboarding chat (what the user typed) and from JSON imports. A student's real history sits in bank statements: PDFs
from Kaspi (kk), a Kazakh card bank (ru), a US bank (en), CSV and Excel exports from others. This plan makes those
the first thing the agent reads.

## What was wrong (found by running three real statements through the app)

| # | Problem | Effect |
|---|---|---|
| F1 | Import accepted JSON only (`POST /import/preview` → `JSON.parse`) | PDF, CSV, XLSX exports could not be imported at all |
| F2 | Native app had no file picker (paste only); KassaLite the same | A phone user could not import a file |
| F3 | Incoming money was dropped by the importer | Remittances from family (the core of Topic C) were invisible to the forecast |
| F4 | No separate debit / credit columns, no "amount in account currency" column | Bank tables with `Приход` / `Расход`, `Paid in` / `Paid out` mapped wrongly |
| F5 | Transfers between the user's own accounts were not recognised | Importing two banks double-counts the same money as spending and income |
| F6 | Imported foreign purchases never got their settled amount | The fee x-ray could not show what a card really charged |
| F7 | Every unknown merchant in an import made its own model call | A 1,000-row statement meant hundreds of sequential AI calls |
| F8 | Onboarding never asked for history | The agent asked the user to type numbers their bank already has |

## Design

```
file (PDF | CSV | TSV | XLSX | XLS | JSON | TXT)
  │ sniff by magic bytes (client type is untrusted)
  ├─ JSON ─────────────────────────────► record arrays ─┐
  ├─ CSV/TSV (UTF-8/16, Windows-1251) ─► grid ──────────┤
  ├─ XLSX/XLS (SheetJS) ───────────────► grid ──────────┤  header row found in the grid,
  ├─ PDF ruled tables (pdf-parse getTable) ► grid ──────┤  preamble kept as statement text
  └─ PDF/TXT text lines ──► date-led line rows ─────────┤
                                                        ▼
                         column mapping (existing synonyms + debit/credit, operation,
                         account-currency amount) → statement rows
                                                        │
              too few rows / unreadable? ── AI fallback (Reader model, redacted text,
                                            rows with evidence; evidence checked in code)
                                                        ▼
                     classify each row (code): purchase, fee, fx difference, transfer out,
                     income, own transfer, refund, cash; own transfers paired across files
                                                        ▼
                  history (code): incomes, recurring bills, monthly spend per category,
                  cards (last 4 only), FX fees paid → suggestions
                                                        ▼
             preview → user picks sections → commit (spending via capture, bills as
             placeholder payees, incomes to the profile, budgets with the passkey)
```

### Safety rules (the "never mess up an IBAN" list)

1. **No account detail from a statement is ever stored or used for paying.** Bills found in history become
   placeholder payees without an account (`addBills`, as onboarding does), so they are never payable until the user
   adds details and the payee cools down (I7).
2. **The model never sees account identifiers.** Before any AI call the text goes through the agent redactor (IBAN,
   card PAN) plus statement-specific detectors: account numbers (runs of 8+ digits), national IDs (KZ IIN/BIN,
   12 digits), authorisation and confirmation codes, the holder's name (profile and statement header), addresses
   and phone numbers in the header block.
3. **The model's output has no account fields.** The extraction schema has date, description, amount, currency,
   direction and evidence only. Any IBAN-shaped text left in a description is cut.
4. **Every AI row is checked against the source.** The evidence must occur in the redacted text, and the row's amount
   and date must occur in its evidence; rows that fail are dropped and counted.
5. **Cards: last 4 digits only.** A masked `441328******3273` yields `3273`; a full PAN is never kept.
6. **Import only adds things that loosen nothing.** Budgets still need the passkey (`PUT /budgets`), incomes only feed
   the forecast, spending goes through capture (I6: capture only logs).
7. **The onboarding model sees aggregates, not rows.** It gets "income from person_1, about 1,000 USD a month",
   never transaction lists or account numbers.

## Items

| ID | Item | Where | Status |
|---|---|---|---|
| S1 | File sniffing and readers: CSV/TSV with encoding and delimiter detection, XLSX (legacy XLS refused with a hint), OFX, PDF tables, PDF/TXT lines | `apps/api/src/modules/dataport/files.ts` | Done |
| S2 | Grid → records: header row detection, preamble kept, page-split rows merged | `dataport/grid.ts` | Done |
| S3 | Mapper: debit/credit columns, operation column, original vs account-currency amounts, account currency from the preamble | `dataport/mapper.ts` | Done |
| S4 | Line parser for statements without ruled tables (date-led lines, signed amounts, foreign amount line, continuation lines) | `dataport/lines.ts` | Done |
| S5 | Row classification and own-transfer detection (holder name, operation words, pairs across files) | `dataport/classify.ts` | Done |
| S6 | Redaction for statements | `dataport/redact.ts` | Done |
| S7 | AI fallback extraction with evidence checks; batched merchant categories | `dataport/ai.ts` | Done (no live key in the build container: evaluated with a mock model in tests and Haiku stand-ins, see Evaluation) |
| S8 | History insights: incomes, recurring bills, budgets, cards, FX fees | `dataport/history.ts` | Done |
| S9 | API: `POST /import/file` (multipart, several files), commit takes incomes and settled amounts (fee x-ray) | `dataport/routes.ts`, `service.ts` | Done (`POST /import/file`, up to 6 files, 10 MB each) |
| S10 | App and KassaLite: file picker on web and native (guarded for builds without the module), preview with "What Kassa learned" | `apps/mobile/src/screens/settings/data-screen.tsx` | |
| S11 | Onboarding: the agent offers statement upload first, the draft is prefilled from history, the model gets aggregates only | `onboarding/service.ts`, onboarding chat screen | |
| S12 | Tests on synthetic statements in the three layouts (fictitious people and accounts); real statements are run locally only and never committed | `apps/api/test/dataport/` | Done for the API (`test/dataport/statements.test.ts`, 19 tests) |
| S13 | Docs: README, SECURITY (new risks), PRIVACY (statement processing), TESTS | `docs/` | |

## Evaluation

The three real statements (Kaspi Gold kk, a Kazakh card bank ru, a US bank en) are run through `POST /import/file`
on a local stack. They stay outside the repository. Measured per file: rows found vs rows in the statement, totals
vs the statement's own totals, own transfers caught, and a scan of everything sent to the model for IBANs, IINs,
card numbers and the holder's name (must be zero).

### Results on the three real statements (local run, 2026-10-15, AI off, deterministic readers only)

| Statement | Reader | Rows | Check against the bank's own totals |
|---|---|---|---|
| US bank, 1 month, en | text lines | 158 | Card spending $2,422.35 and fees $55.44 exactly; deposits $2,450.00 exactly |
| Kaspi Gold, 12 months, kk | ruled tables | 472 | Purchases within 0.3 % of the bank's total (the bank nets small FX refunds in); transfers to the holder's other bank correctly excluded as own transfers |
| Kazakh card bank, 12 months, 3 accounts, ru | ruled tables, 77 pages | 871 | HUF purchases with the KZT actually charged; page-split rows joined; cancelled holds paired out |
| All three in one upload | | 1,501 | 73 own-transfer rows paired across banks and left out; family remittances found as monthly incomes |

Time: about 2.7 s for all three files. Known gaps: about 45 % of merchants fall to "other" without the AI category
call (the build container has no model key); the FX markup needs live rates (the container cannot reach the rate
sources, so the static example table is used and the markup is withheld rather than guessed).

## Handoff (what is left)

- S10: app and KassaLite file picker and the richer preview (`data-screen.tsx` is shared by both apps).
- S11: onboarding asks for statements; the server merges the history into the draft; the model sees aggregates only.
- S13: docs.
- Evaluation with Haiku stand-ins for the AI path (redacted chunks of the real statements → model rows → `verifyRow`).
- A parallel branch recreates real-world agent money attacks (Freysa, Grok/Bankrbot, AIXBT, memory injection) as
  A10+ in `apps/api/test/attacks/`; merge it after this work.
