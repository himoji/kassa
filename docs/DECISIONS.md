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
the licence scope. The competition requires a public GitHub repository. **Open item:** before making this
repo public, get written permission from the licensor (ReadyNative / Madiyar Baizhigitov). Keeping the repo
private and adding judges as collaborators also shares the source outside the licence scope (3c), so that
route needs the same permission. Do not remove `apps/mobile/LICENSE` or the
`apps/mobile/LICENSES/` notices (section 3e).

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
