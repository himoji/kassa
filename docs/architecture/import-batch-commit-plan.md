# Plan: batched import commit (POST /import/commit)

Status: done (2026-10-20)

## Why
On the remote dev DB (~140 ms per query), a commit costs 1–3 s per row. Every imported row runs the live capture path one query at a time, about 25 round trips for a foreign purchase:
- `ingestCapture`: user, `matchCard` (all cards), `rememberedCategory`, `placeName` (all payees), insert = 5 queries.
- `ledger.append("CAPTURE_LOGGED")` = 6: BEGIN, advisory lock, head select, insert, head upsert, COMMIT.
- `sealPii`: user DEK, 0–1 (cached per process).
- `commitImport`: category update, 0–1.
- `reconcileSettlement` (foreign rows): user, tx select, update, `merchantDisplayName` (payees) = 4.
- `ledger.append("SETTLEMENT_RECONCILED")` = 6.
- `commitImport`: select cardId = 1.

## Change
This is a new import-only path. The live capture path (`ingestCapture`, `reconcileSettlement` in `apps/api/src/modules/capture/service.ts`) stays as it is.

1. **`ledger.appendMany(entries, tx)`** in `apps/api/src/modules/ledger/`, next to `appendInTx` in `internal.ts`:
   - Take the advisory lock once and read the head once.
   - Compute `seq`, `prevHash` and `hash` for each entry in order in code, using the same `entryHash` as `appendInTx`.
   - Write all entries in one multi-row insert.
   - Write a checkpoint for every `seq % CHECKPOINT_EVERY === 0`, with the same message as today.
   - Upsert the signed head once, with the last entry.
   - The chain must equal what N single appends would give at the same `now`. Test it by building the same entries both ways on two fresh PGlite DBs, comparing the rows, and running `verifyChain`.
2. **`importTransactions(userId, rows, db)`** in a new file, `apps/api/src/modules/capture/importBatch.ts`:
   - Read once per chunk: the user, the cards, the payees, `rememberedCategories` (already exists in `capture/service.ts`), and the DEK (`userDek`, `privacy/keys.ts`).
   - Per row, compute in code:
     - Card match: the same rules as `matchCard`, factored into a pure helper over the card list.
     - Home amount: `toHome`. Rates are already warmed by `warmRates` in `dataport/service.ts`.
     - Category: `categorize` with no reader fallback; the file's category wins, as today.
     - Place name: factor the pure part out of `placeName` so it takes the payee list.
     - Settlement: `settlementFee` with the warmed rates. Set status SETTLED directly when a settled amount is given, instead of PENDING and then reconcile. The columns must match what `reconcileSettlement` writes: `settledAmountMinor`, `settledCurrency`, `feeHomeMinor`, `status`.
   - A row whose rate or parse fails is counted as `failed` and left out before writing, as today.
   - Then run one `db.transaction`:
     - One multi-row insert into `transactions`, returning ids in order.
     - One `ledger.appendMany` holding, per row in order, `CAPTURE_LOGGED` (same payload, PII sealed with the DEK read once) and, for settled rows, `SETTLEMENT_RECONCILED` (same payload).
   - No notifications; today's import passes `notify: false` too.
3. **`commitImport`** in `apps/api/src/modules/dataport/service.ts` calls `importTransactions` for the chunk instead of the per-row loop. It keeps the dedupe pre-read (already one query), the fee-profile refresh once per (card, pair) at the end, and the response counts.
4. **Client** (`apps/mobile/src/lib/commit-chunks.ts`):
   - Once the server is fast, raise `COMMIT_CHUNK` from 50 to 200 and lower `COMMIT_TIMEOUT_MS` to 60 s.
   - Keep the 429 retry in `apps/mobile/src/api/hooks/dataport.ts`.
   - Keep the rule in `commitChunks` that never splits near-duplicate rows. Update its unit test.

## Invariants (must hold)
- The ledger hash chain, checkpoints and signed head must verify (`bun run --cwd apps/api ledger:verify` and the `verifyChain` tests). The advisory lock keeps other writers out between the lock and the commit.
- For the same input, transaction rows must be identical to today's: amounts, home amount, rate, category, card, place, dedupe key, settlement columns and fee. Write a golden test that imports a fixture both ways and compares the rows without ids.
- I6 (capture only logs, never pays) and I7 (imported bills are unpayable until details are added) are untouched.
- PII stays sealed per entry, so crypto-shredding by erasing the DEK still works.
- All-or-nothing per chunk is new and acceptable. A retry is safe, because dedupe counts the earlier rows as duplicates.

## Constraints
- Commit messages must have no Co-Authored-By trailer and no mention of Claude or Anthropic anywhere. The git author is already configured.
- Do not push. Prod deploys on every push to main.
- No native builds (expo run, xcodebuild, gradle, pod install). Leave no servers or processes running when you finish.
- Do not switch models or spawn subagents on other models.
- Never commit real bank statements or personal data. Tests use only synthetic, fictitious data.
- Tests run on in-memory PGlite (`createPgliteDb`). The remote DB in `.env` is slow (~140 ms per query) and is not needed for tests.

## Result
- `ledger.appendMany` / `appendManyInTx` (`ledger/internal.ts`), `importTransactions` (`capture/importBatch.ts`), pure
  `pickCard` / `placeNameAmong` (`capture/service.ts`), `sealPiiWith` (`privacy/keys.ts`); `commitImport` calls the batch.
- A 50-row chunk (drizzle statements, BEGIN/COMMIT not counted): per-row path 522; `importTransactions` 9 (its three
  reads run together, one round trip on postgres.js); the whole `commitImport` request 18.
- Tests: `test/core/ledger-append-many.test.ts` (same entries, checkpoints and head as single appends; both verify),
  `test/dataport/import-batch.test.ts` (golden against the old per-row path in `test/helpers/importLegacy.ts`, query count).
- Kept as the live path logged it: `CAPTURE_LOGGED.category` is the guessed category, not the file's own one that
  the row carries.
- Client: 200 rows a chunk, 60 s timeout.
