# Statement import and "Kassa learns your history": plan

Date: 2026-10-15. Status: done for the competition build (2026-10-15). Open follow-ups are listed under Handoff.

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
5. **Cards: last 4 digits only.** A masked `400000******7710` yields `3273`; a full PAN is never kept.
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
| S10 | App and KassaLite: file picker on web and native (guarded for builds without the module), preview with "What Kassa learned" | `apps/mobile/src/screens/settings/data-screen.tsx` | Done: web file input and expo-document-picker on native (guarded with `requireOptionalNativeModule`), chunked commits with progress; shared preview `import-preview.tsx` |
| S11 | Onboarding: the agent offers statement upload first, the draft is prefilled from history, the model gets aggregates only | `onboarding/service.ts`, onboarding chat screen | Done: `POST /onboarding/history`; the agent offers "Upload statements" right after the home currency; paperclip in the chat |
| S12 | Tests on synthetic statements in the three layouts (fictitious people and accounts); real statements are run locally only and never committed | `apps/api/test/dataport/` | Done: `statements.test.ts` (19), `import-file.test.ts` (4), mobile `commit-chunks.test.ts` (2) |
| S13 | Docs: README, SECURITY (new risks), PRIVACY (statement processing), TESTS | `docs/` | Done: README, SECURITY §5.3 (D1–D6) and R34–R35, PRIVACY §5 |
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

### The AI fallback on the real statements (Haiku as the Reader model)

The build container has no model key, so Claude Haiku stood in for the Reader model: it was given exactly what the app
sends (the redacted chunk and `STATEMENT_INSTRUCTIONS`) and its rows were put through the app's `verifyRow`.

| Chunk | Rows from the model | Passed the evidence check | Agree with the deterministic reader |
|---|---|---|---|
| Kaspi, chunks 1–2 | 402 | 401 | 401 of 403 |
| US bank, chunks 1–2 | 158 | 158 | 158 of 158 |
| Kazakh card bank, chunks 1–2 | 199 | 198 | (table layout: no line baseline) |

Redaction scan of everything that would reach a model, on all three real statements: 0 IBANs, 0 national ids,
0 account or full card numbers, 0 holder names or addresses (one leak, the holder's surname in a relative's feminine
form, was found and fixed before this count).

### In the app (web, Chromium, local stack)

A fresh user in onboarding taps the paperclip and picks the three real statements: the preview reads 1,501 rows in
about 3 s; "Use this history" imports 1,130 spending rows in chunks of 100 with progress, and the chat answers with
the code-written summary (money from home per parent, spending per category, fees, own transfers left out) and a
prefilled draft, in about 10 s.

## Handoff (what is left)

- Categories without a model key: about 45 % of merchants are "other". With a key, one batched Reader call names them.
  More dictionary keywords (Kazakh and Hungarian chains) would help the offline case.
- FX markup on history needs live rates; the build container cannot reach the rate sources. Check the "your card
  charged about X % over the mid rate" line on a machine with network access.
- The onboarding REPLAY recording does not include the "Upload statements" question; the paperclip works in REPLAY.
- `MOBILE BANK` style incomes (transfers whose sender the bank does not name) cannot be told from own transfers unless
  both statements are uploaded; the user can switch them off in the preview or the draft.
- A real KassaLite build needs `bun run lite:ios` again for the file picker (new native module); an older build gets a
  message instead of the picker.
