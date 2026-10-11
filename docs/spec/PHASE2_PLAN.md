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
- After ALL work is done: stop every server/background process started for this project, verify nothing is left (no bun/node servers on ports 4000/4001/8081, no caffeinate / keep-awake, no running Claude background tasks, no PGlite locks), then put the Mac to sleep with `pmset sleepnow`. If a session limit interrupts, the next session must finish the work and then do this.

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
- Integrity: third-party code/data must be properly licensed (→ ReadyNative licence question is a real eligibility risk).

## Security & compliance hardening workstream (user request 2026-10-11: "GDPR, zero trust, etc")
Code (Opus dev, security-critical):
- Zero trust: every route authenticated + authorised per resource (ownership checks → no IDOR, OWASP API1), no trust from network location, service-to-service calls authenticated (HMAC/signed approvals, already), short-lived tokens, least-privilege keys per module, deny-by-default route registration, rate limiting (@fastify/rate-limit), strict CORS, security headers (@fastify/helmet), request size limits, input validation everywhere (zod), secrets only from env, structured audit log of auth decisions.
- GDPR: data map + minimisation; lawful basis recorded; DSAR endpoints — Art. 15 access + Art. 20 portability export (JSON), Art. 16 rectification, Art. 17 erasure via crypto-shredding (per-user data key; ledger keeps hashes but personal payload fields encrypted with the user key so erasure doesn't break the hash chain), Art. 18 restriction (freeze); retention policy + purge job; consent/notice for AI processing (Art. 13, EU AI Act Art. 50 transparency — "you are talking to an AI"); I11 redaction before any LLM call + provider choice incl. local model for data residency; PIPL note for CN region; no PANs stored (PCI DSS scope reduction, last4 only).
- OWASP Top 10 for LLM apps: prompt injection (Reader quarantine I10), insecure output handling (sheet renders canonical order only), excessive agency (I1), sensitive info disclosure (I11).
Docs (Haiku drafts from explicit outlines, Opus reviews): docs/SECURITY.md (tier table ↔ code ↔ tests, threat model STRIDE, known risks, honest limit §2), docs/PRIVACY.md (GDPR Art. 30 record of processing, DPIA summary Art. 35, data flows, retention, DSAR), docs/COMPLIANCE.md (PSD2 SCA RTS Art. 5 dynamic linking, EU IPR Verification of Payee, GDPR, PIPL, PCI DSS scope, NIST SP 800-63B AAL2 for passkeys, OWASP ASVS L2 / API Top 10 / LLM Top 10 mapping, EU AI Act transparency, ISO 27001 Annex A highlights), docs/TESTS.md.
Sim scenarios added for: IDOR (user B reads/approves user A's order), DSAR export/erasure then ledger:verify still passes, rate-limit/brute force, cross-user placeholder leakage, LLM prompt-injection exfiltration attempt.
