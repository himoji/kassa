# Privacy (GDPR and related rules)

**Status.** Sandbox build: no real money moves, no licensed payment partner. Describes the code in this repository; what it does not do is marked. Not legal advice; not reviewed by counsel.

Related: [security/self-assessment.md](./self-assessment.md), [security/compliance.md](./compliance.md). `GET /api/privacy/export` returns the purposes and recipients in machine-readable form (`processingInfo()` in `apps/api/src/modules/privacy/service.ts`).

## 1. Roles

| Role | Party | Note |
| --- | --- | --- |
| Controller (prototype) | Kassa operator | Export says "Kassa (competition prototype; no real money moves)". In production: the licensed operator |
| Processor | Planner model provider (`PLANNER_MODEL`) | OpenRouter (and its routed vendor), OpenAI, Google, or `local` on operator infrastructure |
| Processor | Reader model provider (`READER_MODEL`) | Same options; can differ from the planner |
| Processor | Stripe (test mode) | Card Issuing and PaymentIntents. Card data entered in Stripe's form |
| Simulated recipient | Mock bank, QR wallet, pizza shop, supplier, landlord, university, insurer | In this repository; no real third party |

No analytics, crash reporting or advertising SDK in the mobile app (`--analytics none --crash none --consent none`, `architecture/decisions.md` 2026-10-10).

## 2. Record of processing (Art. 30(1))

| Purpose | Lawful basis | Data | Recipients | Retention |
| --- | --- | --- | --- | --- |
| Account, passkey sign-in | Art. 6(1)(b) | Display name; passkey ID, public key, counter; sessions (tokens not stored); push token and platform | None | Until erasure. Access 15 min, refresh 30 days, cookie 7 days |
| Budgets, bills, balances, forecast | Art. 6(1)(b) | Incomes, obligations, budgets, cards (label, last 4, currency), balances, transactions | None | Until erasure. Raw merchant text minimised after 90 days |
| Payments | Art. 6(1)(b); Art. 6(1)(c) for records | Payee name, encrypted account, amount, currency, purpose, order, approval, status | Stripe (test mode); simulated rails | Kept after erasure (Art. 17(3)(b)); names, accounts, purposes overwritten |
| AI chat (planner) | Art. 6(1)(a), withdrawable; Art. 6(1)(b) | Redacted chat and tool results | Planner provider | 30 days after last message |
| Document reading | Art. 6(1)(a), withdrawable | Raw text or image; extracted fields and evidence | Reader provider | 30 days, incl. cached Reader result |
| Expense capture (notifications, Shortcut, text) | Art. 6(1)(b) | Merchant, amount, currency, card hint, time, device token hash | None (local parsers; Reader fallback) | Raw merchant text 90 days, then normalised. Notifications 90 days |
| Identity check (KYC), simulated (2026-10-16) | Art. 6(1)(c) (AML due diligence, once a licensed partner runs it); sandbox Art. 6(1)(b) | Sent once: document type, number, country, full name, date of birth, expiry, liveness. Stored: outcome, reason codes, document type and country, timestamps, last 4 of the number (sealed) | Simulated checker (mock-world); production: licensed KYC partner | Outcomes kept after erasure (Art. 17(3)(b), AMLD Art. 40); sealed last 4 unreadable |
| Sanctions screening, fraud prevention | Art. 6(1)(c); Art. 6(1)(f) | Payee name, transliteration, result | None | With the payment record |
| Security logging, audit ledger | Art. 6(1)(f); Art. 6(1)(c) | Auth decisions with user ID; hashed orders and approvals | None | Kept; personal fields sealed, unreadable after erasure (section 6) |
| Rate limiting | Art. 6(1)(f) | Client IP | None | In-memory counters, reset on restart. IPs may be in server logs; no log retention configured |
| Credit record export | Art. 6(1)(a) | Selected payment items; signed with the ledger checkpoint key | Whoever gets the link | Stored as a ledger entry. No expiry or revoke (R22, security/self-assessment.md) |
| Demo controls | Not personal data | Clock offset, agent mode | Operator | Reset clears |

Transfers outside the EEA: only to the AI providers (chat, documents, capture's Reader fallback) and Stripe, see section 9.

## 3. Data map (per table)

Source: `apps/api/drizzle/0000_init.sql`, `0001_security_privacy.sql`, `apps/api/src/db/schema*.ts`.

| Table | Personal data | Protection | On erasure |
| --- | --- | --- | --- |
| `users` | Name, home currency, consent, restriction and erasure times | Name sealed in ledger on rectification | Name `[erased]`; tombstone row (`erased_at`); all sessions refused |
| `user_keys` | Wrapped data key | AES-256-GCM under `USER_KEK`, AAD = user ID | Wrapped key nulled, tombstone kept |
| `webauthn_credentials_rules`, `webauthn_credentials_payments` | Credential ID, public key | Public only | Deleted |
| `devices` | Push token, platform, Shortcut token hash | Shortcut token as SHA-256 | Deleted |
| `profiles` | Incomes, reserve rules, caps, signed base rules, bank profile and Stripe cardholder IDs | Plain | Incomes, reserve rules, bank and Stripe IDs cleared. Caps and base rules kept (not in erasure categories) |
| `payees` | Name, account (encrypted), account hash | AES-256-GCM, `ACCOUNT_ENC_KEY`, AAD = user ID and (v2, since 2026-10-15) payee ID | Deleted |
| `obligations`, `budgets`, `cards`, `card_fee_profiles` | Bill purposes, references, limits, card label, last 4 | Plain | Deleted |
| `transactions` | Raw and normalised merchant, amount, card, `place` from the Shortcut (street, city, country, coordinates rounded to about 100 m, likely place) | Raw text, street, coordinates minimised after 90 days; city, country, place kept | Deleted |
| `merchant_category_memory` | Category corrections | Plain | Deleted |
| `mandates` | Payee IDs, caps, signed assertion | Verified on every use | Revoked, kept without names (Art. 17(3)(e)) |
| `rule_changes` | Before/after values, assertion | Plain | Kept without names (Art. 17(3)(e)) |
| `proposals` | Draft, canonical order, decision, reason codes | Order hashed and signed | Unexecuted deleted; executed keep hash and signature, names overwritten |
| `approvals`, `used_nonces` | Order hash, signature, nonce, assertion | Signed | Kept (payment record) |
| `payments` | Amount, rail, status, reference, details, reason codes | `details` limited to `PAYMENT_DETAIL_KEYS_KEPT` | Kept; names, accounts, purposes overwritten |
| `issued_cards` | Stripe card ID, last 4, expected merchant | No full PAN | Kept; expected merchant `[erased]` |
| `kyc_checks` | Outcome, reason codes, document type and country, timestamps; last 4 of document number in `pii`. Never full number, name, birth date or image | `pii` sealed per-user (`sealPii`) | Kept (due diligence); `pii` unreadable |
| `ledger_entries` | Event payloads; personal fields in sealed `pii` | AES-256-GCM per-user key; hash chain covers ciphertext | Ciphertext unreadable; entries and hashes kept |
| `ledger_checkpoints` | Signed head hashes | Ed25519 | Kept |
| `notifications` | Title, body, data | Plain | Deleted (also after 90 days) |
| `agent_messages` | Redacted planner history | Redacted before storage | Deleted |
| `placeholder_maps` | Real values behind placeholders: names, normalised IBANs (in clear), card references (keyed digest, last 4) | Server only, never sent to a model. **Names and IBANs in clear** (section 10) | Deleted |
| `agent_documents` | Document reference, cached Reader result | Plain | Deleted |
| `onboarding_drafts` | Profile draft | Plain | Deleted |
| `demo_state` | None | n/a | n/a |

The ledger never holds a full card number; card references use an HMAC-SHA256 digest (section 14).

## 4. Data minimisation

| Measure | Where | Test |
| --- | --- | --- |
| Redaction before every planner call (I11): IBANs, Luhn-checked card numbers, emails, phones, names to stable per-conversation placeholders | `apps/api/src/modules/agent/redact.ts`, `agent/middleware.ts` | `apps/api/test/intel/redact.test.ts` (11 tests); `apps/api/test/security/llm-redaction.test.ts` (seeded conversation incl. Reader output) |
| Enum fields (status, kind, currency) never redacted | `agent/redact.ts` (`ENUM_KEYS`) | `apps/api/test/intel/redact.test.ts` |
| Planner sees `payee_N`, never real payee IDs; `propose_order` resolves on the server | `agent/tools.ts` | `apps/api/test/intel/agent-loop.test.ts` |
| Reader quarantined: no tools, no memory, schema output, evidence checked (I10) | `reader/` | `apps/api/test/intel/reader.test.ts` |
| Processing info lists only purposes, recipients, retention | `privacy/service.ts` | `apps/api/test/security/privacy.test.ts` |
| Payment details allowlist after erasure | `privacy/service.ts` (`PAYMENT_DETAIL_KEYS_KEPT`) | Erasure test, `apps/api/test/security/privacy.test.ts` |

## 5. What the Reader and the planner receive

| Recipient | Receives | Does not receive |
| --- | --- | --- |
| Planner | Redacted chat; redacted tool results (balances, budgets, obligations, payee facts, routes, forecast) | Names, IBANs, card numbers, emails, phones, real payee IDs, raw documents, the database |
| Reader (`reader/reader.ts`; exception to redaction, `architecture/decisions.md` 2026-10-11) | Raw text or image of a document the user asked it to read, to read amount and account; extraction instructions | Tools, other users' data, ledger, keys. Output checked against the source |
| Reader, payment note (`advice/enrich.ts`, AI consent only) | After a Shortcut or wallet tap: merchant text (quoted as data), city, street, country if sent, amount, category, server-computed budget figures | Names, card numbers, coordinates, other merchants, tools. Unsure place guesses and tips quoting numbers not in the figures are dropped |
| Reader, statement fallback (`dataport/ai.ts`, AI consent only, when deterministic readers fail) | Statement text after `dataport/redact.ts`: dates, amounts, merchants, other people's names as printed | Holder's name and its forms, IBANs, card and account numbers, national ids, reference codes, header addresses. Rows not in the statement are dropped |
| Reader, statement categories (AI consent only) | Unknown merchant names, redacted, one batch | Amounts, dates, known people's names, accounts |
| Onboarding planner, after import | Code-computed aggregates (monthly spending per category, money in per source with people as person_N, fees) | Transactions, statement text, accounts, merchants |

Uploaded statements are not stored: read in memory for the preview; only imported rows are kept (as spending, via capture). The aggregates (`profiles.money_history`: periods, monthly totals, money in per sender as printed, one-off payments) are kept for the agent, replaced on the next import and erased with the account. The agent reads them with `get_money_history`; senders reach the planner as person_N.

I11 test (`apps/api/test/security/llm-redaction.test.ts`): a multi-tool turn on the seeded user, incl. Reader output, checks the planner prompt for personal data.

## 6. Data subject rights

| Right | Article | Endpoint | Behaviour |
| --- | --- | --- | --- |
| Access | Art. 15 | `GET /api/privacy/export` (JSON attachment, `Cache-Control: no-store`) | All personal data, decrypted (incl. sealed ledger fields), with processing info. `test/security/privacy.test.ts` |
| Rectification | Art. 16 | `PATCH /api/me` with `displayName` | Ledgered as `PROFILE_RECTIFIED`, value sealed. Other fields via settings and the caps flow |
| Erasure | Art. 17 | `POST /api/privacy/erase` with `{ confirm: "ERASE" }`, after a passkey assertion (428 round trip) | Crypto-shredding (6.1). Irreversible; old sessions get 401 `ACCOUNT_ERASED` |
| Restriction | Art. 18 | `POST /api/privacy/restrict` | Freezes account; AI routes 403 `PROCESSING_RESTRICTED`. Lifted only by passkey unfreeze with 24 h delay (`POST /api/unfreeze`) |
| Portability | Art. 20 | `GET /api/privacy/export` | Same JSON as Art. 15 |
| Withdraw consent | Art. 7(3) | `POST /api/privacy/ai-consent` with `{ consent: false }` | Chat, document upload, onboarding: 403 `AI_CONSENT_REQUIRED` |
| Object | Art. 21 | Not implemented | Art. 6(1)(f) use is limited to security logging, rate limiting, fraud and sanctions checks. Consent withdrawal covers AI |
| Information | Art. 13 and 14 | `GET /api/privacy/ai-notice` (public), `GET /api/me` (`aiNotice`) | AI notice before sign-up and on the profile, naming provider, model and what each receives. No full general privacy notice |
| Automated decisions | Art. 22 | n/a | `decide()` refuses, asks, or auto-pays only inside a passkey-signed mandate or base-rules limit. Reason codes shown; user can always freeze |

### 6.1 How erasure works (crypto-shredding)

1. Each user has a 256-bit data key (DEK), wrapped with AES-256-GCM under `USER_KEK` (env var), AAD = user ID.
2. Personal ledger fields (capture merchant, card-authorization merchant, order-reject reason, QR payee name, remittance sender, payee account hash, credit-record bundle, rectified name) are sealed with the DEK into `pii`, `v1.<iv>.<ciphertext>.<tag>`.
3. Erasure deletes table data (section 3) and nulls the wrapped DEK, keeping a tombstone so no new key is created.
4. Sealed fields become unreadable; entries, structure and hashes stay. `bun run ledger:verify` still passes (tested).
5. Retained payment records stay under the user's UUID with names, accounts and purposes overwritten; the order hash and signature still commit to the original (section 7).

Deleted (`ERASED` in `privacy/service.ts`): profile, name, incomes, reserve rules, AI consent; passkeys in both stores, devices, push tokens; payees and encrypted accounts, obligations, budgets, cards, card fee profiles; transactions, category memory; notifications, conversations, placeholder maps, documents, onboarding drafts; unexecuted proposals; personal ledger fields.

Erasure needs a fresh passkey assertion over a server-built single-use challenge (`apps/api/src/modules/privacy/routes.ts`). Tests: `apps/api/test/security/privacy.test.ts` ("Art. 17: erase needs a fresh passkey assertion over a server challenge", "after erasure: no personal value survives in any table, in clear").

### 6.2 Limits of erasure

- **Backups.** A pre-erasure backup holds the wrapped key; with `USER_KEK` it can decrypt erased fields. Backups must expire within the plausible restore window. No backup procedure configured (R16).
- **Processors.** Stripe, AI provider logs and the mock bank are not erased by Kassa; requests to them are manual (R18).
- **Key compromise.** `USER_KEK` is an env var; no KMS, HSM or rotation (R15).

(R numbers: security/self-assessment.md.)

## 7. Erasure residue: retained data (Art. 17(3))

| Retained | Basis | Still readable |
| --- | --- | --- |
| Payment records: amount, currency, rail, status, dates, order hash, signature, card ID, last 4 | Art. 17(3)(b) (AMLD Art. 40 cited in code) | Amounts and dates under the UUID; names, accounts, purposes overwritten |
| Signed mandates and rule changes, revoked, no names | Art. 17(3)(e): proof each automatic payment was authorised | Caps, payee ID references, dates |
| `kyc_checks` outcomes | Art. 17(3)(b) (AMLD Art. 40) | Outcome, reason codes, document type and country, dates; last 4 is ciphertext |
| Ledger entries | Append-only ledger integrity (I12) | Hashes, event types, timestamps; personal fields ciphertext |
| User tombstone | Foreign keys for retained records | Erasure time |

The order hash and signature commit to the original payee and amount. Kassa cannot reverse it to a name, but anyone holding the original order can match it (R17).

Payment record retention is not configured in code. The code cites five years (AMLD Art. 40); needs counsel confirmation.

## 8. Retention

| Config key (`env.ts`) | Default | Data | Action |
| --- | --- | --- | --- |
| `RETENTION_DAYS_NOTIFICATIONS` | 90 | Notifications | Deleted |
| `RETENTION_DAYS_PLACEHOLDER_MAPS` | 30 | Conversations and placeholder maps, after last message | Deleted |
| `RETENTION_DAYS_DOCUMENTS` | 30 | Documents and Reader results | Deleted |
| `RETENTION_DAYS_CAPTURED_TEXT` | 90 | Raw merchant text | Replaced by normalised merchant |

- `0` = keep.
- `purgeExpired` in `apps/api/src/modules/privacy/service.ts`, run by scheduler job `retention` (`scheduler/index.ts`) at most once per demo-clock hour. Runs that change something write `RETENTION_PURGED` with counts.
- Tests: `apps/api/test/security/unfreeze-retention.test.ts` ("deletes or minimises data past its retention period and keeps recent data", "runs from the scheduler on the demo clock, at most hourly; 0 days = keep").
- **Not purged:** ledger entries (by design, I12), payment records (Art. 17(3)(b)), tombstones, in-memory counters, server logs.

## 9. Transfers outside the EEA

| Recipient | Location | State |
| --- | --- | --- |
| OpenRouter, OpenAI, Google | Provider and region dependent; typically outside the EEA | No DPA or transfer mechanism configured. Required before live use |
| `local` model | Operator infrastructure (e.g. Ollama) | No transfer if hosted in the EEA; the data residency option |
| Stripe | Per Stripe's terms | No DPA accepted. Required before live use |
| Mock world | Same process group as the API | None |

## 10. Known gaps in personal-data protection

| Gap | Effect | Status |
| --- | --- | --- |
| `placeholder_maps` holds names and IBANs in clear | A database leak exposes them for 30 days | Open. Fix: encrypt with the user's data key |
| No general privacy notice | Art. 13 beyond AI not provided | Open, planned |
| No Art. 21 objection endpoint | Only consent withdrawal | Open |
| Ledger and payment record retention not configured | Long audit retention | By design; basis to confirm with counsel |
| Credit-record links not revocable | Valid until the record is deleted | Open (R22) |
| IPs may be in logs; no log retention | Personal data in server logs | Open |

## 11. AI transparency notice (EU AI Act Art. 50) and consent

**Notice.** `GET /api/privacy/ai-notice` (public, before sign-up) and `GET /api/me` (`aiNotice`), from `apps/api/src/modules/privacy/notice.ts`:

- "You are talking to an AI assistant, not a person." (Art. 50(1))
- Which model handles chat and documents; local or external.
- What is redacted before the chat model: names, account and card numbers, emails, phones.
- The AI only proposes; every payment is checked by fixed rules and needs a passkey or mandate.
- How to withdraw consent.

**Consent gate.** Without consent, chat, document upload and onboarding chat answer 403 `AI_CONSENT_REQUIRED`. Given at registration (`aiConsent: true` on `POST /api/auth/register/verify`) or via `POST /api/privacy/ai-consent`; recorded in `users.ai_consent_at`. Seeded users, incl. demo personas, have neither AI nor PIPL consent (`apps/api/src/modules/demo/seed.ts`; tests opt in with `{ aiConsent: true }`). The sim CLI does not consent on a 403; the persona decides.

**Restriction.** Restricted accounts (Art. 18) get 403 `PROCESSING_RESTRICTED` on AI routes.

**Classification.** Not formally classified under the AI Act; no risk assessment done. The notice is a transparency measure.

Tests: `apps/api/test/security/privacy.test.ts` ("AI routes need consent; consent can be given and withdrawn; registration can capture it", "GET /me and the public GET /privacy/ai-notice tell the user it is an AI and which provider processes the data").

## 12. DPIA summary (GDPR Art. 35)

**Description.** Student finance assistant: reads documents and bank notifications, drafts payments, moves money only when the user signs. Processes financial and identity data; an AI model processes chat and documents.

**Necessity and proportionality.** Needed for the budgeting and payments the user asks for; limited by redaction, retention and purpose-specific tables (section 2). The app works without the chat, and every payment can be approved manually (Ask me preset).

| Risk | Likelihood | Severity | Mitigation | Residual |
| --- | --- | --- | --- | --- |
| Disclosure to an AI provider outside the EEA | Medium | High | Redaction (I11), consent gate, local model, notice | Medium. Reader gets raw documents; no DPA |
| Database leak of names and IBANs | Low (sandbox) | High | Accounts encrypted; placeholder maps in clear (section 10) | Medium until fixed |
| Incomplete erasure | Medium | Medium | Crypto-shredding; retained records stripped of names; backup guidance needed | Medium (R16 to R18) |
| Unauthorised payment or cross-user access | Low | High | Passkey over exact order, I2 to I8, object-level 404, rate limits | Low |
| Profiling, automated decisions | Low | Medium | Refuse, ask or mandate-bounded pay; reason codes; freeze | Low |
| Over-retention | Low | Low | Purge job | Low. Ledger kept by design |
| Payment to the wrong payee | Low | High | Verified payees, change cooling period (I7), handoff name check | Low |

**Conclusion.** Remaining risks are the external AI provider and processors; they need contracts and a configuration decision before live use. With fictitious sandbox data, risk to people is low.

## 13. Chinese region (PIPL)

Region `CN` makes all payments HANDOFF (`rules/decide.ts`, step 6): Kassa moves no money; the user pays in their own app.

- **Separate cross-border consent (implemented).** For CN, when the planner or Reader runs outside Kassa's server, AI needs a separate consent (PIPL Art. 38–39) on top of section 11. `POST /privacy/pipl-consent {consent}` gives or withdraws it (Art. 15), audited. Without it AI routes answer 403 `PIPL_CONSENT_REQUIRED` with the notice. Stored in `users.pipl_consent_at` (migration 0005); exported and cleared on erasure. Test: `apps/api/test/security/pipl-consent.test.ts`.
- Not implemented: data localisation in China, cross-border security assessment.
- Sending personal information out of China (e.g. to an external AI provider) needs counsel's assessment under PIPL Chapter III.
- The local model option is the available technical measure.

Status: **Partly implemented** (see [security/compliance.md](./compliance.md)).

## 14. PCI DSS scope reduction

- No full PAN stored anywhere; references are a keyed digest and last 4 (`agent/redact.ts`, `panRef`); capture cuts card numbers to the last 4 (`capture/`). `apps/api/test/security/llm-redaction.test.ts` checks "no column in any migration can hold a full card number", that a full database dump after capturing a PAN does not contain it, and "capture keeps at most the last 4 digits".
- `placeholder_maps` card references are `pan:<HMAC-SHA256 digest>:<last 4>`, key derived from `USER_KEK` with HKDF (RFC 5869), label `kassa:pan-ref:v1` (PCI DSS v4.0 req. 3.5.1). Migration `0001_security_privacy.sql` rewrote legacy rows to `pan:legacy:<last4>`.
- Stripe Issuing cards: Stripe card ID and last 4. Pay-in-place card entry is in Stripe's form (Payment Element on web, PaymentSheet on native).
- Design intent only: no PCI DSS assessment, no SAQ level claimed.

## 15. Open items for a production launch

1. DPAs and transfer mechanisms with AI providers and Stripe.
2. Encrypt names and IBANs in `placeholder_maps`.
3. General privacy notice (Art. 13 and 14) and Art. 21 objection route.
4. Backup retention and restore that respects erasure (R16).
5. KMS or HSM for `USER_KEK`, with rotation (R15).
6. Counsel review of payment record and ledger retention.
7. Log retention policy for IPs and request logs.
8. PIPL assessment for the China-facing region.
