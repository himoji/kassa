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
