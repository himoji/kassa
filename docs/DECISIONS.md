# Decisions

Deviations from `docs/spec/TECH_SPEC.md` (spec §0: date, problem, choice). Newest last.

## 2026-10-10 — Expo app from the ReadyNative Pro boilerplate

- **Problem:** spec §3/§16 assume a hand-built Expo app; building navigation, UI kit, theming, i18n,
  push and testing from scratch costs days we do not have before the Oct 17 freeze.
- **Choice:** `apps/mobile` is generated from ReadyNative Pro (`github.com/ReadyNative/ready-native-pro`,
  SDK 57, bun, Expo Router, `@/components/ui` kit, `@/lib/*` shims). Native-first: native tabs,
  `@expo/ui` controls, form sheets, SF Symbols, haptics, native passkeys. The web build (spec demo target)
  still works through `.web.tsx` fallbacks where `@expo/ui` has no web implementation.
- Setup command used (from `apps/mobile`):
  `bun run setup --preset default --auth none --backend none --data react-query --state zustand --i18n i18next --ui nativewind4 --forms react-hook-form --storage kv-store --push expo-notifications --payments none --analytics none --crash none --consent none --location none --onboarding off --widgets none --testing jest --yes`
  (auth and payments are ours: passkeys + Stripe). Examples were not kept.

## 2026-10-10 — i18n via i18next, English only

- **Problem:** the spec does not cover localisation; the boilerplate ships six demo locales.
- **Choice:** i18next + react-i18next (ReadyNative `i18n/i18next` module), `en` only for now (the other
  demo locales were removed). Every user-facing string goes through `t()`, including server reason-code
  labels, which the app maps client-side from `ReasonCode` values in `@kassa/shared` (the server sends
  codes, never prose).
- **Superseded** on 2026-10-16 by "App in English, Simplified Chinese, Russian and Kazakh" (end of this file).

## 2026-10-10 — Provider-agnostic LLM via the Vercel AI SDK

- **Problem:** spec §3/§9 pin the Anthropic TypeScript SDK; we want to swap providers (including a local
  model) without code changes, and replay must not depend on one vendor's wire format.
- **Choice:** Vercel AI SDK (`ai`) with a provider registry. Models are chosen by env strings
  `provider:model`, provider one of `anthropic`, `openai`, `google`, `local` (any OpenAI-compatible
  endpoint at `LOCAL_BASE_URL`, e.g. Ollama). Defaults: `PLANNER_MODEL=anthropic:claude-sonnet-5-5`,
  `READER_MODEL=anthropic:claude-haiku-5-5`. Replay (`AGENT_MODE=REPLAY`) serves recordings through the
  AI SDK mock model, so it is provider-independent. Providers without tool calling or vision return an
  error code for the affected feature.

## 2026-10-10 — bun workspaces + Turborepo instead of pnpm

- **Problem:** spec §3 says pnpm; the boilerplate is bun-native.
- **Choice:** bun workspaces (`apps/*`, `packages/*`) + Turborepo, same layout as spec §4. Every
  `pnpm <script>` in the spec becomes `bun run <script>` (e.g. `bun run ledger:verify`,
  `bun run keys:generate`). Installs use the hoisted linker (`bunfig.toml`): Expo supports isolated
  installs from SDK 54, but some React Native libraries still break under them. Bun applies
  `patchedDependencies` from the root `package.json` only, so the boilerplate's `react-native-screens`
  patch moved there (patch file stays in `apps/mobile/patches/`).

## 2026-10-10 — Smaller contract choices made while scaffolding `@kassa/shared`

- `@kassa/shared` is consumed from TypeScript source (no build): `exports` points at `src/index.ts`,
  relative imports carry explicit `.ts` extensions (`allowImportingTsExtensions`, `noEmit`). Bun and
  Vitest run it directly; Metro (SDK 57 auto-configures monorepos) transpiles it; Jest in `apps/mobile`
  transforms its ESM-only deps (`@noble/hashes`, `canonicalize`).
- Hashing is pure JS (`@noble/hashes` + `canonicalize`) so `orderHash`/`mandateHash` give identical
  results in Node, browsers and Hermes. `canonicalize` needs `String.prototype.isWellFormed` (ES2024);
  `jcs()` installs a spec-equivalent version only if the engine lacks it.
- The preset advanced switch the spec calls `agentMode` is named `agentAutonomy`
  (`ON_REQUEST | PLAN_AHEAD | PLAN_AND_ACT`) to avoid clashing with the demo `agentMode` (`LIVE | REPLAY`).
  `paymentPolicy` is `ALWAYS_ASK | RISK_BASED | NEVER_ASK`. Refinement (spec §10): `NEVER_ASK` with
  money mode `HANDOFF` or `PAY_IN_PLACE` is invalid.
- `MandateCore` (the passkey-signed part) includes `v` and `mandateId`, and requires sorted, unique
  `payeeIds`/`categories` so each mandate has exactly one canonical encoding.

## Licence note — ReadyNative

ReadyNative is a commercial licence (`apps/mobile/LICENSE`). Section 3b forbids publishing the kit's
source "publicly or privately … including on public repositories"; section 3c forbids sharing it outside
the licence scope. The competition requires a public GitHub repository. **Resolved:** the licensor (Madiyar
Baizhigitov, trading as ReadyNative) is also an author of Kassa and permits publication of these files in this
repository as part of the FinTechathon entry. Further redistribution outside this entry needs a ReadyNative
licence. The permission is stated in the notice at the end of the root `LICENSE`. Do not remove
`apps/mobile/LICENSE` or the `apps/mobile/LICENSES/` notices (section 3e).

## 2026-10-10 — Standards-first rule for unspecified details
Problem: the spec leaves many small details open (formats, encodings, algorithms).
Choice: follow TECH_SPEC.md exactly; where it is silent, use the governing published standard and cite it in code comments — ISO 4217 (currencies/minor units), ISO 8601 / RFC 3339 (timestamps, UTC), ISO 3166-1 alpha-2 (countries), ISO 13616 + ISO 7064 mod 97-10 (IBAN), ISO 9362 (BIC), ISO 18245 (MCC), ISO 20022 (payment status / remittance field naming), ISO 639-1 + BCP 47 (locales), RFC 8785 (JCS), RFC 8032 (Ed25519), RFC 4648 §5 (base64url), RFC 2104 (HMAC), RFC 9562 (UUID), RFC 7519 (JWT), RFC 9457 (problem+json errors), W3C WebAuthn Level 3, NIST SP 800-38D (AES-GCM), IEEE 754 avoided for money (integers only).

## 2026-10-11 — Mobile app (Track C) choices where the spec is silent

- **i18n layout:** one JSON per namespace in `apps/mobile/src/locales/en/<ns>.json`; app code always uses
  fully qualified keys (`t("order:approve")`, `useKassaT()`), `.` nesting, `_one/_other` plurals (CLDR).
  The boilerplate's sentence keys stay in the default `translation` namespace (`kit.json`) and are
  looked up with separators off. Jest enforces: every literal key exists, every `ReasonCode` has
  `{label,text}`, no raw string children of `<Text>` in screens/components.
- **API base:** `EXPO_PUBLIC_API_URL` is the origin; the client appends `/api` (unset on web = same origin).
- **Signing guard (I3, defence in depth):** before any passkey prompt the app recomputes
  `orderHash(canonicalOrder)` (and `jcsHash(BaseRulesCore)`, and checks `mandateHash` = challenge) and
  refuses to sign if it differs from the server's hash or the WebAuthn challenge.
- **Handoff mismatch (A5):** on `QR_PAYEE_MISMATCH` the app hides the QR code as well as the pay button,
  so it cannot be scanned with another wallet from the Kassa screen.
- **Demo clock in the client:** countdowns (cooling, rule changes, order expiry) use
  `Date.now() + me.demo.clockOffsetMs` so demo clock jumps move them (spec §15).
- **Session (spec §8):** native tokens in the Keychain/Keystore (`expo-secure-store`,
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`); single-flight refresh 30 s before expiry and once on 401
  (rotating refresh token, RFC 9700). Web keeps no token in JS (httpOnly cookie, `credentials: include`).
- **Not built (no spec screen for it):** unfreeze (would be a loosening; spec defines only freeze),
  transaction category correction UI (endpoint hook exists), account deletion.

## 2026-10-11 — Mock world and fixtures (Track D)

- **Mock bank money in minor units.** Problem: Wise's API uses decimal amounts; spec §0 forbids floats.
  Choice: Wise resource names, ids, statuses and webhook shape, but `...Minor` integer money fields; rates stay decimal strings.
- **Sanctions sample is fictitious.** Problem: spec §18 asks for a subset of the EU consolidated list; copying real names from
  memory risks naming the wrong person as sanctioned. Choice: fictitious entries in the EU FSF schema shape (licence note
  inside); the screening module can load the real FSF export, which has the same structure.
- **Seed story time `SEED_NOW = 2026-10-27T09:00Z`.** Problem: spec §18 fixes tuition (Oct 31) and rent (1st) while the demo
  needs rent autopay after "+3 days". Choice: anchor the seed 4–5 days before both; the API sets the demo clock offset to it.
- **Webhook timestamps use the demo clock.** Problem: the API checks the 5-min window with `Clock.now()` (demo time); signing
  with wall time would break webhooks after a clock jump. Choice: mock-world signs with demo-clock seconds.
- **Fake issuing authorization endpoint** `POST /api/rails/fake-issuing/authorize` (HMAC-signed like mock webhooks), so the
  pizza checkout exercises the same decision logic without Stripe (spec §11 FakeIssuing).
- **Generated documents use the PDF standard 14 fonts (WinAnsi).** No font embedding/licensing; Hungarian ő/ű are avoided in
  printed text. PDFs are deterministic (fixed dates, pdf-lib `updateMetadata: false`) and checked byte-for-byte in tests.
- **Mock world state is in memory** (resets on restart and `POST /mock/reset`); account/transfer ids start from a
  time-derived counter so they do not repeat across restarts.

## 2026-10-11 — Track B (intelligence) implementation choices

- **Extra tables** (`apps/api/src/db/schema.intel.ts`; spec §6 has no home for them): `agent_messages`
  (planner history, redacted model-facing messages only, I11), `agent_documents` (uploads → `docId`, cached
  Reader result), `merchant_category_memory` (spec §13 "user correction remembered per merchantNorm"),
  `onboarding_drafts`. drizzle.config must list both schema files (see PHASE1_COORDINATION).
- **FX sources** (verified 2026-10-10): Frankfurter `https://api.frankfurter.dev/v1/{date}` (ECB; returns the
  last business day ≤ date), NBK `https://nationalbank.kz/rss/get_rates.cfm?fdate=DD.MM.YYYY` (KZT per `quant`
  units), fallback open.er-api.com (labelled `FALLBACK_ER_API`), last resort `fixtures/fx-rates.json`
  (labelled `STATIC_EXAMPLE`, also used offline: `FX_OFFLINE=1` / `NODE_ENV=test`). Every quote carries its
  `source`. Rates are decimal strings → BigInt rationals; one HALF_UP rounding to minor units, matching
  `@kassa/shared` `fxMath`. Business days = Mon–Fri (holidays absorbed by the ±1 business-day tolerance).
- **Dedupe neighbour bucket** (spec §13 "also check the neighbouring bucket"): the neighbour on the side the
  event is closer to, so sightings < 5 min apart always merge and events ≥ 20 min apart never do.
- **Reader evidence**: exact substring first, then Unicode NFKC + whitespace-collapsed match (PDF text
  extraction is not whitespace-stable). Images: one vision call returns a verbatim `transcript` plus fields;
  evidence is checked against that transcript (weaker than text/PDF; documented limit). Providers without
  vision (`local`/`ollama` unless `LOCAL_VISION=true`, or `READER_VISION=false`) → `AI_VISION_UNSUPPORTED`.
  An invoice account that differs from the verified payee's account counts as an account mismatch
  (`readerChecks.account = UNVERIFIED` → rules `REFUSE_SOURCE_MISMATCH`).
- **Redaction for display**: the planner only sees placeholders; streamed text shown to the user restores
  payee/person names and shows accounts masked (`HU…1234`, `•••• 1234`). History stores the redacted form.
- **REFUSE/COOLING stop**: after such a tool result the next step runs with no tools (`toolChoice: none`) so
  the agent explains, then the loop stops; max 8 tool rounds + 1 text step.
- **Replay**: recordings store model step outputs (text + tool calls) only; tools run for real in replay.
  Turn selection: exact redacted user text → keywords (`match`) → turn index. Reader extractions are
  recorded separately under `fixtures/agent-recordings/reader/<sha256>.json` and re-verified on replay.
- **Notification texts** are `{key, params}` (i18next keys `budget.each|threshold|digest`, `fees.dcc|settled`)
  plus an English rendering in title/body. Digest time 20:00 in the region's zone (EU → Europe/Budapest,
  CN → Asia/Shanghai; same mapping as rules `zoneFor`), since the spec has no per-user time zone.
- **DCC flag** needs the merchant's local price; it is evaluated on settlement events that carry
  `localAmountMinor/localCurrency` (`POST /capture/settlement`), since notifications charged in KZT do not
  show the local price.

## 2026-10-11 — Track A (core money path) implementation choices

- **Payments daily cap default ₸2,000,000** (`PAYMENTS_DAILY_CAP_HOME_MINOR=200000000`). Spec §20's example ₸500,000
  is below the hero tuition (€2,400 ≈ ₸1.3–1.4M), so payments (I5) would always refuse it. The cap stays
  independent of the rules caps (rules per-payment default ₸1.5M, day ₸2M, month ₸3M, small auto ₸10,000,
  reserve ₸50,000 — example values). **`.env.example` still says 50000000; Track A could not edit it (file
  access denied) — update it to 200000000.**
- **Small-auto (step 9) is T1 without a mandate**, authorised by the passkey-signed base rules from
  `/onboarding/confirm` (stored in `profiles.base_rules*`). Payments re-verifies that assertion (payments
  credential store, challenge = `jcsHash(BaseRulesCore)`) and the signed `smallAutoMinor` limit. Users who never
  signed base rules get ASK (`AUTO_NOT_ELIGIBLE`).
- **Onboarding confirm applies immediately** (first-time setup, passkey-signed). Every later loosening goes
  through `PATCH /settings` → rule_changes with +24 h (I8).
- **Stored-assertion re-verification ignores the counter.** Mandate and base-rules assertions are re-checked by
  payments on every T1 payment; the stored signature is legitimately older than the live counter, so freshness
  comes from mandate validity + `used_nonces`. Live T2 assertions enforce the counter (accept 0, W3C WebAuthn L3 §6.1.1).
- **Nonce before daily cap** inside one transaction (per-user advisory lock): a replay reports `NONCE_USED`;
  a cap refusal rolls the nonce insert back so the order can be retried tomorrow.
- **Mandates are not inserted by the seed** (no passkey yet). `/onboarding/confirm/options` suggests the rent
  mandate (landlord + monthly bill, ~11% headroom: HUF 180,000 → 200,000); the app signs it via
  `/mandates/options` + `/mandates`, effective after 24 h.
- **Expired pending orders are re-issued** on `GET /orders/:id` with a fresh nonce/expiry (new orderHash); the
  old hash can never be approved.
- **Ledger:** hashes are base64url SHA-256; genesis `prevHash` = base64url of 32 zero bytes; checkpoints sign
  `JCS({seq, headHash, ts, keyId})`; keyId = RFC 7638 JWK thumbprint. `/demo/reset` truncates the ledger too
  (demo only).
- **Credit record** bundles are signed with the ledger checkpoint key and stored as a ledger entry under a
  128-bit random verifyId (no extra table); the PDF is a hand-built ISO 32000-1 single page.
- **Sessions:** HS256 JWTs (RFC 7519) with iat/exp on the demo Clock; refresh tokens rotate (RFC 9700 §4.14);
  register/login/passkey-gate challenges are single-use, in memory (single process — honest limit).
- **DB:** PGlite is the default driver (`DATABASE_URL` unset → `pglite://./.data/kassa`), Postgres when
  `DATABASE_URL=postgres://…`. Dev secrets missing from the environment are generated once into
  `.data/dev-secrets.json` (gitignored) so payee ciphertexts and ledger checkpoints survive restarts; the dev
  `MOCK_HMAC_SECRET` equals mock-world's dev default. Root `bun run dev` starts api + mock-world only
  (`dev:all` keeps the old behaviour).
- **Stripe Issuing (EU):** cards are created in `STRIPE_ISSUING_CURRENCY` (default EUR) with the Stripe-side limit
  = order amount converted at mid + 3%; our authorization check compares `merchant_amount`/`merchant_currency`
  with the exact signed order.
- **Schema additions** (all marked "(added)" in `schema.ts`): users.overrides; profiles.caps, base_rules*,
  bank_profile_id, stripe_cardholder_id; payees.created_at; transactions.payment_id; proposals.category,
  obligation_id, created/updated_at; payments.user_id, proposal_id, home_amount_minor, home_currency, details,
  reason_codes, updated_at; issued_cards.payment_id, user_id, provider, last4, created_at; mandates.revoked_at;
  rule_changes.change_hash, canceled_at; devices.push_token, platform, revoked_at; demo_state.id, demo_user_id,
  demo_claimed. Enums are Postgres enums generated from @kassa/shared.

## 2026-10-11 — Track A open decisions resolved (user: "reasonable defaults")
- Payments daily cap = ₸2,000,000 (PAYMENTS_DAILY_CAP_HOME_MINOR=200000000): accepted. Still independent of rules caps (I5).
- Rent mandate is signed by the user during onboarding (not seeded); effective +24 h (I8). Accepted.
- Small AUTO (rule 9) requires the passkey-signed base rules; otherwise ASK. Accepted (fail-closed).
- Stored mandate/base-rules assertions are re-verified by payments without the live signature-counter check (they are legitimately older). Accepted; counter check stays for live T2 assertions.
- Onboarding confirm applies once immediately; every later loosening goes through the 24 h delay. Accepted.
- Unfreeze: added as a LOOSENING (I8) — requires a fresh passkey assertion and takes effect after 24 h (demo clock). Freeze stays instant. (Phase 2 hardening implements it.)
- Challenge store / refresh-token rotation in memory: accepted for the single-process build; listed as a known risk in SECURITY.md.

## 2026-10-11 — env management
`bun run env:setup` (scripts/env-setup.ts) syncs both .env.example files with the keys the code reads, generates a local .env (secrets generated, public keys derived, dev defaults: AGENT_MODE=REPLAY, ISSUING_PROVIDER=fake, PGlite), links apps/api/.env and apps/mock-world/.env to it, and writes apps/mobile/.env. Never prints secret values; idempotent.

## 2026-10-11 — Phase 2 security & compliance hardening (apps/api)
- **Deny by default (OWASP API2, ASVS 4.1.5).** `src/http/security.ts` adds the session check to every route
  through an `onRoute` hook (onRequest, before body parsing) unless the route is in `PUBLIC_ROUTES`, which states
  why it may skip it and what authenticates it instead (webhook HMAC / Stripe signature, Shortcut device token,
  demo admin token, refresh token) or that it carries no personal data (health, auth options, AI notice, FX
  rates, demo clock, credit-record capability links). `test/security/http-hardening.test.ts` enumerates every
  registered route: each non-listed route must answer 401 unauthenticated; listed routes with their own auth must
  not succeed without it; no stale list entries. Routes' own auth hooks run after the rate limiter.
- **BOLA (OWASP API1): 404, never 403,** for another user's order, payment, payee, mandate, notification,
  transaction or conversation (was 403 `CONVERSATION_FORBIDDEN` for conversations). Each miss is audited as
  `AUTHZ_DENIED {actorUserId, resource, resourceId, existed}` — written for missing AND foreign ids (uniform work),
  and with `actorUserId` instead of `userId` so the prober's own `GET /ledger` cannot read `existed` back (found
  while testing: with `userId` the audit log was an existence oracle).
- **Audit log = ledger entries** (hash-chained, I12): `AUTH_LOGIN_SUCCEEDED/FAILED`, `AUTH_ASSERTION_FAILED`
  (settings, base rules, mandates, unfreeze, erase), `AUTHZ_DENIED`, `UNFREEZE_REQUESTED`, `ACCOUNT_UNFROZEN`,
  `PRIVACY_EXPORTED/RESTRICTED/ERASED`, `PROFILE_RECTIFIED`, `AI_CONSENT_GIVEN/WITHDRAWN`, `RETENTION_PURGED`
  (existing: `AUTH_PASSKEY_REGISTERED`, `RULES_LOOSEN_PENDING`, `ACCOUNT_FROZEN`). No separate audit table: one
  tamper-evident store, already verified by `ledger:verify`.
- **Rate limits** (@fastify/rate-limit, per IP, in memory): global 600/min; 20/min for auth options/verify,
  refresh, public credit-record verify and demo admin calls; 30/min for order approve, Shortcut capture, unfreeze
  and privacy actions (env `RATE_LIMIT_*`). `TRUST_PROXY` makes `req.ip` the client behind Caddy (compose sets it).
- **Headers/CORS/CSRF/body:** helmet with an API CSP (`default-src 'none'; frame-ancestors 'none'`), no-referrer,
  HSTS only on https; CORS allow-list = PUBLIC_ORIGIN + EXTRA_ORIGINS with credentials; cookie-authenticated
  state-changing requests with a foreign `Origin` → 403 `CSRF_ORIGIN_MISMATCH` (OWASP CSRF cheat sheet; SameSite=Lax
  does not cover same-site origins such as mock-world on another localhost port). Body limit 1 MiB (was 12 MiB
  globally); 11 MiB only on `POST /agent/documents`. 5xx problem+json never carries messages or stacks.
- **Demo:** routes are not registered unless `DEMO_ENABLED`; production refuses to start with `DEMO_ENABLED` and a
  `DEMO_ADMIN_TOKEN` shorter than 32 chars; admin token compared with `timingSafeEqual` over SHA-256 digests (no
  length leak); a missing token is accepted only under `NODE_ENV=test` (dev previously allowed it).
- **Unfreeze = loosening** (resolved decision above): `POST /unfreeze` → 428 PasskeyChallenge over
  `jcsHash({v, kind:"UNFREEZE", userId, frozenAt, nonce})` → `rule_changes` row (kind `UNFREEZE`, LOOSEN,
  effectiveAt +24 h); the scheduler lifts the freeze. A new freeze/restriction cancels pending unfreezes. The nonce
  makes every challenge unique, so an old assertion cannot be replayed (the settings loosening has no nonce: its
  challenge is deterministic per change — acceptable there because the change itself is what gets signed).
- **Crypto-shredding (GDPR Art. 17).** Per-user 256-bit DEK in `user_keys`, wrapped with AES-256-GCM under env
  `USER_KEK` (AAD = userId; AES-GCM rather than RFC 3394 AES-KW to keep one AEAD in the codebase). Personal fields
  of ledger payloads are sealed into a `pii` member (`v1.<iv>.<ct>.<tag>`, AAD = userId): capture merchant,
  card-authorization merchant, order-reject reason, QR payee name, remittance event (sender), payee account hash,
  credit-record bundle, rectified display name. `GET /ledger`, the export and the public credit-record verify
  decrypt for display. Erasure nulls the wrapped DEK (tombstone row, so no new key is minted) → the ciphertexts are
  unreadable while every entry and hash stays: `ledger:verify` passes after an erasure (tested).
- **What erasure deletes vs retains.** Deleted: passkeys (both stores), devices, payees, obligations, budgets,
  cards, transactions, category memory, notifications, conversations + placeholder maps, documents, onboarding
  drafts, unexecuted proposals; profile incomes/reserve rules; name → "[erased]". Retained under Art. 17(3)(b)
  (payment record-keeping, e.g. AMLD Art. 40) and 17(3)(e): proposals that have an approval and their payments,
  approvals, mandates (revoked), rule changes — with payee name, payee account hash, purpose and name-bearing
  payment details overwritten; the order hash and approval signature still commit to the original order. The
  user row stays as a tombstone (`erased_at`; every session and login refused). Not erased here: Stripe-side
  cardholder data and the mock bank's own records (external processors; residual risk).
- **Art. 18 restriction** = freeze + `restricted_at` (AI routes 403 `PROCESSING_RESTRICTED`, no digests); lifted
  only through the passkey + 24 h unfreeze. **Art. 16** = `PATCH /me {displayName}`. **Art. 15/20** =
  `GET /privacy/export` (all rows, decrypted, plus Art. 15(1) processing info).
- **AI consent and notice.** `users.ai_consent_at`; agent chat, document upload and onboarding chat answer 403
  `AI_CONSENT_REQUIRED` without it. Consent: `aiConsent: true` on `POST /auth/register/verify` or
  `POST /privacy/ai-consent {consent}` (also withdraws, Art. 7(3)). `GET /me.aiNotice` and public
  `GET /privacy/ai-notice` (EU AI Act Art. 50; GDPR Art. 13): "you are talking to an AI", planner/reader provider
  and model from PLANNER_MODEL/READER_MODEL, `local` for local/ollama providers, what each model receives. Seed
  sets consent for Dana.
- **The Reader receives raw document text** (it must, to extract and evidence-check amount and account; I10
  quarantine: no tools, no memory, schema output re-checked against the source). I11 applies to the planner: a
  test runs a multi-tool turn on the seeded user (incl. a document's Reader output) and finds no IBAN, PAN, email,
  phone, payee or user name in any planner prompt.
- **PCI DSS scope (found while testing):** CARD placeholders stored the full PAN in `placeholder_maps.real_ref`.
  Now `pan:<HMAC-SHA256 (key = HKDF(USER_KEK, "kassa:pan-ref:v1"))>:<last4>` (PCI DSS v4.0 3.5.1 keyed hash);
  migration 0001 rewrites legacy rows to `pan:legacy:<last4>`. Tests: no column can hold a PAN; a full DB dump after
  capturing a PAN contains it nowhere.
- **Retention** (GDPR Art. 5(1)(e)), scheduler job at most hourly on the demo clock: notifications 90 d,
  conversations + placeholder maps 30 d after last message, uploaded documents 30 d, raw captured merchant text
  90 d (minimised to the normalised merchant, not deleted, since budgets need it). `RETENTION_DAYS_*`, 0 = keep.
- **Dependencies:** apps/api/package.json now declares everything it imports (fastify, @fastify/cookie, drizzle,
  jose, @simplewebauthn/server, pglite, postgres, stripe, …) — they were only present through hoisting and were
  missing from bun.lock — plus @fastify/helmet, @fastify/cors, @fastify/rate-limit.

## 2026-10-11 — Phase 2 bug fixes B1, B2, B4 (apps/api, packages/shared)

- **B1, Reader checks across turns (I10, rules §10 step 3).** Problem: `propose_order` only saw documents read in
  the current turn or uploaded with the conversation's id, so a document uploaded without `conversationId`, read in
  one turn and paid in a later one skipped `REFUSE_SOURCE_MISMATCH`. Choice: Reader results stay persisted per docId
  (`agent_documents.reader_result`, with their checks) and `propose_order` gathers checks regardless of turn: every
  document cited in the new optional `docIds` input (unknown → `DOC_NOT_FOUND`, never read → `DOC_NOT_READ`, no
  proposal), invoices read in this conversation (as before), and any read invoice of the user whose *claimed* amount
  + currency equals the order's or whose claimed account is the payee's account. Claimed = the Reader's raw field
  value, because `parsed` holds only VERIFIED values (an unverified amount used to be invisible to matching). The
  worst status wins; a cited document whose verified amount differs from the order counts as an amount mismatch. A
  document uploaded without a conversation is bound to the first conversation that reads it. The applied docIds
  are stored on the proposal draft (`sourceDocIds`). Trade-off: a suspicious invoice keeps refusing agent proposals
  of the same amount (or to the same account) until it is purged by retention (30 d); scheduler/mandate payments do
  not use Reader checks.
- **B2, funding route bound into the signed order (spec §12).** Problem: the bank rail quoted order currency →
  order currency, so a bill larger than that one balance failed with `RAIL_ERROR` after the user had signed.
  Choice: at proposal time rules (`rules/funding.ts`) pick the cheapest feasible route over funding currency ×
  rail from `fixtures/rails.json`, restricted to what the bank rail can execute (`provider: MOCK_BANK`, rail
  BANK_TRANSFER), arrival ≤ due date, balance ≥ converted amount + markup + fixed fee; if no route arrives by the
  due date (or it already passed) the cheapest late one is used rather than not paying. The choice is signed in
  four new optional `CanonicalOrder` fields: `fundingCurrency`, `fundingAmountMinor` (a MAXIMUM debit: estimate
  + 100 bps FX/rounding tolerance on converted routes, capped at the balance), `fundingRouteId`,
  `fundingMarkupBps`. `v` stays 1: optional fields leave the JCS bytes of orders without them unchanged (old
  golden vector still passes; a funded golden vector was added). All four or none (`orderFunding()`; `orderHash`
  refuses a partial binding). The mock bank quote is `source = fundingCurrency, target = order currency,
  routeId`; before creating any transfer the rail checks that the quote delivers exactly the signed amount and
  debits ≤ `fundingAmountMinor`, else the payment fails with `FUNDING_ABOVE_SIGNED_MAX` and no money moves. No
  feasible route → rules step 4b `REFUSE` `INSUFFICIENT_FUNDS` before anything is signed (also a hard refusal in
  `HARD_REFUSE_CODES`). Mandate (T1) scope and both daily caps still use the payee-currency amount / its home
  value. Balances unknown (mock bank unreachable): the same-currency route is bound (exact debit, no conversion),
  rules do not refuse, and the bank's own funds check is the backstop. `refreshIfExpired` re-issues an order with
  the same funding binding (a stale maximum fails safely at execution).
- **B4, one payment per obligation period.** Problem: the agent's tuition proposal carried the obligation id but
  no due date, so the scheduler's `(obligationId, draft.dueDate)` check missed it and proposed tuition again after
  "+3 days" (double-payment risk). Choice: new table `obligation_settlements` (migration
  `0002_obligation_settlements.sql`, PK `(obligation_id, period)` = idempotency key, unique `proposal_id`). Rules
  derive the period (the obligation's due date) for every proposal linked to an obligation (ownership checked:
  `BAD_OBLIGATION`), refuse when the period is pending or paid (step 1b, `DUPLICATE_OBLIGATION_PAYMENT`) and claim it
  inside the proposal transaction; a lost race rolls back and re-decides as a duplicate. PENDING → PAID when the
  payment is created; a rejected order or a FAILED / CANCELED payment (rails, webhooks, polling) deletes the row and
  frees the period. The scheduler skips settled periods, rolls MONTHLY obligations once PAID, and still tries a
  period only once itself. The agent links orders to upcoming bills first, else to the latest past-due one, so a
  bill paid after its due date is still recognised. The migration backfills settlements from existing live
  proposals.
- **Demo story (spec §18 + Build Plan).** SEED_NOW = Oct 27 is after the parents' Oct 25 transfer (incomes'
  `nextDate` is Nov 25), so the seeded ₸900,000 already includes it; balances stay as spec §18. With them no single
  balance covers tuition €2,400 (≈ ₸1.21–1.47 M depending on the rate source; the wallet's total is barely above it
  and spread over four currencies), so tuition is now refused with `INSUFFICIENT_FUNDS` until money arrives, while
  rent (HUF 180,000 > HUF 120,000) is funded from KZT and autopays without any top-up. The "money from home" demo
  trigger now sends the parents' ₸600,000 (spec §18 amount, was ₸300,000, which could not cover tuition at any
  rate). Numbers on 2026-10-11 live rates (EUR ₸505.63, HUF ₸1.384): tuition debits ₸1,221,171 (signed max
  ₸1,233,383), rent ₸251,481 (signed max ₸253,996); ₸900,000 + ₸600,000 covers both, ₸27,348 KZT left. **Offline
  caveat:** with the example table (`FX_OFFLINE=1`, EUR ₸612.40) tuition needs ₸1,478,834 and rent ₸283,380, so
  ₸600,000 pays tuition but rent is then refused `INSUFFICIENT_FUNDS`; an offline demo needs ≥ ₸862,214 extra (send
  money from home twice). The Build Plan's "convert ₸400,000" / "Parents send ₸400,000" lines predate this check and
  cannot fund tuition with the spec balances. Rules' protected reserve is still checked on the total wallet in KZT,
  not per currency (`reserveRules.minBalances` KZT 50,000 is not enforced per currency; unchanged).

## 2026-10-11 — Demo determinism

Demo determinism: money-from-home trigger = ₸1,000,000 (covers tuition + rent under both live and offline example rates); sim uses offline example rates by default (--live-fx to opt in).

## 2026-10-12 — Triggers and small auto

Triggers and small auto: trigger/scheduler-originated drafts may be AUTO only inside a passkey-signed mandate (rule 7), never via the small-auto limit (rule 9) → ASK + TRIGGER_NEEDS_MANDATE. Strengthens I6.

## 2026-10-12 — Chinese-context demos (D-CN1..3): data, seed option, per-region AI notice

- **Problem:** the judges are Chinese; the plan asks for three CN demos without new product features, and the
  hero seed must stay single-user for the existing tests.
- **Per-region AI notice (PIPL).** `privacy/notice.ts` had one text for everyone. `aiNotice(region)` now appends one
  line for region CN: AI providers outside mainland China receive the reduced chat and uploaded documents, which is
  a cross-border transfer under PIPL Art. 38–39 that needs separate consent; the prototype states this and does
  not yet ask for the separate consent (PRIVACY.md §13, COMPLIANCE.md stay accurate). With local models the line
  says there is no cross-border transfer for AI. `GET /me` and the consent-required problem use the user's region;
  the public `GET /privacy/ai-notice` uses the signed-in user's region, else `?region=`, else EU. The `AiNotice`
  contract and `noticeVersion` are unchanged (the region line is a variant of the same notice version).
- **Second persona behind a seed option.** `fixtures/seed-data.ts` exports `liWei` (Li Wei: home CNY, region EU,
  SMART, capped wallet, caps in CNY) and `seed.personas = [liWei]`. `seedDatabase(..., { personas: true })` inserts
  him; `bun run seed`, the sim daemon and `POST /demo/reset` pass it, unit tests that seed Dana do not, so their
  "Dana is the only user" assumptions hold without changes. Dana stays `demo_state.demo_user_id`. Demo claim:
  `POST /auth/register/options {demoClaim: "li-wei"}` (DEMO_ENABLED only; persona keys come from the seed file;
  a claimed persona → `DEMO_ALREADY_CLAIMED` like the hero). Li Wei's landlord row has the same name as Dana's but
  the landlord's account for his building (`ACCOUNTS.landlordLiWei`); his university row uses the same university
  IBAN with his own RF reference, so two users hold the same account hash (a realistic cross-user case).
- **CardKind.** The enum has no CNY member; Li Wei's CNY debit card is `MULTI` (no migration for a demo).
- **rails.json:** three EXAMPLE CNY funding routes (`cny-mock-bank` ¥30 + 50 bps, 1 day; `cny-home-bank` ¥150 +
  150 bps, 3 days; `cny-card` 150 bps, same day). They only apply to wallets that hold CNY (Dana holds none).
- **Dana's Shanghai payees.** "Dorm Office in Shanghai" and "Buy Everything Shop from China" are seeded VERIFIED
  MERCHANT payees (MERCHANT_ID accounts: Chinese QR merchants have no IBAN) plus a ¥1,800 monthly dorm-fee
  obligation due 2026-11-15 (outside the "+3 days" window, so the rent-autopay story is unchanged).
- **Demo trigger `cn-spending-day`** ingests the Alipay-style and WeChat Pay-style samples and a new Kazakh-bank
  sample of a CNY purchase on the KZT card (`kz-bank-ru-cny-purchase.txt`). Capture only logs (I6).
- **Bug fixed (demo route):** the `settlement` trigger said "on the home card" but picked the oldest pending
  foreign transaction of any kind, so after the CN captures it settled the card-less Alipay wallet charge "in KZT
  on the card". It now only settles charges on a card billed in the home currency (regression test in
  `apps/api/test/demos/cn2-wallet-capture.test.ts`).
- **No DCC in D-CN2.** DCC means a charge in the HOME currency abroad plus the local price; the CN samples are
  CNY-denominated, so the fee x-ray shows a hidden card markup (4 %), not a DCC flag. `dccWarnings` stays empty.
- **Mock QR wallet:** a code created by payee name for a known QR merchant now carries that merchant's city and
  country in the EMV payload (Shanghai, CN) instead of the Budapest default (mock-world only).

## 2026-10-12 — Final fix pass, Track X (money path and security; sim reports p1/p2/p3/cn/security)

- **X1 mandate scope (cn B5a).** A mandate authorises the bills it was signed for, not any payment to the payee.
  AUTO under a mandate now needs a draft linked server-side to an obligation: payee in `payeeIds`, the OBLIGATION's
  category (never the caller's `category`) in `categories`, same currency, current period (the obligation's due
  date), amount ≤ the bill, period not settled. Anything else to a mandate payee → ASK `MANDATE_SCOPE_MISMATCH`; an
  in-scope bill over a mandate cap → ASK `MANDATE_OUT_OF_SCOPE`. Both now also block small-auto (before: an
  out-of-scope order below ₸10,000 to the landlord auto-paid via step 9). The link is signed into the canonical
  order (`obligationId`, `obligationPeriod`; PSD2 RTS Art. 5 dynamic linking) and payments re-checks it with its own
  queries (I2), including that the period's settlement row belongs to this proposal. Choice "amount ≤ bill" follows
  the brief; partial payments of a bill stay possible but claim its period.
- **X2 payments cap (F3, p3 O1).** Payments sums every live payment of the UTC day in the user's home currency,
  converting each itself through an injected port (`registerHomeConverter`, wired in `orders/wiring.ts` to
  money/fx), and no longer trusts the order's `homeAmountMinor` (also for the signed small-auto limit, compared in
  the limit's own currency). No port / failed conversion → refused (fail closed). Rules pre-check today's usage
  against `PAYMENTS_DAILY_CAP_HOME_MINOR` after their own hard refusals: REFUSE `REFUSE_CAP` + `PAYMENTS_DAILY_CAP`
  instead of "ASK within 2×" then refused after the passkey. The env cap is still one number interpreted in each
  user's home currency (unchanged; for a CNY user it means ¥ — noted, not changed).
- **X3 payee verification + small-auto budget (F1, F2).** `verify-callback` uses the same 428 round trip as unfreeze:
  challenge = JCS hash of `{v, kind:"PAYEE_VERIFY", userId, payeeId, payeeName, accountHash, nonce}`, single use,
  bound to the payee (NIST SP 800-63B AAL2 re-authentication for a security-relevant change). Small-auto (T1
  without mandate) gets a per-UTC-day budget: `SMALL_AUTO_DAILY_MAX_COUNT` (default 3) payments and
  `SMALL_AUTO_DAILY_AMOUNT_MULTIPLE` (default 3) × the signed small-auto limit in total; a multiple of the signed
  limit keeps the budget in the user's own currency. Beyond it: ASK `SMALL_AUTO_BUDGET_EXHAUSTED`; payments
  enforces the same budget inside its per-user lock.
- **X4 screening (F6, p3 B1).** Every rail at decide (step 4) and at payment (step 7, the signed and the current
  payee name), and at payee creation: a hit is refused 422 `REFUSE_SANCTIONS` and not stored (a payee that can never
  be paid is useless); the hit is ledgered `PAYEE_SCREENING_HIT` with the name sealed under the user's key. Payees
  created before a list update are still caught at decide/payment.
- **X5 refresh after erasure (p3 B2).** `/auth/refresh` applies login's account checks (user exists, not erased);
  erased → 401 `ACCOUNT_ERASED`. Revocation is anchored on `users.erased_at` (durable), not on the in-memory
  rotation list, so it survives a restart. Restricted (Art. 18) users can still log in and refresh (they must be
  able to lift the restriction); only erased accounts are refused, as at login.
- **X6 ledger head anchor (F5).** Table `ledger_head` (one row), rewritten in the append transaction with an Ed25519
  signature (checkpoint key) over JCS `{domain:"kassa:ledger-head:v1", seq, headHash, ts, keyId}` — domain-separated
  so a checkpoint signature cannot pose as a head. `ledger:verify` requires a valid anchor naming the last entry:
  tail truncation and tail re-hashing after the last checkpoint are detected. Honest limit: someone with DB write
  access who kept an older signed head row can roll back to exactly that head; closing it needs the head published
  outside the DB (transparency log / RFC 3161), out of scope. Migration 0004 (journal `when` after 0005, see
  PHASE1_COORDINATION).
- **X7 handoff QR before signing (cn note 1).** The QR request is fetched and checked (fuzzy name ≥ 0.92, amount,
  currency) when a pending HANDOFF order is first shown or approved, through a port (`registerHandoffPreflight`, so
  rules never imports rails, I1). Stored on the draft (`handoffQr`); a mismatch refuses the proposal up front
  (`QR_PAYEE_MISMATCH`, ledger `HANDOFF_MISMATCH`, period released). The handoff rail pays exactly the checked QR and
  re-checks it; the webhook's post-payment check is kept. Mock world unreachable → 502 `RAIL_ERROR` (nothing to
  sign).
- **X8 expired approve (p2 B3).** Approve on an expired order re-issues it and answers 410 `ORDER_EXPIRED` with the
  re-issued `OrderView` in `details`; nothing is signed or executed in that call. A GET that re-issues returns
  `reissuedFromOrderHash`. The sim's "approve" (GET then sign) is the part that signed silently — Track Y.
- **X9 payment notices (p1 B3, B5).** `PAYMENT_SENT` / `PAYMENT_FAILED` are emitted from the common status
  transition (`payments/status.ts`) and for rail failures in `executeApproval`, once per outcome, for all rails:
  `{key:"payment.sent"|"payment.failed", params:{payee, amount, home, rail, mandate, reasonCodes}}` + English text
  ("… under your signed mandate 1a2b3c4d for rent"). The mobile app does not render notification templates
  (no `{key, params}` rendering exists for budget notices either), so no mobile strings were added.
- **X10 tests.** Shortcut wrong/revoked/session token → 401; injected instructions in a captured notification →
  logged only; payments-level small-auto without (or with tampered) base-rules signature → `NO_APPROVAL` /
  `BAD_SIGNATURE`; revoked rent mandate under SMART → scheduler draft not AUTO.

## 2026-10-12 — Final fix pass, Track Y (agent, data, UX, sim)

- **Y1 Redactor vs identifiers (p3 B3).** A card number must be a whole token: not glued to a letter, digit or
  underscore, and not part of a hyphen-joined identifier; still 13–19 digits passing Luhn (ISO/IEC 7812-1). No hit may
  overlap an RFC 9562 UUID (8-4-4-4-12 hex), for every detector (a payee named "Cafe" never matches inside a UUID).
  Tested with 5,000 random UUIDs, mixed hex and digit-only (`test/intel/redact-ids.test.ts`).
- **Y1 Same-name payees (p3 B4).** Placeholders were already keyed by payee id; text redaction picked the first
  payee with the name. A name shared by several payees now resolves with the caller's context: tool outputs about a
  payee (`propose_order`, `get_payee_facts`) redact against that payee (`RedactContext {payeeId}`). Free text without
  context picks the VERIFIED payee (`knownNames` orders VERIFIED first). Deviation: free chat text naming a shared
  name is inherently ambiguous; the verified payee is the safe default (the cooling one is refused anyway).
- **Y2 Seed consent and ledger (p2 B1, B2).** `seedDatabase` grants no AI consent unless `{ aiConsent: true }` (tests
  only). Claiming the demo account consents at sign-up like any user (`sim register` gives it unless
  `--no-ai-consent`). The sim CLI no longer gives consent automatically on 403 (that hid p2 B1 and would hide PIPL
  consent); the persona decides (`as <p> privacy consent | pipl-consent`). `DEMO_SEEDED` is one entry per seeded
  user, naming only that user, so a DSAR export (ledger rows with `payload.userId` = subject) never names another
  persona.
- **Y3 PIPL separate consent (cn note 2).** New `users.pipl_consent_at` (migration 0005). For region CN with a
  planner or Reader outside Kassa's server (`crossBorderConsentRequired`), AI processing (agent chat, documents,
  onboarding chat, the sim planner, and capture's Reader fallbacks) needs the separate cross-border consent
  (PIPL Art. 38–39; Art. 15 withdrawal) on top of the AI consent: 403 `PIPL_CONSENT_REQUIRED` with the notice.
  `POST /privacy/pipl-consent {consent}` gives/withdraws it (audited `PIPL_CONSENT_GIVEN/WITHDRAWN`); it is in the
  export, cleared by erasure, and listed in the Art. 15 processing info. One gate for all callers
  (`assertAiProcessingAllowed`, `aiProcessingAllowedFor`). Capture's Reader fallbacks now also respect the AI consent
  (previously they ran without it): without consent the deterministic parsers still log, unparseable text stays
  UNPARSED. The mobile chat shows the notice with an explicit "I agree" for either 403 (never silent).
- **Y4 Forecast top-up (p1 B2, cn D-CN3).** The suggestion is the first shortfall: reserve − balance on the first
  day below the reserve, by that date. The horizon-wide worst deficit over-converted early; later shortfalls appear
  in a later forecast. For small top-ups the optimizer may now pick a card route (no fixed fee), e.g. Li Wei's HUF.
- **Y4 Same-currency routes (p1 B10).** `getRoutes` (user level) marks same-currency routes `noConversion`; asked
  for `fromCurrency = toCurrency` with a short balance it still returns the direct route with `balanceCovers: false`
  (rules' funding choice is unchanged: it uses the optimizer with the balance cap). The planner tool then also
  lists the other funding options.
- **Y5 log_expense (p1 B6).** log_expense already went through capture's `categorize`; the gap was free text
  ("coffee") that matches no dictionary merchant. The dictionary fixture gained `keywords` per category, matched as
  whole words after the MCC map and merchant entries (reported as DICTIONARY, no new CategorySource).
- **Y5 search_catalog placeholders (p1 B8).** `merchant` may be the payee placeholder; it resolves to the payee, then
  to the catalog whose merchant name normalises to the payee's name (`catalogDirectory` port: pizza menu +
  `/mock/suppliers`). Unknown placeholder → `UNKNOWN_PAYEE_REF`; payee without a catalog → `CATALOG_NOT_FOUND`.
- **Y6 User-facing text.** Merchant display = dictionary name, else the user's payee with the same normalised name,
  else the raw text title-cased if printed in capitals; never `merchantNorm`. Foreign spend notices show the home
  equivalent ("CN¥32.50 (≈ KZT 2,397.95) at …"). Fee x-ray `exampleValues` is true whenever rates come from the
  labelled offline example table; DCC warnings carry `merchant`. `propose_order` re-hydrates placeholders in purpose
  and item names before rules, so the canonical order, notifications and the approval sheet name real payees
  (tool output to the model stays redacted). Shared, additive: `REASON_TEXT_EN` / `reasonTextEn` /
  `reasonsSentenceEn` (texts = the app's locale), `presetDerivedChanges`, `FUNDING_FX_TOLERANCE_BPS` (pinned to
  rules' `FX_TOLERANCE_BPS` by a test) and `fundingMarginNoteEn`. Used by the sim `order` (`reasons`, `fundingNote`)
  and `settings patch` (`derivedChanges`) outputs, and in the app: the order sheet shows "Paid from … at most …" with
  the margin explained, preset cards say what else a switch changes and the toast repeats it, notifications render
  `{key, params}` (payment.sent/failed, budget.each, fees.settled) through i18n with the English text as fallback and
  list reason codes in plain language. Follow-up done 2026-10-12 (see the entry below): rules' `summarize()` uses
  `reasonsSentenceEn(codes)`, and PATCH /settings returns and notifies `derivedChanges`.
- **Y7 Sim.** `recategorise` command; `demo clock|tick|trigger` wait until mock-world's cached clock (refreshMs 1 s)
  reached the new time, tick the mock bank and wait for its outbox to drain (output `webhooks`), so a following read
  sees SENT (p1 B11; the old race was mock-world ticking at the stale time). `approve` stops on a re-issued order
  (`ORDER_REISSUED`) or 410 `ORDER_EXPIRED` and shows the new order; `verify-payee --sign` does the passkey round trip.
- **Y7 Orphan daemons (security report).** Cause, reproduced in `test/sim/sim-down.test.ts`: (1) a test run killed
  before `afterAll` (outer command timeout) leaves the detached daemon running by design; (2) `sim down` signalled only
  known pids, so with a hung daemon and no `state.json` the mock-world child survived. Fix: `down` signals the
  daemon's process group (detached → group leader), escalating to SIGKILL; `SIM_OWNER_PID` (set by the sim tests)
  makes the daemon stop itself when its owner dies.
- **Y7 Mobile jest "worker failed to exit gracefully".** Not a test timer: per-file resource dumps showed none left.
  Jest's environment teardown walks the globals and so first resolved expo's lazy `fetch` global there, loading
  expo's fetch and native-module shims after the tests ("Cannot log after tests are done" from
  ExpoModulesCoreJSLogger); under CPU load that kept workers past Jest's exit grace period. `jest.setup.ts` resolves
  `globalThis.fetch` during setup. Verified causally under the same load: without the line 2/2 runs warn, with it 0/2
  (no `forceExit`).

## 2026-10-12 — Payments daily cap is defined in PAYMENTS_DAILY_CAP_CURRENCY (default KZT) and converted (rounded down, fail-closed) to each user's home currency.

- `PAYMENTS_DAILY_CAP_HOME_MINOR` is now a fixed amount in the reference currency `PAYMENTS_DAILY_CAP_CURRENCY`
  (default `KZT`, ₸2,000,000 by default). Before, the number was read in each user's own home currency, so for a CNY
  user it meant ¥2,000,000 (about ₸280M). Each user gets the cap converted to their home currency through the same fx
  conversion (`money/fx` `toHome`), rounded down (`"down"`: truncation, not nearest). At the offline example rates
  (fixtures/fx-rates.json) the CNY user's cap is about ¥27,106.
- Payments converts through the injected port (`registerHomeConverter`, wired in `orders/wiring.ts`). Rules pre-check the
  same converted cap through money/fx. Failure to convert is fail closed: payments refuses `PAYMENTS_DAILY_CAP`, and
  rules treat the cap as 0 so the user is refused before signing (`REFUSE_CAP` + `PAYMENTS_DAILY_CAP`).
- Test: `test/core/payments-cap-currency.test.ts`. This supersedes the X2 note that the cap is read in each user's home
  currency.
- Also in this pass (Y6 follow-up): rules' `summarize()` now uses `reasonsSentenceEn(codes)`; PATCH /settings returns
  `derivedChanges` and notifies `SETTINGS_DERIVED_CHANGE` (`{key:"settings.derived_change", params}` + English text).

## 2026-10-12 — Ledgers created before migration 0004 (signed head)
`ledger:verify` reports "head anchor missing" for a ledger written before the signed head existed (correct: it can't prove the tail wasn't truncated). Dev/demo databases are re-created (`db:migrate` + `seed`); there is no production data. A production upgrade would need a one-time, audited anchoring of the existing head.

## 2026-10-12 — Licensing: Kassa code under MIT (root LICENSE). ReadyNative-derived files in apps/mobile stay under the ReadyNative Commercial License; the licensor (a Kassa author) permits their publication in this repository for the FinTechathon entry.

## 2026-10-11 — Structured output capability strategy and model retries (ai/structured.ts, ai/retry.ts)
Some OpenAI-compatible models (smoke run: `inclusionai/ling-3.1-flash` on OpenRouter) reject `response_format` (400 "does not support feature: structured-outputs"), which broke onboarding and the Reader. Structured calls now try native structured output, then ONE forced call (`toolChoice: {type:"tool"}`) of a schema-carrier tool `submit_result` whose input schema is the zod schema, then JSON-only text; the mode is abandoned only on a 400/404/422 that names the capability, and the working mode is cached per model in memory. The carrier tool has no `execute` and generateText stops after one step, so nothing runs: the Reader still has no real tools (I10), and the evidence checks run unchanged. Every mode validates with the same zod schema; an invalid answer is retried once (validation issues fed back, never content), then `AI_STRUCTURED_OUTPUT_INVALID`. Onboarding now uses generateText (its reply is not streamed) and stores the answer as assistant JSON text whatever the mode, so history never holds an orphan tool call. The AI SDK's own retry (2 s × 2ⁿ, no jitter, 2 retries) is turned off (`maxRetries: 0`); live models are wrapped with a retry middleware: `AI_MAX_RETRIES` (default 5) on retryable errors (408/409/429/5xx/network), Retry-After / retry-after-ms honoured when ≤ 60 s (RFC 9110 §10.2.3), else exponential backoff with equal jitter (1 s base, 20 s cap). Provider failures in onboarding / Reader become a typed `AI_PROVIDER_UNAVAILABLE` (onboarding: 503) instead of a 500 `AI_NoOutputGeneratedError`.

## 2026-10-11 — Mobile web/native smoke fixes: web storage, CORS header, native passkey errors, demo entry
- **Web storage = localStorage (`apps/mobile/src/lib/storage.web.ts`).** `expo-sqlite/kv-store` on web runs SQLite in a Web Worker. Under `web.output: "static"` Metro failed with "Worker chunk not found" (dev server `/` → 500). Without bundle splitting it failed with "Bundle splitting is required for Web Worker imports". expo-sqlite web is also alpha and needs COOP/COEP headers (SDK 57 docs, SQLite "Web setup"). The app only keeps small preferences, so web uses the platform store, async-only (static rendering runs in Node), under the `kassa:kv:` prefix. Native keeps kv-store.
- **No `x-kassa-client` header.** The API never read it. The client kind is already known from the credential (cookie vs bearer) and the `client` field of the auth bodies. Allowing it would only widen CORS (ASVS V14.5.3), so the mobile client stopped sending it. A preflight test pins the allowed headers (`test/security/http-hardening.test.ts`).
- **Native passkeys need a real domain.** On the iOS 26.5 simulator, register failed with `ERR_BIOMETRIC` (no Face ID enrolled). Once Face ID was enrolled, it failed with ASAuthorizationError 1004: "Application with identifier … is not associated with domain localhost" (OS log only; JS gets no description). The app now reports this case explicitly: `PasskeyDomainError`, with a pre-check that rejects localhost/IP/single-label RP IDs before the OS sheet, and `PasskeyBiometricsError`. The app config adds `webcredentials:` next to `applinks:` when `links.domain` is set. Requirements: `apps/mobile/README.md` "Passkeys on native".
- **Demo entry.** `GET /api/auth/demo` → `{ enabled }` (public, only reports DEMO_ENABLED). The welcome screen's "Try the demo (simulated)" is the normal passkey registration with `demoClaim`, so the security model is unchanged.
- **Onboarding AI consent.** The sign-up screen never sent `aiConsent`, and Settings is out of reach during onboarding, so new users were blocked at 403 AI_CONSENT_REQUIRED. The onboarding chat now shows the same notice + "I agree" card as the agent chat and re-sends the message (consent stays explicit, GDPR Art. 7).
- **Web dark mode.** NativeWind's `colorScheme.set("system")` removes the `dark` class in class mode, so a dark OS got dark backgrounds with light-mode text. Web now applies the resolved mode.

## 2026-10-13 — Onboarding bills become obligations with placeholder payees (no account yet); rent mandate offered after the rules

- **Problem:** after onboarding, Home showed "No bills due in the next 45 days" although the chat captured rent, tuition
  and insurance: `applyOnboardingDraft` skipped obligations because a payee needs account details (I7). For the same
  reason the rent-mandate step never appeared: `/onboarding/confirm/options` only suggests a mandate for an existing
  landlord bill, and a new user has none until the draft is applied (after the rules are signed). The app then went
  straight to /home (`suggestedMandate: null`); the redirect hooks were not involved (`useOnboardingRedirect` is a
  no-op; `useAuthRedirect` only redirects while `onboarded` is false or from the auth group).
- **Choice (secure default):** applying the signed draft creates each dated bill as an obligation linked to a payee
  re-used by name + kind, else a **placeholder payee**: `COOLING`, `coolingUntil` NULL, `accountEnc`/`accountHash` NULL
  (migration `0006_payee_account_pending`: both columns nullable), country `ZZ` (ISO 3166-1 user-assigned, "unknown"),
  ledgered `PAYEE_CREATED` with `accountMissing: true, source: "onboarding"`. Names are sanctions-screened like
  POST /payees (I9); a hit skips the bill and is ledgered. Bills without a due date are skipped.
- **Never payable without an account (defence in depth):** rules step 2 refuses `REFUSE_UNVERIFIED_PAYEE` +
  new reason code `PAYEE_ACCOUNT_MISSING` whatever the status (a COOLING payee is otherwise T2-payable after
  `coolingUntil`, so "cooling" alone was not enough); a NULL `coolingUntil` also refuses on its own; no canonical order
  is built for a payee without an account hash; approve and payments refuse (account hash mismatch, explicit null
  check); the simulated verify callback answers 409 `PAYEE_ACCOUNT_MISSING`, so such a payee can never become VERIFIED.
  Tests: `apps/api/test/core/onboarding-obligations.test.ts`, `test/rules/decide.test.ts`.
- **Rent mandate:** `POST /onboarding/confirm` now returns `suggestedMandate` + `suggestedMandatePayees`, computed after
  the draft is applied; the suggestion accepts a COOLING landlord (BLOCKED never; VERIFIED preferred). Signing it
  is safe: the rules still refuse every payment to that payee until it has a verified account. The app's review
  screen goes rules → mandate (sign or skip) → home (`apps/mobile/src/screens/onboarding/__tests__/onboarding-review.test.tsx`).
- **App:** `ObligationDto.payeeAccountMissing`, `PayeeDto.accountMissing` (`accountMasked` is ""). Home/Bills rows show
  "Add payee details" and link to the payee; the payee screen says the details are needed and hides "Simulate
  verification".
- **Not done:** there is no "add account details to this payee" flow yet (an account change is a new payee, I7, and the
  obligations would have to move to it). Seeded demo data (Dana) is unchanged: her payees all have accounts.

## 2026-10-13 — Demo Stage (mock-world /mock/stage) and three demo-admin stage routes

- **What:** phone-sized "outside world" screens for the live pitch under `/mock/stage/*` (director, Tap to Pay,
  Super-App Wallet in Chinese, Mail, Bank App, Money from home, Supplier price list). Generic names only, "Simulated"
  ribbon on every page, no CDN, one shared CSS/JS served by mock-world (`apps/mock-world/src/stage/`,
  `src/routes/stage.ts`). The whole tree is 404 unless mock-world's `DEMO_ENABLED` is true (new config keys
  `DEMO_ENABLED`, `DEMO_ADMIN_TOKEN`, read from the shared root `.env`; default off).
- **Secrets stay server-side:** pages call `/mock/stage/api/<action>`; mock-world's `StageApi` holds the demo admin
  token and a Shortcut device token in memory and never renders them (tests assert neither appears in any page/state).
- **Why three new API routes (deviation from "existing routes only"):** the device-side actions the scenes need are
  user-scoped and had no route reachable without a user session: minting an iOS Shortcut token (`POST /devices/shortcut`
  needs a session; the app has no UI for it), a statement line with the merchant's local price for DCC (the
  `settlement` trigger only settles foreign-currency charges at a fixed +4 % and never passes `localAmountMinor`), and
  "Forward to Kassa" (`POST /agent/documents` needs a session; the app cannot upload). Added, demo-admin token only,
  DEMO_ENABLED only, listed in `PUBLIC_ROUTES` + the `auth` rate-limit tier: `POST /api/demo/stage/shortcut-token`
  (same code path as `/devices/shortcut`, ledgered `DEVICE_TOKEN_CREATED` with `via: "demo-stage"`),
  `POST /api/demo/stage/settlement` (`SettlementEventRequest` → `reconcileSettlement` for the demo user),
  `POST /api/demo/stage/document` (`storeDocument` + an `INBOX_NEW_EMAIL` notification with the docId). Like every
  trigger they only log or store (I6). The coffee tap then goes through the real `POST /api/capture/shortcut` with
  the bearer device token (I13). Tests: `apps/api/test/demos/stage.test.ts`, `apps/mock-world/test/stage.test.ts`.
- **Forged bank message (S2 on stage):** mock-world posts a fake `outgoing_payment_sent` to `/api/webhooks/mock/bank`
  once unsigned and once signed with a random key; the API answers 401 to both.
- **Clock sync:** after the stage moves the demo clock, mock-world drops its cached offset (`DemoClock.invalidate`) so
  the mock bank and the fake issuer do not sign with the pre-jump time (same race as Y7).

## 2026-10-12 — Apple Pay → Kassa: app UI for Shortcut tokens, device list/revoke, tolerant Shortcut parser, `nudge`

- **Gap closed:** the 2026-10-13 Demo Stage entry noted "`POST /devices/shortcut` needs a session; the app has no UI
  for it". The app now has **Settings → Apple Pay → Kassa** (`apps/mobile/src/screens/settings/shortcut-screen.tsx`,
  route `/shortcut`): create a token (shown once, copy as token or as `Bearer …` header), the endpoint URL
  (`EXPO_PUBLIC_API_URL`, else the page origin on web), numbered iOS 17 setup steps, the device list and revoke. Setup
  guide: `docs/SHORTCUT_SETUP.md`. The demo-stage token route stays for the stage (no session there).
- **New routes (session auth, users module):** `GET /devices` lists the user's active `IOS_SHORTCUT` devices
  (`id`, `kind`, `createdAt`) plus `lastCaptureAt` (newest `SHORTCUT` transaction of the user). `DELETE /devices/:id`
  revokes (sets `revokedAt`, ledgered `DEVICE_TOKEN_REVOKED`); a tightening, so instant and passkey-free (I8);
  idempotent (204 again); another user's id → 404 audited `AUTHZ_DENIED` (API1). The revoked token 401s on capture
  because `shortcutDeviceUser` already filters `revokedAt IS NULL`.
- **Deviation, no device name / per-device last use:** `devices` has no `name` or `lastUsedAt` column and the schema was
  being edited by a parallel milestone, so no migration here. The list shows created time and a short id; last use is
  per user (`lastCaptureAt`), not per device. A `devices.label` + `lastUsedAt` column is the follow-up.
- **Parser (`capture/parsers/shortcut.ts`):** what iOS actually pastes into the JSON body: glued markers ("HUF1,290.00",
  "Ft1,290", "CN¥38.00"), NBSP / narrow NBSP groups, trailing dots, JSON numbers (rounded to 2 decimals, which every
  supported currency uses), a minus anywhere or accounting parentheses → `REFUND` (not spending). An amount carrying an
  **unsupported** currency marker ("£4.50", "A$4.50", "JPY 500") is now `UNPARSED` instead of being logged in the home
  currency. `date` accepts any string but is used only when it is ISO 8601 with a zone; a localized date is ignored
  (Run Immediately makes server time the tap time), so a localized date no longer fails the whole request with 400.
  `merchant` may be empty ("Unknown merchant"); `currency` is case-insensitive.
- **`nudge` (`capture/nudge.ts`, only on `POST /capture/shortcut`):** one English line for the Shortcut's Show
  Notification, built from results Kassa already has: amount (+ home equivalent if foreign), display merchant,
  category budget left ("this month" for calendar-month budgets, else "for N days"; "over budget by …"), the matched
  card's rolling-median markup for that currency pair, and DCC (an earlier `FEES_DCC` flag for the merchant, or a
  home-currency charge within 24 h of foreign-currency spending). MERGED / refund / unparsed get their own short line.
  English only: the Shortcut has no app locale; the app keeps the localised `notification`. The response schema is
  `CaptureEventResponse.extend({ nudge })`, local to the route (`packages/shared` unchanged). Read-only: no proposal,
  approval or payment (I6, asserted in `test/core/shortcut-devices.test.ts`).
- **Tests:** `apps/api/test/core/shortcut-devices.test.ts` (list, revoke → 401, idempotence, BOLA 404 + audit, nudge
  content incl. budget, dedupe, foreign markup, DCC, unparsed/refund), `apps/api/test/intel/parsers.test.ts`
  ("what the iOS Transaction trigger actually sends"), `apps/mobile/src/api/__tests__/shortcut-endpoint.test.ts`.


## 2026-10-14 Kassa Business M0: data model, two pizzerias, phone tunnel

- **Tables (migration `0007_business`, in `db/schema.ts`):** `users.account_type` (PERSONAL|BUSINESS), `merchants`
  (slug = mock-world storeId), `inventory_items`, `recipes`, `supplier_items`, `stock_movements` (append-only by
  convention like the ledger: no UPDATE/DELETE in code; on-hand = Σ qty; corrections are ADJUSTMENT rows),
  `sales_daily`, `purchase_orders`, `shop_orders`. Journal `when` set to 1791790000003 (after 0006's hand-set value):
  drizzle applies only migrations newer than the last applied one, so a generated `Date.now()` would be skipped.
- **Shared:** `purchaseOrder.ts` (`PurchaseOrderCore`, `poHash` = JCS SHA-256 like `mandateHash`, lines sorted by
  supplierSku, totals checked; `itemsHash` over {sku, qty, unitPriceMinor}). `CanonicalOrder.itemsHash` and
  `.purchaseOrderId` are optional, so existing golden vectors are unchanged. Reason codes `INVOICE_ABOVE_PO`,
  `INVOICE_ACCOUNT_MISMATCH`, `PO_NOT_DELIVERED`, `PO_ABOVE_FORECAST` (+ en text, app locale).
- **Seed:** personas `pizzeria-bud` (HUF/EU, storeId `bud`, capped wallet), `pizzeria-sha` (CNY/CN, storeId `sha`,
  HANDOFF) and `li-wei-cn` (Li Wei as a Shanghai customer, region CN). A separate persona instead of a flag on `li-wei`
  keeps that persona and its tests unchanged. Suppliers: A (VERIFIED) / B (COOLING, attacker) in Budapest; C (VERIFIED)
  / D (COOLING, attacker) in Shanghai, QR-wallet merchants without IBAN. The forecast contract the seed is tuned for is
  documented in `fixtures/seed-data.ts` (`seedForecastShortage`): Shanghai is exactly 400 boxes short by the end of
  tomorrow; Budapest has no shortage.
- **mock-world:** `/shop/:store/*` for `bud` and `sha`; `pizza` stays an alias of `bud`. POS default storeId is `bud`.
  `KASSA_APP_URL` (default `http://localhost:8081`) for till QR links (M3).
- **`pos-low-dough` trigger** now sends `{sku: "DOUGH-BALL", level: 12, unit: "pcs", storeId: "bud"}`; before, mock-world
  rejected `{sku: "dough", level: "low"}` with 400 and the trigger returned the error inside a 200.
- **`bun run phone`** (`scripts/phone.ts`): Caddyfile-equivalent proxy + named cloudflared tunnel when
  `CLOUDFLARED_TUNNEL` and `PHONE_HOST` are set (stable RP_ID), else a quick tunnel with a warning; prints the env block.

## 2026-10-15 Kassa Business M5: purchase order → supplier → invoice → payment

- **Agent business tools** (`get_inventory`, `forecast_stock`, `propose_purchase_order`; schemas in
  `@kassa/shared` `BUSINESS_TOOL_INPUT_SCHEMAS`, kept out of `TOOL_INPUT_SCHEMAS` so the 11 personal tools are
  unchanged) are added only for a BUSINESS account, with a business section appended to the system prompt.
  `propose_purchase_order` **moves no money**: it writes one DRAFT `purchase_orders` row (`business/drafts.ts`, ledger
  `PO_DRAFTED`, owner notified) and never creates a proposal, approval or payment (`DRAFT_TOOLS`; `WRITE_TOOLS` stays
  `["propose_order"]`). The planner passes supplier SKUs and packs only; the price is the supplier's **structured
  catalog** price (`ports.catalog`, free-text notes dropped). Refused above `merchants.poCapMinor` (`PO_ABOVE_CAP`,
  ledger `PO_REFUSED`), for a non-VERIFIED supplier, or when an open PO already covers the SKU. A line above 2× the
  forecast suggestion (or with no suggestion) flags `PO_ABOVE_FORECAST`. Agent code reaches only `business/drafts`,
  `forecastData` and `queries`; signing (`business/sign.ts`, imports payments credentials) is not reachable from agent/**.
- **Signing** (`POST /business/purchase-orders/:id/sign/options` → `{core, poHash, webauthnOptions}`, `.../sign`):
  the server rebuilds the core from the DRAFT (a different submitted core → 409 `PO_CHANGED`), verifies the assertion
  with `verifyPaymentsAssertion` (payments credential table, `live`: the counter advances, so a replay fails), stores
  core + poHash + assertion (ledger `PO_SIGNED`) and sends the PO to the supplier, HMAC-signed by Kassa
  (`rails/http.mockWorldSigned`, same scheme as mock webhooks) → SENT. Send failure keeps SIGNED (`.../send` retries).
- **Supplier portal** (mock-world `/mock/supplier/:id/portal`, DEMO_ENABLED only): Confirm / Mark delivered / Issue
  invoice (PDF via `pdf/invoice.ts`), each a signed `"supplier"` webhook (`po.confirmed`, `po.delivered`,
  `po.invoiced`). Delivery appends one RECEIPT movement per line (`ref = PURCHASE_ORDER:<id>`, once, advisory lock).
  B and D have a "swapped bank details" button: an invoice for A's / C's PO in that supplier's name, paid to the
  attacker's IBAN / QR merchant (attack A9).
- **Three-way match** (`business/invoices.ts`): supplier name = PO supplier, `accountHash(invoice account)` = signed
  `supplierAccountHash` = the payee's current hash (payee VERIFIED), else `INVOICE_ACCOUNT_MISMATCH`; same currency and
  amount ≤ signed total, else `INVOICE_ABOVE_PO`. For CN QR-wallet suppliers the "account" is the QR payee name (what a
  MERCHANT_ID payee holds). A refusal is ledgered (`INVOICE_REFUSED`, hashes only), recorded on the PO and notified;
  nothing is proposed. A wrong supplier name is reported as `INVOICE_ACCOUNT_MISMATCH` (no separate code). A match
  creates one obligation (ONCE, category `supplies`) and `proposeOrder({obligationId, purchaseOrderId})` as SCHEDULER.
- **Rules**: a `purchaseOrderId` must be the user's signed PO for this payee with amount ≤ total; the decision is never
  AUTO (forced ASK, T2), and `PO_NOT_DELIVERED` is added when no delivery was reported. EU → BANK_TRANSFER, CN → HANDOFF.
- **Payments re-check** when `CanonicalOrder.purchaseOrderId` is set: recompute `poHash` from the stored core, re-verify
  the stored owner assertion (`stored` mode, like `verifyMandate`), payee + account = the PO's supplier, amount ≤ total,
  PO not PAID. The PO goes PAYING when the payment row is created, PAID on SENT (`payments/status.ts`, ledger `PO_PAID`),
  back to INVOICED on FAILED/CANCELED.

## 2026-10-13: Limits and budgets apply on the passkey, no 24 h wait

- **Raised caps** (`PATCH /settings` caps: per payment / day / month, small-auto, a lowered reserve) still need a
  passkey assertion over the change hash (428 round trip, I8), but then apply at once: rule_changes LOOSEN with
  `appliedAt = effectiveAt = now`, ledger `RULES_LOOSENED`. Autonomy loosenings (preset, payment policy, money mode,
  agent, region), unfreeze and mandates keep the 24 h delay.
- **Budgets** (`PUT /budgets`, the chat's budgets card via the `ask_budgets` UI tool): new or lowered limits tighten
  and apply at once without a passkey; a raised limit (a bigger budget lowers the risk score) needs the passkey and
  then applies at once (rule_changes kind `BUDGETS`). Denied to KassaLite sessions.
- Why: limits are numbers the user sets deliberately; the passkey already proves it is them, and waiting a day to use a
  raised limit made the review sheet and the chat card feel broken. The agent still cannot change either (I1): the app
  applies the user's own confirmed values.

## 2026-10-13: Backup codes, every ISO currency, manual cards, data import/export, onboarding pickers

- **Backup codes (lost passkey).** The spec has no recovery path: a lost device meant a lost account.
  Choice: 10 one-time codes (Crockford base32, 50 bits, `XXXXX-XXXXX`), created behind a passkey round trip
  (428) and shown once; only HMAC-SHA256(code, SESSION_SECRET) is stored (`recovery_codes`, migration 0009).
  A code registers a new passkey that **replaces** every old one (rules and payments stores), revokes earlier
  sessions (`users.sessions_revoked_at`) and **freezes payments** (a tightening, I8); moving money again needs
  the new passkey plus the usual 24 h unfreeze. So a stolen code alone never moves money at once, and the
  owner sees the freeze. Routes are public, auth-rate-limited, refused to KassaLite sessions.
- **Every ISO 4217 currency.** `@kassa/shared` takes its table from the `currency-codes` package (the ISO
  maintenance agency's list) instead of a hand-kept list of five. `SupportedCurrency` stays the five the
  simulated wallet and rails hold; records, bills, budgets, cards and the home currency accept any code.
  Live rates: all ECB currencies (Frankfurter) and er-api for the rest; offline rates still cover the five.
- **Onboarding pickers.** The model often asks two things per reply or asks in prose. Every question now gets
  buttons (up to two per turn): the known topics (the preset also matches "how hands-on …"), and a question
  that lists its own answers ("what's it for (dorm, phone, transit…)?") gets those plus "Other…". The home
  currency options come from the conversation (codes, symbols, currency, country and demonym names) and any
  other currency can be searched. Onboarding never completes before asking about cards, and says why only
  the last 4 digits are needed.
- **Manual cards.** `POST /cards`, `DELETE /cards/:id`. Cards only label spending, so adding or removing one
  loosens nothing and needs no passkey.
- **Data import/export.** `GET /export` writes Kassa's own `kassa-export` v1 JSON. `POST /import/preview`
  maps Kassa's export exactly and any other JSON deterministically (record arrays anywhere in the document,
  multilingual field-name synonyms plus a Levenshtein match, locale-aware amounts, `chrono-node` dates with
  the day/month order read from the whole column). No model sees the file. `POST /import/commit` only adds:
  spending through capture (I6, dedupe, source `IMPORT`, migration 0010, no per-row notifications), bills
  through the onboarding path (placeholder payees, never payable without account details; sanctions
  screening, I9), cards. Budgets are applied by the app with `PUT /budgets` and the passkey.

## 2026-10-14: Payment notifications with when, where, the likely place and budget context for every category; money-advice prompt

- **When and where.** The iOS Shortcut and Android forwarders may add `street`, `city`, `country`, `latitude`,
  `longitude` to the capture body (`capture/place.ts` `PlaceHint`, all optional, junk coordinates ignored). Kassa keeps
  them on the transaction (`transactions.place` jsonb, migration 0011) with coordinates rounded to 3 decimals (about
  100 m); the street and coordinates are removed with the raw merchant text after `RETENTION_DAYS_CAPTURED_TEXT`.
  The notification gives the local time ("Today 10:59"), the street and city, and visits this month.
- **Likely place.** Statement text often starts with the payment processor ("SQ *BLUE BOTTLE 0412"). `cleanMerchant`
  moves known processors aside (Square, SumUp, Zettle, PayPal, Toast, Shopify, myPOS, Stripe, PayU, Checkout.com,
  GoDaddy, Google, Apple) and drops store numbers; `merchantDisplayName` uses it everywhere, after the dictionary and
  the user's payees. With AI consent and LIVE mode, the reader model also names the place and its kind; only a
  medium or high confidence guess is shown ("Probably Blue Bottle Coffee, a café") and kept (`place.source = "AI"`).
- **Budget context outside budgets.** Before, a spend in a category without a budget produced no in-app notification
  and only the category name in the Shortcut line. Now (EACH mode) it sends `budget.unbudgeted` (kind
  `SPEND_UNBUDGETED`): the month so far in that category, the usual month (average of up to 3 full calendar months
  after the first spend, `budget/context.ts`), spending in all categories without a budget, all spending and its share
  of monthly income (profile incomes, `monthlyIncomeOf`). The daily digest adds the outside-budgets total. THRESHOLDS
  mode stays quiet for unbudgeted categories (there is no threshold to cross).
- **AI tip, grounded.** One call per tap (`advice/enrich.ts`, reader model, 4 s timeout, `AI_PAYMENT_NOTES=false` turns
  it off) returns the place guess and one tip. The server checks the tip: every number in it must appear in the facts
  it sent, else the tip is dropped. Any failure leaves the deterministic notification.
- **Money-advice prompt.** `advice/prompt.ts` `ADVICE_PROMPT` is appended to the agent's `SYSTEM_PROMPT` and used by
  the payment tip, so advice sounds the same in chat and in notifications: grounded numbers only, look at spending
  outside budgets, priority order (bills, budgets running out, fees/DCC, unusual spending, goals), concrete and kind,
  protected money first, everyday money management only (no investment, credit, tax or legal advice). New read-only
  agent tool `get_spending_summary` (month per category with or without a budget, usual month, outside-budgets total,
  share of income). Replay recordings are unaffected: they are keyed by the redacted user text.
- **Cards learned from taps.** A card hint that matches no card (`matchCard`: last 4 digits, else the label) used to be
  dropped. Now `capture/cards.ts` adds the card (label and last 4 digits read from the hint, no model needed) with
  the home currency as billing currency, or the spend's currency for multi-currency accounts, and notifies
  (`CARD_LEARNED`, plus a nudge line on its first tap). Cards only label spending, so adding one needs no passkey (I8).
  Data imports keep adding their own cards.
- **Response shape.** `POST /capture/shortcut` adds `nudgeTitle` and `nudgeBody`; `nudge` is now the whole
  notification, one part per line (older Shortcuts keep working). `GET /capture/recent` adds an optional `place`
  (`name`, `kind`, `where`), shown in KassaLite's Activity.
- **Tests:** `apps/api/test/core/payment-notes.test.ts`, `shortcut-devices.test.ts` (new format),
  `apps/mobile/src/screens/activity/__tests__/notification-text.test.ts`, `screens/lite/__tests__/activity-screen.test.tsx`.
## 2026-10-15 — Real-world incident attacks A10–A17; payee account ciphertext bound to its row

- **Attacks.** `apps/api/test/attacks/A10..A17` recreate public incidents (Freysa, Grok + Bankrbot, AIXBT, ElizaOS fake
  memories, MCP tool poisoning / EchoLeak, Chevrolet "$1 Tahoe" / Project Vend, salami splitting, APP "safe account"
  scams) with a planner and Reader that obey the injection. Each also has a naive row (`test/naive/`). Sources and
  mappings: `docs/SECURITY.md` §6 "Real-world incidents recreated". Result: guarded 0 of 16 paid, naive 16 of 16.
- **Fix found by A12.** A row writer could copy a cooling payee's `accountEnc` + `accountHash` into a verified payee
  covered by a mandate, and autopay paid the copied account. Spec §8 says only "AES-256-GCM, AAD userId". Deviation:
  new ciphertexts are `v2` with AAD `kassa:payee:v2:<userId>:<payeeId>` (`payees/crypto.ts`; `createPayee` picks the id
  before the insert). `v1` stays readable for existing rows and for callers that do not pass a payee id. Payments
  decrypts for the payee row and requires `accountHash(account) = order.payeeAccountHash`, else
  `REFUSE_UNVERIFIED_PAYEE`. Residual: v1 rows are not bound (SECURITY.md R30).

## 2026-10-16 — Real time by default, demo time as a switch; sessions on wall time

- **Problem:** spec §15 puts the whole app on the demo clock (real now + `demo_state.clockOffsetMs`), and the seed sets
  it to story time (2026-10-27). A deployment that loads the demo data showed that date to everyone, and a reviewer
  using the app normally saw due dates and cooling periods 11 days off.
- **Choice:** `demo_state.clock_mode` (migration 0016): `REAL` (the default) is the system clock, `DEMO` adds the stored
  offset. The offset is kept while `REAL`, so switching back resumes the story time. Deployments seed with `REAL`
  (`api/index.ts`); `bun run seed`, the tests and the Stage reset keep the mode the script needs (`DEMO` for the seed
  and tests, the current one for a reset). The Stage screen (Settings → Demo) has a **Demo time** switch
  (`POST /demo/clock/mode`, demo admin token, ledger `DEMO_CLOCK_MODE`); the +1 h / +1 day / +3 days buttons still move
  the demo clock, and pressed in real time they start it at real now. Everything that read the clock (scheduler,
  cooling periods, due dates, expiries, the mock world through `GET /demo/clock`) follows the clock in use with no
  change of its own.
- **Exception:** session and refresh token lifetimes (`iat`/`exp`, and the "signed out before" mark of a backup-code
  recovery) use wall time (`clock.realNowMs()`), so moving or switching the demo clock neither signs people out (an
  11-day jump used to end the 7-day web session) nor keeps an expired token alive when the clock goes back.

## 2026-10-16 — A demo switch for the 24 h waits

- **Problem:** I7 (a new recipient cools 24 h) and the 24 h loosening delay (settings, mandates, unfreeze) make a live
  demo wait a day or depend on the Stage clock. Reviewers asked for a way to turn the waits off.
- **Choice:** `POST /demo/cooling` (registered only with `DEMO_ENABLED`), per user, stored in `demo_cooling_off`
  (migration 0017; a row = off). Off needs the user's passkey (428 round trip) and is logged as `DEMO_COOLING_OFF`; on
  needs nothing (it tightens) and is logged as `DEMO_COOLING_ON`. Default on. With it off, the waits are 0 for that user:
  a new recipient still starts COOLING (T2 only, never autopilot) but can be verified and paid at once, and loosenings
  apply at the next scheduler tick. Outside demo mode a stored row is ignored. The app shows a red banner on every screen
  while off (`MeResponse.demo.coolingOff`), and the switch sits on the Stage screen (Settings → Demo). The attack suite
  keeps the waits on, and no agent tool reaches the switch. Known risk: SECURITY.md R36.

## 2026-10-16 — App in English, Simplified Chinese, Russian and Kazakh (replaces "i18n via i18next, English only")

- **Problem:** the app shipped English only (2026-10-10). Reviewers include a Shenzhen jury, and the users the app is
  for (students from Kazakhstan abroad) read Russian or Kazakh more easily than English.
- **Choice:** `zh` (Simplified Chinese), `ru` and `kk` (Kazakh, Cyrillic) next to `en`, one folder per language in
  `apps/mobile/src/locales/`, same 23 namespaces and keys. Plurals use i18next's suffixes per `Intl.PluralRules`:
  `zh` has only `_other`, `ru` `_one/_few/_many/_other`, `kk` `_one/_other`. The language comes from the device (or
  browser) preference list, the first supported one wins, English otherwise; every Chinese tag gets the Simplified
  strings. Settings → Appearance has a **Language** picker (Device language, then each language by its native name),
  stored like before under `readynative:language` through the storage adapter; "Device language" removes the key.
  Web renders English first (the static HTML is English) and switches after hydration. Product names (Kassa,
  KassaLite), currency codes, reason-code identifiers and JSON field names stay as they are. Server-sent prose (notes
  the API writes) stays English; `apps/api` is unchanged.
- **Tests:** `apps/mobile/src/locales/__tests__/locales.test.ts` checks each locale has exactly the English keys, the
  plural forms its language needs, the same `{{placeholders}}` per key and the product names;
  `src/lib/__tests__/i18n.test.tsx` covers device-language fallback, plurals and the "Device language" choice.
- **Review needed:** the Kazakh text has not been read by a native speaker and needs that review before release
  (iOS Shortcuts steps keep the English action names in Kazakh). Russian and Chinese should get a native read too.

## 2026-10-16 — Revocations and rate limits in Postgres; logout revokes the cookie; a KEK rotation script

- **R13, shared stores.** The refresh-token spent list (a `Set` in `auth/session.ts`) and the `@fastify/rate-limit`
  counters lived in process memory, so a restart or a second instance accepted a spent refresh token again and reset
  every limit. Both are tables now (migration 0018), following the challenge stores of migration 0012:
  `revoked_tokens` (jti, kind, the token's `exp`; spending is one `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so of
  two concurrent uses one wins) and `rate_limit_counters` (one row per bucket key, one atomic upsert per request). The
  scheduler purges rows whose token or window has expired, on wall time. Logout now records a refresh token only when
  it verifies (before, any decodable jti was added). Deviation from a window aligned to the clock: a window starts at a
  key's first hit, as in the plugin's in-memory store, so limits behave exactly as before and a burst cannot get twice
  the budget across a boundary. If the database call fails, that hit is counted in memory (per instance, the old
  behaviour) rather than refused or let through. Cost: one write per request.
- **R14, logout revokes the cookie.** `POST /auth/logout` used to clear the web cookie only, so a copy of it stayed
  valid for its 7 days. Logout now records the cookie's jti in `revoked_tokens` (kind `session`, kept until the
  cookie's `exp`, wall time), and the session check (`authenticateSession`, used by `requireUser` and `authenticate`)
  refuses a revoked or jti-less cookie. Cost: one indexed read per cookie-authenticated request. Native access tokens
  (15 minutes) are still not revoked on logout; their refresh token is.
- **R15, KEK behind a provider, with a rotation script.** Per-user data keys are wrapped through a small `KeyProvider`
  interface (`privacy/keys.ts`): `kekId()`, async `wrap` and `unwrap`. The env provider is the previous behaviour
  (`USER_KEK`, local AES-256-GCM, AAD bound to the user). `scripts/rotate-kek.ts` (`bun run kek:rotate [--dry-run]`)
  re-wraps every `user_keys` row from `USER_KEK_PREVIOUS` to `USER_KEK` in one transaction under an exclusive table
  lock, checking each new wrap before writing it, and prints only counts and KEK ids. `USER_KEK_PREVIOUS` is a new,
  optional variable the env provider uses to unwrap (never wrap) while a rotation is under way, so the API can switch
  KEKs without downtime. No cloud KMS SDK was added: SECURITY.md §5.5 describes how a KMS provider plugs in. Not
  done: rotation of the other keys; the PAN reference key is still derived from `USER_KEK` (a rotation changes card
  placeholders' digests, nothing stored is lost).

## 2026-10-16 — A simulated identity check (KYC) gates payments and top-ups above EUR 1,000

- **Problem.** Licensing and KYC were "on paper only": COMPLIANCE.md listed customer due diligence as out of scope
  and nothing in the code knew whether a user had been identified, so any amount under the caps could be paid.
- **Choice.** A deterministic identity checker in mock-world (`/mock/kyc/checks`: fictitious document + simulated
  liveness → VERIFIED / REVIEW / REJECTED with reason codes, no network) and an API module `kyc` (`POST /kyc/start`,
  `GET /kyc`, migration 0019). The latest check decides the standing. Stored: outcome, reason codes, document type
  and country, timestamps, and the last 4 characters of the number sealed with the user's data key; never the full
  number, the name, the date of birth or an image. Each outcome is a ledger entry (`KYC_VERIFIED`, `KYC_REVIEW`,
  `KYC_REJECTED`).
- **Threshold: EUR 1,000.00 per payment, and per day for top-ups** (`KYC_THRESHOLD_MINOR` = 100000 in
  `KYC_THRESHOLD_CURRENCY` = EUR, converted to each home currency and rounded down, like the payments daily cap;
  unconvertible means 0, fail closed). EUR 1,000 is the amount at which EU AML rules already require due diligence
  for an occasional transfer of funds (AMLD Art. 11(b)(ii)) and full payer data (TFR); it lets small everyday
  payments (pizza, rent shares, most bills) work before the check and puts the hero's tuition (about EUR 2,400)
  behind it. It is a sandbox gate, not a CDD policy: a licensed partner identifies every customer at onboarding.
- **Enforcement.** Rules: new decide step 6b, `KYC_REQUIRED` (a hard refusal, added to `HARD_REFUSE_CODES`) after
  the existing refusals (their codes are unchanged) and before mandates and small-auto, so no tier skips it. Payments:
  its own re-check before the nonce (step 8a, own conversion, own read of `kyc_checks`), so a check that fails after
  signing still stops the payout. Wallet top-ups: a day's total above the threshold is refused (422, ledgered
  `WALLET_TOPUP_REFUSED`). Handoff (region CN or money mode HANDOFF) is not gated: Kassa moves no money there and the
  user's own wallet runs real-name verification.
- **No passkey to start a check.** It adds information and loosens no signed rule; above the threshold each payment
  still needs the passkey (or a signed mandate) and stays under the passkey-signed caps. `POST /kyc/start` is in the
  sensitive rate-limit bucket.
- **Seeded demo personas and test fixtures start VERIFIED** with a document-less check (`provider` `seed` or
  `fixture`), as an account opened at the licensed partner would be, so the scripted demo and the existing tests
  (attack suite unchanged) behave as before. `createUserWithPasskey({ kyc: "NONE" })` gives an unchecked user;
  accounts created in the app start unchecked and see `KYC_REQUIRED` with a link to the Identity check screen.
- **Erasure** keeps the check rows (AMLD Art. 40 record keeping, listed in `RETAINED`); the last 4 characters become
  unreadable with the shredded key. The DSAR export lists the checks.
- **Not done / honest limits:** no document authenticity, issuer data, real liveness, PEP screening or ongoing due
  diligence; REVIEW is never resolved (SECURITY.md R37). Jurisdiction mapping: COMPLIANCE.md §12. The Kazakh,
  Russian and Chinese strings of the new screen need a native read like the rest of the app.
