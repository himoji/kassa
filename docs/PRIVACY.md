# Privacy (GDPR and related rules)

This document describes how Kassa handles personal data in the submitted build: the record of processing (GDPR Art. 30), the data map, data minimisation, data subject rights and how erasure works, retention, the AI transparency notice (EU AI Act Art. 50), a DPIA summary (Art. 35), a note on the Chinese region (PIPL), and PCI DSS scope reduction.

**Status of this build.** Kassa runs in sandbox mode. No real money moves and no licensed payment partner is involved. The text describes the design and the behaviour of the code in this repository. Items the code does not do are marked as such. This document is not legal advice and has not been reviewed by counsel.

Related: [SECURITY.md](SECURITY.md) (controls and residual risks), [COMPLIANCE.md](COMPLIANCE.md) (standards mapping). The processing-information endpoint `GET /api/privacy/export` returns a machine-readable version of the purposes and recipients (`processingInfo()` in `apps/api/src/modules/privacy/service.ts`).

## 1. Roles

| Role | Party | Note |
| --- | --- | --- |
| Controller (in this prototype) | Kassa operator | Stated in the export as "Kassa (competition prototype; no real money moves)". A production controller would be the licensed operator |
| Processor | AI model provider for the planner (`PLANNER_MODEL`) | Anthropic, OpenAI, Google, or a local model (`local`) that runs on infrastructure the operator controls |
| Processor | AI model provider for the Reader (`READER_MODEL`) | Same options. Can differ from the planner |
| Processor | Stripe (test mode) | Card Issuing and PaymentIntents. Card data is entered in Stripe's own payment form |
| Simulated recipient | Mock bank, QR wallet, pizza shop, supplier, landlord, university, insurer | Part of this repository. No real third party receives data |

No analytics, crash reporting or advertising SDK is configured in the mobile app (the ReadyNative setup flags are `--analytics none --crash none --consent none`, `DECISIONS.md` 2026-10-10).

## 2. Record of processing (Art. 30(1))

| Purpose | Lawful basis | Data categories | Recipients | Transfers | Retention |
| --- | --- | --- | --- | --- | --- |
| Account and sign-in with passkeys | Art. 6(1)(b) contract | Display name; passkey credential ID, public key and counter; sessions (tokens are not stored in the database); device push token and platform (if registered) | None outside Kassa | None | Until erasure. Tokens expire (access 15 min, refresh 30 days, cookie 7 days) |
| Budgets, bills, balances, forecast | Art. 6(1)(b) contract | Incomes, obligations, budgets, cards (label, last 4 digits, billing currency), balances, transactions (merchant, amount, category) | None outside Kassa | None | Until erasure. Raw merchant text minimised after 90 days |
| Payments (approved orders) | Art. 6(1)(b) contract; Art. 6(1)(c) legal obligation for payment records | Payee name and encrypted account, amount, currency, purpose, order and approval records, payment status | Stripe (card issuing, PaymentIntents, test mode); simulated rails | If Stripe processes outside the EEA, see transfers in section 9 | Payment records kept after erasure (Art. 17(3)(b)); names, accounts and purposes overwritten |
| AI chat (planner) | Art. 6(1)(a) consent, withdrawable; Art. 6(1)(b) for the service requested | Redacted chat text; redacted tool results (balances, budgets, obligations, payee facts) | Planner model provider (processor) | Depends on provider; see section 9 | Conversations and placeholder maps: 30 days after last message |
| Document reading (invoices, notifications, emails, screenshots) | Art. 6(1)(a) consent, withdrawable | Raw text or image of the document the user uploaded or asked Kassa to read; extracted fields and evidence | Reader model provider (processor) | Depends on provider; see section 9 | Uploaded documents: 30 days. Extracted fields are kept in the cached Reader result for the same period |
| Expense capture from notifications, Shortcut or text | Art. 6(1)(b) contract | Merchant, amount, currency, card hint, time, device token hash | None outside Kassa (local parsers first, Reader as fallback) | As for the Reader if the fallback runs | Raw merchant text: 90 days, then minimised to the normalised merchant. Notifications: 90 days |
| Sanctions screening and fraud prevention | Art. 6(1)(c) legal obligation (sanctions and AML screening); Art. 6(1)(f) legitimate interest (fraud prevention, abuse prevention) | Payee name, transliterated name, screening result | None outside Kassa | None | Screening result kept as part of the payment record |
| Security logging and audit ledger | Art. 6(1)(f) legitimate interest; Art. 6(1)(c) for payment record-keeping | Authentication and authorisation decisions with user ID; hashed order and approval records | None | None | Ledger entries are kept. Personal fields are sealed and become unreadable on erasure (section 6) |
| Rate limiting | Art. 6(1)(f) legitimate interest | Client IP address | None | None | Counters are in memory and reset on restart. IP addresses may appear in server logs; no log retention policy is configured in this repository |
| Credit record export (user-initiated sharing) | Art. 6(1)(a) consent (the user chooses to export and share) | Selected payment history items; the bundle is signed with the ledger checkpoint key | The person the user gives the link to | None | The bundle is stored as a ledger entry. No expiry or revoke route exists in this build (risk R22 in SECURITY.md) |
| Demo controls (demo clock, reset) | Not personal data (sandbox state only) | Demo clock offset, agent mode | Operator | None | Reset clears data |

## 3. Data map (per table)

Source: `apps/api/drizzle/0000_init.sql`, `0001_security_privacy.sql` and `apps/api/src/db/schema*.ts`.

| Table | Personal data | Protection | On erasure |
| --- | --- | --- | --- |
| `users` | Display name, home currency, consent time, restriction time, erasure time | Name is sealed in the ledger on rectification | Name replaced by `[erased]`. Row kept as a tombstone (`erased_at`); every session refused |
| `user_keys` | Wrapped per-user data key | AES-256-GCM under `USER_KEK`, AAD binds the user ID | Wrapped key set to null (tombstone row kept) |
| `webauthn_credentials_rules`, `webauthn_credentials_payments` | Credential ID and public key (pseudonymous) | Public keys only; no secrets | Deleted |
| `devices` | Push token, platform, Shortcut device token hash | Shortcut token stored as SHA-256 digest only | Deleted |
| `profiles` | Incomes, reserve rules, caps, signed base rules, bank profile and Stripe cardholder IDs | Plain JSON and IDs | Incomes and reserve rules emptied; bank profile and Stripe cardholder IDs cleared. Caps and signed base rules are kept (they are not in the erasure categories) |
| `payees` | Payee name, account (encrypted), account hash | AES-256-GCM with `ACCOUNT_ENC_KEY`, AAD binds the user ID | Deleted |
| `obligations`, `budgets`, `cards`, `card_fee_profiles` | Bill purposes and references, budget limits, card label and last 4 digits | Plain | Deleted |
| `transactions` | Raw merchant text (until minimised), normalised merchant, amount, card | Raw text minimised after 90 days | Deleted |
| `merchant_category_memory` | Merchant to category corrections | Plain | Deleted |
| `mandates` | Payee IDs, caps, signed mandate assertion | Assertion verified on every use | Revoked and kept without names (Art. 17(3)(e)) |
| `rule_changes` | Before and after values, assertion | Plain | Kept without names (Art. 17(3)(e)) |
| `proposals` | Draft, canonical order (payee name, purpose, amounts), decision, reason codes | Canonical order is hashed and signed | Unexecuted proposals deleted. Executed proposals keep the hash and signature; names overwritten |
| `approvals`, `used_nonces` | Order hash, approval signature, nonce, user assertion | Signed | Kept (payment record) |
| `payments` | Amount, rail, status, rail reference, details, reason codes | `details` keeps only the allowlist in `PAYMENT_DETAIL_KEYS_KEPT` (no names) | Kept with names, accounts and purposes overwritten |
| `issued_cards` | Stripe card ID, last 4 digits, expected merchant (normalised) | No full PAN stored | Rows kept as payment records. Expected merchant replaced by `[erased]` |
| `ledger_entries` | Event payloads. Personal fields are sealed in a `pii` member | AES-256-GCM under the per-user key. Hash chain covers the ciphertext | Ciphertext becomes unreadable (key destroyed). Entries and hashes kept |
| `ledger_checkpoints` | Signed head hashes | Ed25519 signature | Kept |
| `notifications` | Title, body, structured data | Plain | Deleted (also after 90 days) |
| `agent_messages` | Redacted planner history (no raw personal data) | Redacted before storage | Deleted |
| `placeholder_maps` | Real values behind placeholders: person names, normalised IBANs (in clear), card references (keyed digest and last 4) | Server only, never sent to a model. **Names and IBANs are stored in clear** (see section 10) | Deleted |
| `agent_documents` | Uploaded document reference and cached Reader result | Plain | Deleted |
| `onboarding_drafts` | Onboarding profile draft | Plain | Deleted |
| `demo_state` | Clock offset, agent mode | No personal data | Not applicable |

Notes:

- Placeholder maps are the only place where a model-facing placeholder can be resolved back to a real value. They are never sent to a model.
- The ledger never holds a full card number. Card references use an HMAC-SHA256 digest (section 8).

## 4. Data minimisation

| Measure | What it does | Where | Test |
| --- | --- | --- | --- |
| Redaction before every planner call (I11) | Replaces IBANs, card numbers (Luhn-checked), emails, phone numbers and personal names with stable placeholders per conversation | `apps/api/src/modules/agent/redact.ts`, `agent/middleware.ts` | `apps/api/test/intel/redact.test.ts` (11 tests); `apps/api/test/security/llm-redaction.test.ts` (no personal data in the planner prompt for a seeded conversation, including a document's Reader output) |
| Enum fields are never redacted | Keeps status, kind and currency fields readable for the model | `agent/redact.ts` (`ENUM_KEYS`) | `apps/api/test/intel/redact.test.ts` |
| Planner never sees real payee IDs | Planner uses `payee_N` references; `propose_order` resolves them on the server | `agent/tools.ts` | `apps/api/test/intel/agent-loop.test.ts` |
| Reader is quarantined | No tools, no memory, schema output, evidence checked (I10) | `reader/` | `apps/api/test/intel/reader.test.ts` |
| Reader receives raw document text (exception) | Needed to read the amount and account. Documented in section 5 | `reader/reader.ts` | Documented; `DECISIONS.md` 2026-10-11 |
| No PAN storage | Keyed digest and last 4 digits only | `agent/redact.ts` (`panRef`) | `apps/api/test/security/llm-redaction.test.ts` ("no column in any migration can hold a full card number") |
| Capture keeps last 4 digits | Card numbers in notification text are cut to the last 4 digits | `capture/` | `apps/api/test/security/llm-redaction.test.ts` ("capture keeps at most the last 4 digits") |
| Minimised export of processing details | Only purposes, recipients and retention in the processing info | `privacy/service.ts` | `apps/api/test/security/privacy.test.ts` |
| Payment details allowlist | Only non-personal keys kept on payment rows after erasure | `privacy/service.ts` (`PAYMENT_DETAIL_KEYS_KEPT`) | Erasure test in `apps/api/test/security/privacy.test.ts` |

## 5. What the Reader and the planner receive

| Recipient | Receives | Does not receive |
| --- | --- | --- |
| Planner model | The user's chat text after redaction. Tool results after redaction: balances, budgets, obligations, payee facts, route options, forecast | Real names, IBANs, card numbers, emails, phone numbers, real payee IDs, raw documents, the database |
| Reader model | The raw text (or image) of a document or message the user asked Kassa to read, and the extraction instructions | Tools, other users' data, the ledger, keys. The output is checked against the source by the server |

The planner's prompt and tool results are the subject of the I11 test (`apps/api/test/security/llm-redaction.test.ts`). The test runs a multi-tool turn on the seeded user, including a document's Reader output, and checks the planner prompt for personal data.

## 6. Data subject rights

| Right | Article | How it works | Endpoint | Behaviour |
| --- | --- | --- | --- | --- |
| Access | Art. 15 | Export of all personal data the user owns, decrypted, with processing information | `GET /api/privacy/export` (JSON attachment, `Cache-Control: no-store`) | Includes sealed ledger fields, decrypted. Covered by `test/security/privacy.test.ts` |
| Rectification | Art. 16 | Display name can be changed | `PATCH /api/me` with `displayName` | The change is ledgered (`PROFILE_RECTIFIED`) with the value sealed. Other profile fields are changed through settings and the caps flow |
| Erasure | Art. 17 | Crypto-shredding, see below | `POST /api/privacy/erase` with `{ confirm: "ERASE" }`, after a passkey assertion (428 round trip) | Irreversible. Every later request with the old session answers 401 `ACCOUNT_ERASED` |
| Restriction | Art. 18 | Freezes the account and stops AI processing | `POST /api/privacy/restrict` | AI routes answer 403 `PROCESSING_RESTRICTED`. Lifted only through the passkey unfreeze with its 24 h delay (`POST /api/unfreeze`) |
| Portability | Art. 20 | Same export as Art. 15, in JSON | `GET /api/privacy/export` | Machine-readable JSON |
| Withdraw consent | Art. 7(3) | Withdraws AI consent | `POST /api/privacy/ai-consent` with `{ consent: false }` | AI chat, document upload and onboarding then answer 403 `AI_CONSENT_REQUIRED` |
| Object | Art. 21 | No separate objection endpoint in this build. Processing under Art. 6(1)(f) is limited to security logging, rate limiting and fraud and sanctions checks | Not implemented | Consent withdrawal (above) covers the AI processing |
| Information | Art. 13 and 14 | AI processing notice shown before sign-up and on the profile. A full general privacy notice is not written in this repository | `GET /api/privacy/ai-notice` (public), `GET /api/me` (`aiNotice`) | The AI notice names the planner and Reader provider and model, and what each receives |
| Automated decisions | Art. 22 | `decide()` is automated. It can refuse, ask, or auto-pay only inside a mandate the user signed with a passkey, or under a base-rules limit the user signed | Every refusal and ask is shown with reason codes | No payment is made without the user's signature except under a mandate or limit the user signed earlier. The user can always freeze |

### 6.1 How erasure works (crypto-shredding)

1. Each user has a 256-bit data key (DEK). It is stored wrapped with AES-256-GCM under the key-encryption key `USER_KEK` (environment variable). The AAD binds the wrapped key to the user ID.
2. Personal fields in ledger payloads (capture merchant, card-authorization merchant, order-reject reason, QR payee name, remittance sender, payee account hash, credit-record bundle, rectified name) are sealed with the DEK into a `pii` member, `v1.<iv>.<ciphertext>.<tag>`.
3. Erasure removes data in tables (section 3) and nulls the wrapped DEK, keeping a tombstone row so no new key is created for that user.
4. Sealed ledger fields become unreadable. Ledger entries, their payload structure and their hashes stay. `bun run ledger:verify` still passes after an erasure (tested).
5. Retained payment records stay under the user's UUID. Names, accounts and purposes are overwritten. The order hash and approval signature still commit to the original order (section 7).

What is deleted, per the code (`ERASED` in `privacy/service.ts`): profile, name, incomes, reserve rules and AI consent; passkeys in both stores, devices and push tokens; payees and their encrypted accounts, obligations, budgets, cards and card fee profiles; captured transactions and category memory; notifications, conversations, placeholder maps, uploaded documents and onboarding drafts; unexecuted proposals; personal fields in the ledger.

Erasure needs a fresh passkey assertion over a server-built single-use challenge (`apps/api/src/modules/privacy/routes.ts`). Tests: `apps/api/test/security/privacy.test.ts` ("Art. 17: erase needs a fresh passkey assertion over a server challenge", "after erasure: no personal value survives in any table, in clear").

### 6.2 Limits of erasure

- **Backups.** A database backup taken before an erasure still holds the wrapped key. If `USER_KEK` is still available, a restored backup can decrypt the erased personal fields. Backups must expire within the period in which a restore is plausible. No backup procedure is configured in this repository (SECURITY.md R16).
- **Processors.** Kassa does not erase data at Stripe (cardholder and transaction records), in the AI provider's logs, or in the mock bank's own records. These are processors' systems. Erasure requests to them are a manual step (SECURITY.md R18).
- **Key compromise.** `USER_KEK` is an environment variable. No KMS, HSM or rotation script exists in this build (SECURITY.md R15).

## 7. Erasure residue: retained data (Art. 17(3))

| Retained category | Basis | What remains readable |
| --- | --- | --- |
| Payment records: amount, currency, rail, status, dates, order hash, approval signature, card ID and last 4 | Art. 17(3)(b): legal record-keeping for payment services (AMLD Art. 40 is cited in the code) | Amounts and dates, under the user's UUID. Names, accounts and purposes overwritten |
| Signed mandates and rule changes (no names), revoked | Art. 17(3)(e): evidence that each automatic payment was authorised | Caps, payee IDs (as references), dates |
| Ledger entries with sealed personal fields | Integrity of the append-only audit ledger (I12) | Hashes, event types, timestamps. Personal fields are ciphertext without the destroyed key |
| User row tombstone | Keeps foreign keys for the retained records | Erasure time |

The order hash and approval signature commit to the original payee and amount. Because payee names are overwritten, the hash cannot be turned back into a name by Kassa, but anyone who already holds the original order can match it. This is a known residue (SECURITY.md R17).

The retention period for payment records is not configured in code. The code cites five years (AMLD Art. 40); this value needs confirmation with counsel.

## 8. Retention

| Config key (`env.ts`) | Default | Data | Action | Job |
| --- | --- | --- | --- | --- |
| `RETENTION_DAYS_NOTIFICATIONS` | 90 | Notifications | Deleted | Scheduler, at most once per demo-clock hour |
| `RETENTION_DAYS_PLACEHOLDER_MAPS` | 30 | Agent conversations (redacted history) and placeholder maps, after the last message | Deleted | Same |
| `RETENTION_DAYS_DOCUMENTS` | 30 | Uploaded documents and Reader results | Deleted | Same |
| `RETENTION_DAYS_CAPTURED_TEXT` | 90 | Raw merchant text on transactions | Replaced by the normalised merchant (budgets need the merchant, not the raw text) | Same |

- `0` keeps the data (no purge for that category).
- The job is `purgeExpired` in `apps/api/src/modules/privacy/service.ts`, run from the scheduler job `retention` (`scheduler/index.ts`). Each run that changes something writes a `RETENTION_PURGED` ledger entry with counts.
- Tests: `apps/api/test/security/unfreeze-retention.test.ts` ("deletes or minimises data past its retention period and keeps recent data", "runs from the scheduler on the demo clock, at most hourly; 0 days = keep").
- **Not covered by the purge:** ledger entries (no time-based purge, by design for I12), payment records (retained under Art. 17(3)(b)), user tombstones, in-memory counters, server logs.

## 9. Transfers outside the EEA

| Recipient | Possible location | Current state |
| --- | --- | --- |
| Anthropic, OpenAI, Google (AI providers) | Depends on the provider and the configured region. Typically outside the EEA | No data processing agreement or transfer mechanism is configured in this repository. Must be in place before any live use with real personal data |
| Local model (`local`) | Infrastructure the operator controls (for example Ollama on the operator's server) | No transfer if hosted in the EEA. This is the option for data residency |
| Stripe | Stripe's own terms set the processing entity and locations | No DPA is accepted or configured in this repository. The operator must accept Stripe's DPA before live use |
| Mock world | Same process group as the API | None |

## 10. Known gaps in personal-data protection

| Gap | Effect | Status |
| --- | --- | --- |
| `placeholder_maps` stores person names and normalised IBANs in clear | A database leak exposes names and IBANs for 30 days | Open. Encrypting these values with the user's data key is the fix |
| No general privacy notice | Art. 13 information beyond AI processing is not provided | Open. Planned, not written |
| No objection endpoint (Art. 21) | Users can withdraw consent, not object to other processing | Open |
| Retention for ledger entries and payment records not configured | Long retention of audit data | By design; cited basis to confirm with counsel |
| Credit-record links cannot be revoked | A shared link stays valid until the record is deleted | Open (SECURITY.md R22) |
| Logs may contain IP addresses; no log retention configured | Personal data in server logs | Open |

## 11. AI transparency notice (EU AI Act Art. 50) and consent

**Notice.** `GET /api/privacy/ai-notice` (public, shown before sign-up) and `GET /api/me` (`aiNotice`). Content, from `apps/api/src/modules/privacy/notice.ts`:

- "You are talking to an AI assistant, not a person." (Art. 50(1))
- Which model processes the chat and the documents, and whether it is local or an external provider.
- What is redacted before the chat model sees it: names, account and card numbers, emails and phone numbers.
- That the AI can only propose payments; every payment is checked by fixed rules and needs the user's passkey or a mandate.
- How to withdraw consent.

**Consent gate.** Chat, document upload and onboarding chat answer 403 `AI_CONSENT_REQUIRED` without consent. Consent is given at registration (`aiConsent: true` on `POST /api/auth/register/verify`) or with `POST /api/privacy/ai-consent`. Consent is recorded with a time (`users.ai_consent_at`). The seeded user has consent.

**Restriction.** A restricted account (Art. 18) answers 403 `PROCESSING_RESTRICTED` on AI routes.

**Classification.** Kassa's AI use has not been formally classified under the AI Act. The notice is provided as a transparency measure. A risk assessment under the Act has not been done.

Tests: `apps/api/test/security/privacy.test.ts` ("AI routes need consent; consent can be given and withdrawn; registration can capture it", "GET /me and the public GET /privacy/ai-notice tell the user it is an AI and which provider processes the data").

## 12. DPIA summary (GDPR Art. 35)

**Description.** A student finance assistant. It reads the user's documents and bank notifications, drafts payments, and moves money only when the user signs. It processes financial and identity data, and an AI model processes chat and documents.

**Necessity and proportionality.** Processing is needed to deliver budgeting and payments the user asks for. It is limited by redaction, retention and the purpose-specific tables in section 2. Less intrusive alternatives (no AI, manual entry) remain available: the user can use the app without the chat, and every payment can be approved manually (Ask me preset).

| Risk to the person | Likelihood | Severity | Mitigation | Residual |
| --- | --- | --- | --- | --- |
| Personal data disclosed to an AI provider outside the EEA | Medium | High | Redaction (I11) for chat. Consent gate. Local model option. Notice | Medium. Reader still gets raw documents. No DPA configured |
| Database leak exposing names and IBANs | Low (sandbox) | High | Accounts encrypted. Names and IBANs in placeholder maps are in clear (section 10) | Medium until placeholder encryption is added |
| Incomplete erasure (backups, processors, residue) | Medium | Medium | Crypto-shredding of ledger fields. Retained records stripped of names. Backup guidance needed | Medium (SECURITY.md R16 to R18) |
| Unauthorised payment or access to another user's data | Low | High | Passkey over exact order, I2 to I8, object-level 404, rate limits | Low |
| Profiling and automated decisions | Low | Medium | Decisions are refusals, asks or mandate-bounded payments. Reason codes shown. Freeze and unfreeze | Low |
| Over-retention | Low | Low | Purge job for notifications, conversations, documents and raw merchant text | Low. Ledger kept by design |
| Data sent in error to the wrong payee | Low | High | Verified payee register, cooling period for changes (I7), handoff name check | Low |

**Conclusion.** The residual risks that remain are the external AI provider and the processors. These need contracts and a configuration decision before any live use. In sandbox mode with fictitious data, the risk to people is low.

## 13. Chinese region (PIPL)

The region switch to `CN` makes all payments HANDOFF (`rules/decide.ts`, step 6). Kassa does not charge or move money in that mode, and the user pays in their own app.

PIPL (Personal Information Protection Law of the People's Republic of China) is not implemented in this build:

- No PIPL-specific consent flow exists. The AI consent in section 11 is the GDPR-style consent.
- No data localisation in China and no security assessment for cross-border transfer are implemented.
- If a China-facing deployment sends personal information out of China (for example to an external AI provider), PIPL Chapter III (transfer conditions, separate consent, and the localisation rules for large operators) needs a legal assessment by counsel.
- The local model option keeps the planner and Reader on infrastructure the operator chooses. This is the technical measure available in the build.

Status: **Planned** (see [COMPLIANCE.md](COMPLIANCE.md)).

## 14. PCI DSS scope reduction

- Kassa does not store a full card number (PAN) anywhere. The test `test/security/llm-redaction.test.ts` checks that no column in any migration can hold a full card number, and that a full database dump after capturing a PAN does not contain it.
- Card references in `placeholder_maps` are `pan:<HMAC-SHA256 digest>:<last 4>`. The key is derived from `USER_KEK` with HKDF (RFC 5869) under the label `kassa:pan-ref:v1` (PCI DSS v4.0 requirement 3.5.1). Migration `0001_security_privacy.sql` rewrote earlier legacy rows to `pan:legacy:<last4>`.
- Stripe Issuing cards are stored as the Stripe card ID and last 4 digits. Payment entry for pay in place happens in Stripe's form (Payment Element on web, PaymentSheet on native), not in Kassa.
- Scope reduction is a design intent. No PCI DSS assessment has been performed, and the submission does not claim a self-assessment questionnaire level.

## 15. Open items for a production launch

1. Data processing agreements and transfer mechanisms with the AI providers and Stripe.
2. Encrypt names and IBANs in `placeholder_maps`.
3. A general privacy notice (Art. 13 and 14) and an objection route (Art. 21).
4. Backup retention and restore procedure that respects erasure (SECURITY.md R16).
5. KMS or HSM for `USER_KEK`, and a rotation procedure (SECURITY.md R15).
6. Counsel review of retention periods for payment records and ledger entries.
7. Log retention policy for IP addresses and request logs.
8. PIPL assessment for the China-facing region.
