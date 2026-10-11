# Phase 2 plan (written 2026-10-11) — read this if resuming in a new session

## User requirements (2026-10-11)
- No Docker on this Mac. Run everything natively with bun; DB = file-backed PGlite for local dev.
- Mock companies use plain descriptive generic names, e.g. "Pizza Supplier from EU", "Buy Everything Shop from China", "Landlord in Budapest", "University in Budapest", "Student Insurer in EU", "Pizza Shop in Budapest", "QR Wallet (simulated)". Rename all mock entities in fixtures/ + apps/mock-world + any tests/locales that reference them.
- Do NOT build the Expo app and do NOT call real AI APIs for the final test.
- Final test = Haiku 5.5 (medium) subagents acting as personas and attackers, driving the system through scripts:
  - personas: average user, careful/good user, bad actor (user trying to abuse limits);
  - security: compromised agent (planner tries to pay directly, forge approvals, replay nonces, inject payees, exceed caps), compromised services (stolen rules signing key without passkey, forged/replayed mock webhooks, swapped QR, malicious supplier PDF / reader returning wrong amount, lookalike-IBAN email, tampered ledger row, demo token misuse), compromised trigger (fake POS 10x order, Shortcut token abuse).
  - Haiku is the "LLM": it reads tool outputs from the sim CLI and decides; no provider API keys.
  - Each run writes a report to docs/evidence/sim/<scenario>.md (steps, expected, actual, PASS/FAIL, ledger slice) and a summary table docs/evidence/sim/SUMMARY.md.
- After ALL work is done: stop every server/background process started for this project, verify nothing is left (no shells blocked on stdin e.g. `cat` children of zsh, no bun/node servers on ports 4000/4001/8081, no caffeinate / keep-awake, no running Claude background tasks, no PGlite locks), then put the Mac to sleep with `pmset sleepnow`. If a session limit interrupts, the next session must finish the work and then do this.

## Steps
1. Wait for Phase 1 tracks A (core) and B (intelligence) to finish; run root typecheck/lint/test; commit.
2. Haiku: rename mock entities (exact mapping table given in its prompt); re-run mock-world + api tests.
3. Dev (Opus): `apps/api/scripts/sim/` CLI (`bun run sim <cmd> --json`): start/stop local stack (PGlite, api, mock-world on 4000/4001), seed, soft WebAuthn authenticator (generates ES256 credential, signs assertions for a given challenge — the "user's finger"), and commands exposing every agent tool + user actions (approve/reject order, create mandate, change settings, freeze), plus raw attack primitives (direct payments call, forged approval with stolen rules key, replay, forged webhook with/without HMAC, demo clock advance). Agent planner replaced by the caller: `sim agent-tool <name> <json>` goes through the same redaction + rules path as the real agent.
4. Vitest attack suite A1–A8 + naive baseline (deterministic, no LLM).
5. Haiku persona/attacker runs (parallel), reports under docs/evidence/sim/.
6. Fix failures (Opus dev for security fixes), re-run failed scenarios.
7. `bun run ledger:verify`, `demo:evidence`, docs (README run-locally-without-docker, SECURITY.md, TESTS.md), commit.
8. Cleanup + `pmset sleepnow` (see above).

## Competition brief (docs/spec/fintechathon-2026-brief.pdf, scanned) — key facts
- Theme "AI as a Financial Participant"; Topic C. Scoring: task completion 40%, security & compliance 30%, innovation & interaction 30%.
- Deadline Oct 20 2026 23:59 Beijing (15:59 UTC). English only.
- Submission: technical documentation (architecture, core algorithm, security design); deck ≤10 min; demo video OPTIONAL ≤5 min; source code (README, GitHub link, deployment instructions, test cases); security self-assessment report (permission-tier implementation + known-risk list); execution evidence (simulated/sandbox operation logs).
- Integrity: third-party code/data must be properly licensed (→ ReadyNative licence resolved: the licensor is a Kassa author and permits publication in this repo; Kassa code is MIT, root `LICENSE`).

## Security & compliance hardening workstream (user request 2026-10-11: "GDPR, zero trust, etc")
Code (Opus dev, security-critical):
- Zero trust: every route authenticated + authorised per resource (ownership checks → no IDOR, OWASP API1), no trust from network location, service-to-service calls authenticated (HMAC/signed approvals, already), short-lived tokens, least-privilege keys per module, deny-by-default route registration, rate limiting (@fastify/rate-limit), strict CORS, security headers (@fastify/helmet), request size limits, input validation everywhere (zod), secrets only from env, structured audit log of auth decisions.
- GDPR: data map + minimisation; lawful basis recorded; DSAR endpoints — Art. 15 access + Art. 20 portability export (JSON), Art. 16 rectification, Art. 17 erasure via crypto-shredding (per-user data key; ledger keeps hashes but personal payload fields encrypted with the user key so erasure doesn't break the hash chain), Art. 18 restriction (freeze); retention policy + purge job; consent/notice for AI processing (Art. 13, EU AI Act Art. 50 transparency — "you are talking to an AI"); I11 redaction before any LLM call + provider choice incl. local model for data residency; PIPL note for CN region; no PANs stored (PCI DSS scope reduction, last4 only).
- OWASP Top 10 for LLM apps: prompt injection (Reader quarantine I10), insecure output handling (sheet renders canonical order only), excessive agency (I1), sensitive info disclosure (I11).
Docs (Haiku drafts from explicit outlines, Opus reviews): docs/SECURITY.md (tier table ↔ code ↔ tests, threat model STRIDE, known risks, honest limit §2), docs/PRIVACY.md (GDPR Art. 30 record of processing, DPIA summary Art. 35, data flows, retention, DSAR), docs/COMPLIANCE.md (PSD2 SCA RTS Art. 5 dynamic linking, EU IPR Verification of Payee, GDPR, PIPL, PCI DSS scope, NIST SP 800-63B AAL2 for passkeys, OWASP ASVS L2 / API Top 10 / LLM Top 10 mapping, EU AI Act transparency, ISO 27001 Annex A highlights), docs/TESTS.md.
Sim scenarios added for: IDOR (user B reads/approves user A's order), DSAR export/erasure then ledger:verify still passes, rate-limit/brute force, cross-user placeholder leakage, LLM prompt-injection exfiltration attempt.

## Progress log
- 2026-10-11: Phase 1 committed (2bb2292), 1,040 tests green. env:setup script added; Track A decisions resolved (DECISIONS.md). Onboarding replay recording added.
- 2026-10-11: Phase 2 started in parallel: (a) Haiku rename of mock names, (b) Opus hardening (zero trust, GDPR, unfreeze, audit log), (c) Opus sim CLI + RUNBOOK (docs/evidence/sim/RUNBOOK.md). Next: Vitest attack suite A1–A8 + naive baseline; Haiku persona/attacker runs; docs (SECURITY/PRIVACY/COMPLIANCE/TESTS/README); final commit; cleanup + `pmset sleepnow`.
- 2026-10-11: Fixed B1 (Reader checks persisted per docId apply across turns; `propose_order.docIds`), B2 (funding route
  signed in the canonical order, `INSUFFICIENT_FUNDS`, `FUNDING_ABOVE_SIGNED_MAX`) and B4 (`obligation_settlements`,
  migration 0002, `DUPLICATE_OBLIGATION_PAYMENT`). Details and the demo-story numbers: DECISIONS.md 2026-10-11 "Phase 2
  bug fixes B1, B2, B4"; contract notes in PHASE1_COORDINATION.md.
- 2026-10-11: Attack suite A1–A8 + naive baseline + invariant index + webhook hardening done (api 495 tests). Bugs found
  and fixed by the new tests: (1) I1 transitive: `agent/ports → rules/facts → rails/mockBank` (wallet balances) — the
  wallet reader is now registered in `orders/wiring.ts`; (2) A7: a trigger-originated REFUSE_CAP dropped the
  `TRIGGER_ORIGIN` anomaly flag; (3) R5: webhook replay inside the window (seen-signature store, migration 0003);
  (4) R6/S9: signed mock-bank status events were trusted as-is (unknown states mapped to PROCESSING; backwards moves,
  other users' profiles and SENT-before-funding accepted). Evidence: guarded 0/8 paid, naive 8/8 paid.

## Known bugs to fix
- **Reader checks lost across turns (I10).** `propose_order` builds `readerChecks` from `ctx.readDocs`, which holds
  only documents read in the current turn plus those loaded by `dbTurnStore.readDocs()`. That loader selects
  `agent_documents` rows by `conversationId`, so a document uploaded **without** a `conversationId` (the field is
  optional on `POST /agent/documents`), read in one turn, then paid in a later turn produces a proposal with
  `readerChecks: null`. A Reader amount/account mismatch (`READER_SOURCE_MISMATCH`, rules step 3) is then not
  applied. Found by code reading while building the sim (apps/api/src/modules/agent/tools.ts `readerChecksFor`,
  agent/store.ts `readDocs`); not yet reproduced by a test. Fix in apps/api/src (security owner); add a test.

### More known bugs (found by sim run, 2026-10-11)
- B2 Bank transfer rail pays only from the order-currency balance and never converts → tuition (€2,400 vs €300) and rent (HUF 180k vs 120k) end in RAIL_ERROR after approval. Fix: the mock-bank quote's source currency = funding currency of the cheapest feasible route (fx/routes, spec §12; Wise quote source≠target), chosen at proposal time and recorded in the canonical order (purpose/rail metadata signed) or a separate funding field; rules should REFUSE/ASK with a clear code (e.g. INSUFFICIENT_FUNDS) when no funding currency covers it, before the user signs.
- B3 agent/redact.ts redacts enum values: payeeKind "LANDLORD" became "payee_2" because the payee's name "Landlord in Budapest" contains the token. Names must be matched as whole names, never inside structured enum fields.
- B4 Scheduler re-proposes an obligation already paid (second tuition proposal after +3d) → double-payment risk. Track obligation settlement (paid period) and skip; idempotency key per obligation+period.
- B5 search_catalog returns items without a payee reference, so the planner can't propose a merchant order without a free-text hint. Return the merchant's payee placeholder.
- ~~Test gaps to close in the attack suite: A1 e2e, A5 e2e, A7 e2e, webhook replay inside the 5-minute window (needs a seen-signature/nonce cache), malicious mock-bank status sequence.~~
  **Closed 2026-10-11.** `apps/api/test/attacks/A1..A8.test.ts` (one file per §19 attack; A1, A2, A5, A7 end to end with
  the in-process mock world, scripted planner/Reader models, no real AI); webhook replay store
  (`webhook_seen_signatures`, migration 0003, `webhooks/replay.ts`, 409 `WEBHOOK_REPLAYED`, purged by the scheduler) and
  mock-bank status validation (`bankEventRejection` in `webhooks/routes.ts`: unknown state, other user's profile,
  backwards move, move after final, SENT before funding → 409 `WEBHOOK_REJECTED` + ledger) in
  `test/security/webhook-replay.test.ts`; naive baseline `test/naive/`; invariant index `test/invariants/I1-I13.test.ts`
  (I1 = transitive import graph). `bun run evidence:attacks` writes `docs/evidence/attacks.json` and
  `docs/evidence/naive-baseline.json`.

## Chinese-context demos (user request 2026-10-11 — judges are Chinese)
After the attack suite lands (it reads the seed), add a few demos with Chinese context, without new product features (fixtures, replay recordings, sim scenarios, demo triggers):
- D-CN1 Shanghai exchange semester: Dana's region switch to CN → HANDOFF; buy from "Buy Everything Shop from China" and pay the "Dorm Office in Shanghai" via "QR Wallet (simulated)"; swapped-QR attack caught (A5); PIPL note.
- D-CN2 Alipay/WeChat Pay spending capture (CN notification samples) → auto-logged in CNY, converted to KZT at the purchase-date rate, budget notification; fee x-ray on a CNY card charge (DCC flag).
- D-CN3 Second seeded persona "Li Wei", a Chinese master's student in Budapest (home CNY; parents remit CNY monthly; HUF rent, EUR tuition) — shows the same engine for a Chinese user: CNY→EUR tuition route comparison, CNY coverage forecast. Also gives the BOLA/cross-user tests a realistic second user.
- Agent recordings for each (REPLAY), RUNBOOK scenarios, and Haiku persona runs include them.
- New Opus subagents get docs/spec/AGENT_BRIEFING.md first.
- 2026-10-12: committed 66bd744 (attack suite, baseline, invariants, webhook replay, CI) and 2978995 (Chinese demos D-CN1..3, trigger→mandate rule, SECURITY refresh). 1,227 tests green.
- 2026-10-12: final Haiku runs launched in parallel, each on an isolated sim (SIM_DIR=.data/sim-<id>, ports 41x0/41x1/41x9): p1 average, p2 careful, p3 bad actor, cn (CN demos + compromised planner), security (Vitest scenario review + docs/TESTS.md). Reports → docs/evidence/sim/<id>/REPORT.md.
- Remaining after that: triage BROKEN/FAIL items (fix with Opus dev), aggregate docs/evidence/sim/SUMMARY.md, fix SECURITY.md R24 (A1/A5/A7 e2e now exist) + TESTS.md link, mobile jest "worker failed to exit gracefully" leak warning, final commit, cleanup (.data/sim-* daemons, ports 4000-4149), `pmset sleepnow`.

## Final fix pass (from sim reports 2026-10-12; see docs/evidence/sim/*/REPORT.md)
Track X — money path & security (Opus): 
- X1 mandate scope: AUTO under a mandate only for drafts linked to an obligation whose payee+category are in the mandate and amount ≤ the obligation amount (cn B5a). Other drafts to that payee → ASK.
- X2 payments daily cap summed across currencies in home currency (F3); rules pre-check payments cap usage so the user isn't asked then refused (p3 O1).
- X3 payee verify-callback requires a passkey assertion (F1); per-day small-auto budget (count + amount) (F2).
- X4 sanctions screening on every rail and at payee creation (F6, p3 B1).
- X5 erase revokes all refresh tokens / refresh refuses erased users (p3 B2).
- X6 ledger head anchor so tail truncation/re-hash after the last checkpoint is detected (F5).
- X7 handoff QR payee-name check before the passkey prompt (cn note 1).
- X8 approve never silently re-issues an expired order: 410 ORDER_EXPIRED + new order to review (p2 B3).
- X9 PAYMENT_SENT notifications for bank transfers and card charges, with payee, amount (original + home), mandate when T1 (p1 B3, B5).
- X10 tests: wrong/revoked Shortcut token, injected notification text, payments-level missing base-rules negative (security WEAK items); rerun "revoke mandate under SMART → no autopay".
Track Y — agent, data, UX, sim (Opus):
- Y1 redactor must not match inside UUIDs/ids (p3 B3); placeholders keyed by payee id not name (p3 B4).
- Y2 seed: claimed demo account not pre-consented unless the sim asks; seed ledger entries scoped per user (p2 B1, B2).
- Y3 PIPL: region CN requires a separate cross-border consent before agent processing (cn note 2).
- Y4 forecast top-up sized to the first shortfall (+ reserve) (p1 B2, cn D-CN3); same-currency routes return a direct route (p1 B10).
- Y5 log_expense uses the capture categoriser (p1 B6); search_catalog accepts payee placeholders (p1 B8).
- Y6 user-facing text: pretty merchant names (not normalised keys), names re-hydrated (no placeholders shown to users), plain-language reason codes, home-currency equivalent on CNY notifications, fees exampleValues flag correct (cn notes 3–7); ASK_ME preset's derived moneyMode shown explicitly (p2 B6); signed-max margin explained (p1 B9).
- Y7 sim: recategorise command, `demo clock` waits for pending mock-bank webhooks, runbook fixes (NOTIF_SIM, `as <p> approve`), sim-smoke cleanup leaves no orphan daemons; mobile jest open-handle warning.
Then (Haiku): docs refresh — SECURITY.md (R4/R24 stale, new controls, residual risks incl. shared mock HMAC secret F8), RUNBOOK §5 stale gaps, TESTS.md counts, SUMMARY fix status.
- 2026-10-12: final fix pass committed (916c00c, ef1735a); 1,356 tests green (api 633, mobile 410, mock-world 279, shared 34); dev DB re-created for the signed ledger head; ledger:verify ok. Remaining: cleanup + `pmset sleepnow`.
- 2026-10-13: live AI (OpenRouter, any provider: structured-output fallback, retries), web/iOS run fixes, onboarding mandate step + onboarding bills committed (9393e5e, 9eb54fa). 1,420 tests green.
- Known small gaps (next session if wanted): (1) no UI/API path to add account details to an account-less onboarding payee, so those bills can't be paid yet; (2) "Covered" chip shows even with a ₸0 balance (API always sends COVERED); (3) native iOS passkeys need a real HTTPS domain + associated domains (web demo works).
