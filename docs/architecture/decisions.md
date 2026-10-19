# Decisions

Deviations from `docs/architecture/tech-spec.md` (spec §0: date, problem, choice). Newest last.

## 2026-10-10 — Expo app from the ReadyNative Pro boilerplate

- **Problem:** spec §3/§16 assume a hand-built Expo app; building navigation, UI kit, theming, i18n, push and
  testing from scratch costs days we do not have before the Oct 17 freeze.
- **Choice:** `apps/mobile` is generated from ReadyNative Pro (`github.com/ReadyNative/ready-native-pro`, SDK 57, bun,
  Expo Router, `@/components/ui`, `@/lib/*`). Native-first (native tabs, `@expo/ui`, form sheets, SF Symbols, haptics,
  native passkeys); web works through `.web.tsx` fallbacks.
- Setup command used (from `apps/mobile`):
  `bun run setup --preset default --auth none --backend none --data react-query --state zustand --i18n i18next --ui nativewind4 --forms react-hook-form --storage kv-store --push expo-notifications --payments none --analytics none --crash none --consent none --location none --onboarding off --widgets none --testing jest --yes`
  (auth and payments are ours: passkeys + Stripe). Examples were not kept.

## 2026-10-10 — i18n via i18next, English only

- **Problem:** the spec does not cover localisation; the boilerplate ships six demo locales.
- **Choice:** i18next + react-i18next, `en` only. Every user-facing string goes through `t()`, including reason-code
  labels, which the app maps from `ReasonCode` values in `@kassa/shared` (the server sends codes, never prose).
- **Superseded** on 2026-10-16 by "App in English, Simplified Chinese, Russian and Kazakh" (end of this file).

## 2026-10-10 — Provider-agnostic LLM via the Vercel AI SDK

- **Problem:** spec §3/§9 pin one vendor's SDK; we want to swap providers (including a local model) without code
  changes, and replay must not depend on one vendor's wire format.
- **Choice:** Vercel AI SDK (`ai`) with a provider registry. Env strings `provider:model`, provider one of
  `openrouter`, `openai`, `google`, `local` (OpenAI-compatible endpoint at `LOCAL_BASE_URL`, e.g. Ollama). Defaults:
  `PLANNER_MODEL=openrouter:deepseek/deepseek-v4.1-flash-1017`, `READER_MODEL=openrouter:deepseek/deepseek-v4.1-flash-1017`.
  Replay (`AGENT_MODE=REPLAY`) uses the AI SDK mock model. Providers without tool calling or vision return an error code
  for that feature.

## 2026-10-10 — bun workspaces + Turborepo instead of pnpm

- **Problem:** spec §3 says pnpm; the boilerplate is bun-native.
- **Choice:** bun workspaces (`apps/*`, `packages/*`) + Turborepo, layout as spec §4. `pnpm <script>` becomes
  `bun run <script>` (e.g. `bun run ledger:verify`, `bun run keys:generate`). Hoisted linker (`bunfig.toml`): some React
  Native libraries break under isolated installs. Bun reads `patchedDependencies` only from the root `package.json`, so
  the `react-native-screens` patch is declared there (file stays in `apps/mobile/patches/`).

## 2026-10-10 — Smaller contract choices made while scaffolding `@kassa/shared`

- Consumed from TypeScript source (no build): `exports` → `src/index.ts`, explicit `.ts` imports
  (`allowImportingTsExtensions`, `noEmit`). Jest in `apps/mobile` transforms its ESM-only deps (`@noble/hashes`, `canonicalize`).
- Hashing is pure JS (`@noble/hashes` + `canonicalize`) so `orderHash`/`mandateHash` match in Node, browsers and
  Hermes. `jcs()` polyfills `String.prototype.isWellFormed` (ES2024) only if missing.
- The spec's preset switch `agentMode` is named `agentAutonomy` (`ON_REQUEST | PLAN_AHEAD | PLAN_AND_ACT`) to avoid
  clashing with demo `agentMode` (`LIVE | REPLAY`). `paymentPolicy` is `ALWAYS_ASK | RISK_BASED | NEVER_ASK`;
  `NEVER_ASK` with money mode `HANDOFF` or `PAY_IN_PLACE` is invalid (spec §10).
- `MandateCore` includes `v` and `mandateId` and requires sorted, unique `payeeIds`/`categories` (one canonical encoding).

## Licence note — ReadyNative

ReadyNative is a commercial licence (`apps/mobile/LICENSE`); sections 3b/3c forbid publishing or sharing the kit's
source, and the competition requires a public repository. **Resolved:** the licensor (Madiyar Baizhigitov, trading as
ReadyNative) is also a Kassa author and permits publication of these files in this repository for the FinTechathon
entry, as stated at the end of the root `LICENSE`. Further redistribution needs a ReadyNative licence. Do not remove
`apps/mobile/LICENSE` or `apps/mobile/LICENSES/` (section 3e).

## 2026-10-10 — Standards-first rule for unspecified details
Problem: the spec leaves many small details open (formats, encodings, algorithms).
Choice: follow architecture/tech-spec.md exactly; where it is silent, use the governing published standard and cite it in code comments: ISO 4217 (currencies/minor units), ISO 8601 / RFC 3339 (timestamps, UTC), ISO 3166-1 alpha-2 (countries), ISO 13616 + ISO 7064 mod 97-10 (IBAN), ISO 9362 (BIC), ISO 18245 (MCC), ISO 20022 (payment status / remittance field naming), ISO 639-1 + BCP 47 (locales), RFC 8785 (JCS), RFC 8032 (Ed25519), RFC 4648 §5 (base64url), RFC 2104 (HMAC), RFC 9562 (UUID), RFC 7519 (JWT), RFC 9457 (problem+json errors), W3C WebAuthn Level 3, NIST SP 800-38D (AES-GCM), IEEE 754 avoided for money (integers only).

## 2026-10-11 — Mobile app (Track C) choices where the spec is silent

- **i18n layout:** one JSON per namespace in `apps/mobile/src/locales/en/<ns>.json`; fully qualified keys
  (`t("order:approve")`, `useKassaT()`), CLDR `_one/_other` plurals. Jest checks every literal key exists, every
  `ReasonCode` has `{label,text}`, and no raw strings sit inside `<Text>`.
- **API base:** `EXPO_PUBLIC_API_URL` is the origin; the client appends `/api` (unset on web = same origin).
- **Signing guard (I3):** before any passkey prompt the app recomputes `orderHash(canonicalOrder)` (and
  `jcsHash(BaseRulesCore)`, `mandateHash` = challenge) and refuses to sign on a mismatch.
- **Handoff mismatch (A5):** on `QR_PAYEE_MISMATCH` the app hides the QR code as well as the pay button.
- **Demo clock:** countdowns use `Date.now() + me.demo.clockOffsetMs` (spec §15).
- **Session (spec §8):** native tokens in Keychain/Keystore (`expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`);
  single-flight refresh 30 s before expiry and once on 401 (RFC 9700). Web: httpOnly cookie, no token in JS.
- **Not built:** unfreeze, category correction UI (endpoint exists), account deletion.

## 2026-10-11 — Mock world and fixtures (Track D)

- **Mock bank money in minor units:** Wise names, ids, statuses and webhook shape, but `...Minor` integer fields
  (spec §0 forbids floats); rates stay decimal strings.
- **Sanctions sample is fictitious:** EU FSF schema shape, so real names are not misattributed; the real FSF export
  loads with the same structure.
- **Seed story time `SEED_NOW = 2026-10-27T09:00Z`:** 4–5 days before tuition (Oct 31) and rent (1st), so rent
  autopays after "+3 days"; the API sets the demo clock offset to it.
- **Webhook timestamps use the demo clock**, so the API's 5-min window (`Clock.now()`) survives clock jumps.
- **Fake issuing authorization endpoint** `POST /api/rails/fake-issuing/authorize` (HMAC-signed), so pizza checkout
  runs the same decision logic without Stripe (spec §11).
- **PDFs use the standard 14 fonts (WinAnsi)**, no embedding; Hungarian ő/ű avoided. Deterministic (pdf-lib
  `updateMetadata: false`) and checked byte-for-byte.
- **State is in memory** (reset on restart and `POST /mock/reset`); ids start from a time-derived counter.

## 2026-10-11 — Track B (intelligence) implementation choices

- **Extra tables** (`apps/api/src/db/schema.intel.ts`): `agent_messages` (redacted planner history, I11),
  `agent_documents` (uploads, cached Reader result), `merchant_category_memory` (spec §13), `onboarding_drafts`.
  drizzle.config lists both schema files.
- **FX sources** (verified 2026-10-10): Frankfurter `https://api.frankfurter.dev/v1/{date}` (ECB), NBK
  `https://nationalbank.kz/rss/get_rates.cfm?fdate=DD.MM.YYYY`, fallback open.er-api.com (`FALLBACK_ER_API`), last
  resort `fixtures/fx-rates.json` (`STATIC_EXAMPLE`, also offline: `FX_OFFLINE=1` / `NODE_ENV=test`). Every quote
  carries its `source`. Decimal strings → BigInt rationals, one HALF_UP rounding, matching `@kassa/shared` `fxMath`.
  Business days Mon–Fri (±1 business-day tolerance).
- **Dedupe neighbour bucket** (spec §13): the nearer neighbour, so sightings < 5 min apart always merge and ≥ 20 min never.
- **Reader evidence:** exact substring, then NFKC + whitespace-collapsed match. Images: one vision call returns a
  verbatim `transcript` that evidence is checked against (weaker; documented). No vision (`local`/`ollama` unless
  `LOCAL_VISION=true`, or `READER_VISION=false`) → `AI_VISION_UNSUPPORTED`. An invoice account differing from the
  verified payee's → `readerChecks.account = UNVERIFIED` → `REFUSE_SOURCE_MISMATCH`.
- **Redaction for display:** the planner sees placeholders; text shown to the user restores names and masks accounts
  (`HU…1234`, `•••• 1234`). History stores the redacted form.
- **REFUSE/COOLING stop:** the next step runs with `toolChoice: none`, then the loop stops; max 8 tool rounds + 1 text step.
- **Replay:** recordings hold model outputs only; tools run for real. Turn match: exact redacted text → keywords
  (`match`) → index. Reader extractions under `fixtures/agent-recordings/reader/<sha256>.json`, re-verified on replay.
- **Notifications** are `{key, params}` (`budget.each|threshold|digest`, `fees.dcc|settled`) plus English text. Digest
  at 20:00 in the region's zone (EU → Europe/Budapest, CN → Asia/Shanghai).
- **DCC flag** is evaluated on settlement events with `localAmountMinor/localCurrency` (`POST /capture/settlement`).

## 2026-10-11 — Track A (core money path) implementation choices

- **Payments daily cap default ₸2,000,000** (`PAYMENTS_DAILY_CAP_HOME_MINOR=200000000`): spec §20's ₸500,000 is below
  the hero tuition (€2,400 ≈ ₸1.3–1.4M). Independent of rules caps (per-payment ₸1.5M, day ₸2M, month ₸3M, small auto
  ₸10,000, reserve ₸50,000; example values). **`.env.example` still says 50000000; Track A could not edit it (file
  access denied) — update it to 200000000.**
- **Small-auto (step 9) is T1 without a mandate**, authorised by the passkey-signed base rules from
  `/onboarding/confirm` (`profiles.base_rules*`). Payments re-verifies that assertion (challenge =
  `jcsHash(BaseRulesCore)`) and the signed `smallAutoMinor`. No signed base rules → ASK (`AUTO_NOT_ELIGIBLE`).
- **Onboarding confirm applies immediately**; later loosenings go through `PATCH /settings` → rule_changes +24 h (I8).
- **Stored-assertion re-verification ignores the counter** (stored signatures are older than the live counter;
  freshness = mandate validity + `used_nonces`). Live T2 assertions enforce it (accept 0, W3C WebAuthn L3 §6.1.1).
- **Nonce before daily cap** in one transaction (per-user advisory lock): replay → `NONCE_USED`; a cap refusal rolls
  the nonce back.
- **Mandates are not seeded** (no passkey yet). `/onboarding/confirm/options` suggests the rent mandate (~11%
  headroom: HUF 180,000 → 200,000), signed via `/mandates/options` + `/mandates`, effective after 24 h.
- **Expired pending orders are re-issued** on `GET /orders/:id` with a fresh nonce/expiry; the old hash can never be approved.
- **Ledger:** base64url SHA-256; genesis `prevHash` = 32 zero bytes; checkpoints sign `JCS({seq, headHash, ts, keyId})`;
  keyId = RFC 7638 thumbprint. `/demo/reset` truncates it (demo only).
- **Credit record** bundles are signed with the checkpoint key, stored as a ledger entry under a 128-bit verifyId; the
  PDF is a hand-built ISO 32000-1 page.
- **Sessions:** HS256 JWTs (RFC 7519) on the demo Clock; rotating refresh tokens (RFC 9700 §4.14); challenges single-use, in memory (honest limit).
- **DB:** PGlite by default (`DATABASE_URL` unset → `pglite://./.data/kassa`), Postgres for `postgres://…`. Missing dev
  secrets are generated once into `.data/dev-secrets.json` (gitignored); dev `MOCK_HMAC_SECRET` equals mock-world's.
  `bun run dev` starts api + mock-world only (`dev:all` for everything).
- **Stripe Issuing (EU):** cards in `STRIPE_ISSUING_CURRENCY` (default EUR), Stripe limit = amount at mid + 3%; our
  check compares `merchant_amount`/`merchant_currency` with the signed order.
- **Schema additions** (marked "(added)" in `schema.ts`): users.overrides; profiles.caps, base_rules*,
  bank_profile_id, stripe_cardholder_id; payees.created_at; transactions.payment_id; proposals.category,
  obligation_id, created/updated_at; payments.user_id, proposal_id, home_amount_minor, home_currency, details,
  reason_codes, updated_at; issued_cards.payment_id, user_id, provider, last4, created_at; mandates.revoked_at;
  rule_changes.change_hash, canceled_at; devices.push_token, platform, revoked_at; demo_state.id, demo_user_id,
  demo_claimed. Enums generated from @kassa/shared.

## 2026-10-11 — Track A open decisions resolved (user: "reasonable defaults")
- Payments daily cap = ₸2,000,000 (PAYMENTS_DAILY_CAP_HOME_MINOR=200000000), independent of rules caps (I5). Accepted.
- Rent mandate signed by the user during onboarding (not seeded); effective +24 h (I8). Accepted.
- Small AUTO (rule 9) requires the passkey-signed base rules, else ASK (fail-closed). Accepted.
- Stored assertions re-verified without the counter check; counter stays for live T2. Accepted.
- Onboarding confirm applies once immediately; later loosenings wait 24 h. Accepted.
- Unfreeze: a LOOSENING (I8), fresh passkey + 24 h (demo clock). Freeze stays instant. (Implemented in Phase 2.)
- In-memory challenge store / refresh rotation: accepted for single process; known risk in security/self-assessment.md.

## 2026-10-11 — env management
`bun run env:setup` (scripts/env-setup.ts) syncs both .env.example files with the keys the code reads, generates a local .env (secrets, derived public keys, dev defaults: AGENT_MODE=REPLAY, ISSUING_PROVIDER=fake, PGlite), links apps/api/.env and apps/mock-world/.env to it, and writes apps/mobile/.env. Never prints secrets; idempotent.

## 2026-10-11 — Phase 2 security & compliance hardening (apps/api)
- **Deny by default (OWASP API2, ASVS 4.1.5).** `src/http/security.ts` adds the session check to every route via an
  `onRoute` hook unless it is in `PUBLIC_ROUTES`, which states what authenticates it instead (webhook HMAC / Stripe
  signature, Shortcut device token, demo admin token, refresh token) or that it has no personal data.
  `test/security/http-hardening.test.ts` enumerates every route (401 unauthenticated; no stale entries).
- **BOLA (OWASP API1): 404, never 403,** for another user's resources. Each miss is audited as `AUTHZ_DENIED
  {actorUserId, resource, resourceId, existed}` for missing and foreign ids; `actorUserId` (not `userId`) so the
  prober's own `GET /ledger` is not an existence oracle.
- **Audit log = ledger entries** (hash-chained, I12): `AUTH_LOGIN_SUCCEEDED/FAILED`, `AUTH_ASSERTION_FAILED`,
  `AUTHZ_DENIED`, `UNFREEZE_REQUESTED`, `ACCOUNT_UNFROZEN`, `PRIVACY_EXPORTED/RESTRICTED/ERASED`, `PROFILE_RECTIFIED`,
  `AI_CONSENT_GIVEN/WITHDRAWN`, `RETENTION_PURGED`. One tamper-evident store, checked by `ledger:verify`.
- **Rate limits** (@fastify/rate-limit, per IP): global 600/min; 20/min auth, refresh, public credit-record verify,
  demo admin; 30/min approve, Shortcut capture, unfreeze, privacy (env `RATE_LIMIT_*`). `TRUST_PROXY` for Caddy.
- **Headers/CORS/CSRF/body:** helmet with API CSP (`default-src 'none'; frame-ancestors 'none'`), no-referrer, HSTS on
  https; CORS allow-list = PUBLIC_ORIGIN + EXTRA_ORIGINS; cookie requests with a foreign `Origin` → 403
  `CSRF_ORIGIN_MISMATCH` (SameSite=Lax misses same-site origins). Body limit 1 MiB; 11 MiB on `POST /agent/documents`.
  5xx never carries messages or stacks.
- **Demo:** routes exist only with `DEMO_ENABLED`; production refuses to start with it and a `DEMO_ADMIN_TOKEN` < 32
  chars; token compared with `timingSafeEqual` over SHA-256; missing token accepted only under `NODE_ENV=test`.
- **Unfreeze = loosening:** `POST /unfreeze` → 428 PasskeyChallenge over `jcsHash({v, kind:"UNFREEZE", userId,
  frozenAt, nonce})` → `rule_changes` (UNFREEZE, LOOSEN, +24 h); the scheduler lifts it. A new freeze cancels pending
  unfreezes. The nonce prevents replay.
- **Crypto-shredding (GDPR Art. 17).** Per-user 256-bit DEK in `user_keys`, wrapped with AES-256-GCM under `USER_KEK`
  (AAD = userId). Personal fields of ledger payloads are sealed in a `pii` member (`v1.<iv>.<ct>.<tag>`). Erasure nulls
  the wrapped DEK (tombstone): ciphertexts become unreadable, hashes stay, `ledger:verify` still passes (tested).
- **Erasure deletes** passkeys, devices, payees, obligations, budgets, cards, transactions, category memory,
  notifications, conversations, documents, drafts, unexecuted proposals; name → "[erased]". **Retains** under Art.
  17(3)(b) (e.g. AMLD Art. 40) and 17(3)(e): approved proposals, payments, approvals, mandates (revoked), rule changes,
  with names, account hash, purpose and details overwritten. The user row stays as a tombstone (`erased_at`). Stripe and
  mock-bank records are not erased (residual risk).
- **Art. 18** = freeze + `restricted_at` (AI routes 403 `PROCESSING_RESTRICTED`); lifted only by passkey + 24 h
  unfreeze. **Art. 16** = `PATCH /me {displayName}`. **Art. 15/20** = `GET /privacy/export`.
- **AI consent and notice.** `users.ai_consent_at`; chat, uploads and onboarding chat → 403 `AI_CONSENT_REQUIRED`
  without it. Given via `aiConsent: true` at `POST /auth/register/verify` or `POST /privacy/ai-consent {consent}`
  (also withdraws, Art. 7(3)). `GET /me.aiNotice` and public `GET /privacy/ai-notice` (EU AI Act Art. 50; GDPR Art. 13)
  name providers/models and what each receives.
- **The Reader receives raw document text** (I10 quarantine: no tools, no memory, output re-checked). I11 applies to
  the planner: a test finds no IBAN, PAN, email, phone, payee or user name in any planner prompt.
- **PCI DSS scope (found while testing):** CARD placeholders stored the full PAN. Now
  `pan:<HMAC-SHA256 (key = HKDF(USER_KEK, "kassa:pan-ref:v1"))>:<last4>` (PCI DSS v4.0 3.5.1); migration 0001 rewrites
  legacy rows to `pan:legacy:<last4>`. Tests: a full DB dump contains no PAN.
- **Retention** (GDPR Art. 5(1)(e)), hourly at most: notifications 90 d, conversations 30 d after last message,
  documents 30 d, raw merchant text 90 d (minimised, not deleted). `RETENTION_DAYS_*`, 0 = keep.
- **Dependencies:** apps/api/package.json declares everything it imports (previously only hoisted), plus
  @fastify/helmet, @fastify/cors, @fastify/rate-limit.

## 2026-10-11 — Phase 2 bug fixes B1, B2, B4 (apps/api, packages/shared)

- **B1, Reader checks across turns (I10, rules §10 step 3).** Problem: a document read in one turn and paid in a later
  one skipped `REFUSE_SOURCE_MISMATCH`. Choice: Reader results persist per docId (`agent_documents.reader_result`) and
  `propose_order` gathers checks from cited `docIds` (unknown → `DOC_NOT_FOUND`, unread → `DOC_NOT_READ`), invoices read
  in the conversation, and any read invoice whose *claimed* amount + currency or account matches. Worst status wins.
  Applied docIds are stored as `sourceDocIds`. Trade-off: a suspicious invoice keeps refusing matching proposals until
  retention purges it (30 d).
- **B2, funding route bound into the signed order (spec §12).** Problem: a bill larger than its one balance failed with
  `RAIL_ERROR` after signing. Choice: rules (`rules/funding.ts`) pick the cheapest feasible route from
  `fixtures/rails.json` (MOCK_BANK, BANK_TRANSFER; arrives by due date; balance covers it; else the cheapest late
  one). Signed in four optional `CanonicalOrder` fields: `fundingCurrency`, `fundingAmountMinor` (a MAXIMUM: estimate
  + 100 bps), `fundingRouteId`, `fundingMarkupBps`; all or none (`orderFunding()`). `v` stays 1 (old golden vector
  passes; a funded one was added). The rail refuses a quote above the signed max: `FUNDING_ABOVE_SIGNED_MAX`, no money
  moves. No feasible route → step 4b `REFUSE` `INSUFFICIENT_FUNDS` (in `HARD_REFUSE_CODES`). Balances unknown → the
  same-currency route is bound and the bank's own funds check is the backstop.
- **B4, one payment per obligation period.** Problem: the scheduler re-proposed tuition after "+3 days" (double-payment
  risk). Choice: table `obligation_settlements` (migration `0002_obligation_settlements.sql`, PK `(obligation_id,
  period)`, unique `proposal_id`). Rules claim the period inside the proposal transaction (`BAD_OBLIGATION` on foreign
  ids; step 1b `DUPLICATE_OBLIGATION_PAYMENT` when pending or paid). PENDING → PAID on payment; reject / FAILED /
  CANCELED frees it. The migration backfills from live proposals.
- **Demo story (spec §18 + Build Plan).** SEED_NOW = Oct 27 is after the parents' Oct 25 transfer, so the seeded
  ₸900,000 includes it. No single balance covers tuition €2,400 (≈ ₸1.21–1.47 M), so tuition is refused
  `INSUFFICIENT_FUNDS` until money arrives; rent (HUF 180,000 > HUF 120,000) is funded from KZT and autopays. The "money
  from home" trigger now sends ₸600,000 (spec §18; was ₸300,000). Live rates on 2026-10-11 (EUR ₸505.63, HUF ₸1.384):
  tuition debits ₸1,221,171 (signed max ₸1,233,383), rent ₸251,481 (signed max ₸253,996); ₸27,348 left. **Offline
  caveat:** with `FX_OFFLINE=1` (EUR ₸612.40) tuition needs ₸1,478,834 and rent ₸283,380, so rent is refused; an offline
  demo needs ≥ ₸862,214 extra. The Build Plan's "convert ₸400,000" / "Parents send ₸400,000" lines predate this. The
  protected reserve is still checked on the total wallet in KZT, not per currency.

## 2026-10-11 — Demo determinism

Money-from-home trigger = ₸1,000,000 (covers tuition + rent under both live and offline example rates); sim uses offline example rates by default (--live-fx to opt in).

## 2026-10-12 — Triggers and small auto

Trigger/scheduler-originated drafts may be AUTO only inside a passkey-signed mandate (rule 7), never via the small-auto limit (rule 9) → ASK + TRIGGER_NEEDS_MANDATE. Strengthens I6.

## 2026-10-12 — Chinese-context demos (D-CN1..3): data, seed option, per-region AI notice

- **Problem:** the competition is in Shenzhen; the plan asks for three CN demos without new product features, and the
  hero seed must stay single-user for existing tests.
- **Per-region AI notice (PIPL).** `aiNotice(region)` adds a line for region CN: providers outside mainland China
  receive the reduced chat and documents, a cross-border transfer under PIPL Art. 38–39 needing separate consent, which
  the prototype does not yet ask for. With local models it says there is no cross-border transfer. Public
  `GET /privacy/ai-notice` uses the user's region, else `?region=`, else EU. `noticeVersion` unchanged.
- **Second persona behind a seed option.** `liWei` (home CNY, region EU, SMART) in `fixtures/seed-data.ts`, inserted by
  `seedDatabase(..., { personas: true })` (seed, sim, `POST /demo/reset`), not by unit tests. Claim:
  `POST /auth/register/options {demoClaim: "li-wei"}` (DEMO_ENABLED; reclaim → `DEMO_ALREADY_CLAIMED`). His university
  row shares Dana's university IBAN, so two users hold the same account hash.
- **CardKind:** no CNY member; Li Wei's CNY card is `MULTI`.
- **rails.json:** three EXAMPLE CNY routes (`cny-mock-bank` ¥30 + 50 bps, 1 day; `cny-home-bank` ¥150 + 150 bps,
  3 days; `cny-card` 150 bps, same day), used only by wallets holding CNY.
- **Dana's Shanghai payees:** "Dorm Office in Shanghai" and "Buy Everything Shop from China", VERIFIED MERCHANT payees
  (MERCHANT_ID, no IBAN), plus a ¥1,800 monthly dorm fee due 2026-11-15 (outside the "+3 days" window).
- **Trigger `cn-spending-day`** ingests Alipay- and WeChat Pay-style samples and `kz-bank-ru-cny-purchase.txt`. Capture only logs (I6).
- **Bug fixed:** the `settlement` trigger settled the card-less Alipay charge "on the card"; it now settles only
  home-currency card charges (`apps/api/test/demos/cn2-wallet-capture.test.ts`).
- **No DCC in D-CN2:** the CN samples are CNY-denominated, so the fee x-ray shows a hidden card markup (4 %); `dccWarnings` stays empty.
- **Mock QR wallet:** codes for a known QR merchant carry its city and country (Shanghai, CN).

## 2026-10-12 — Final fix pass, Track X (money path and security; sim reports p1/p2/p3/cn/security)

- **X1 mandate scope (cn B5a).** AUTO under a mandate needs a draft linked server-side to an obligation: payee in
  `payeeIds`, the OBLIGATION's category in `categories`, same currency, current period, amount ≤ the bill, period not
  settled. Otherwise ASK `MANDATE_SCOPE_MISMATCH`; in-scope over a cap → ASK `MANDATE_OUT_OF_SCOPE`. Both block
  small-auto too. The link is signed into the order (`obligationId`, `obligationPeriod`; PSD2 RTS Art. 5) and
  re-checked by payments (I2).
- **X2 payments cap (F3, p3 O1).** Payments converts each live payment of the UTC day itself (`registerHomeConverter`,
  wired in `orders/wiring.ts`) and no longer trusts `homeAmountMinor`; conversion failure → refused. Rules pre-check
  `PAYMENTS_DAILY_CAP_HOME_MINOR`: REFUSE `REFUSE_CAP` + `PAYMENTS_DAILY_CAP` before the passkey. The env cap is still
  read in each user's home currency (noted, not changed; superseded below).
- **X3 payee verification + small-auto budget (F1, F2).** `verify-callback` needs a 428 passkey round trip over
  `{v, kind:"PAYEE_VERIFY", userId, payeeId, payeeName, accountHash, nonce}` (NIST SP 800-63B AAL2). Small-auto gets a
  per-UTC-day budget: `SMALL_AUTO_DAILY_MAX_COUNT` (default 3) and `SMALL_AUTO_DAILY_AMOUNT_MULTIPLE` (default 3) × the
  signed limit; beyond it ASK `SMALL_AUTO_BUDGET_EXHAUSTED`, also enforced in payments.
- **X4 screening (F6, p3 B1).** At decide (step 4), at payment (step 7) and at payee creation: a hit is refused 422
  `REFUSE_SANCTIONS`, not stored, ledgered `PAYEE_SCREENING_HIT` (name sealed).
- **X5 refresh after erasure (p3 B2).** `/auth/refresh` applies login's checks; erased → 401 `ACCOUNT_ERASED`, anchored
  on `users.erased_at`. Restricted (Art. 18) users can still refresh.
- **X6 ledger head anchor (F5).** Table `ledger_head`, rewritten per append with an Ed25519 signature over JCS
  `{domain:"kassa:ledger-head:v1", seq, headHash, ts, keyId}`. `ledger:verify` requires it: tail truncation and
  re-hashing are detected. Honest limit: a DB writer holding an older signed head can roll back to it (needs an
  external anchor, RFC 3161; out of scope). Migration 0004 (journal `when` after 0005).
- **X7 handoff QR before signing (cn note 1).** The QR is fetched and checked (name ≥ 0.92, amount, currency) before
  signing through a port (`registerHandoffPreflight`, I1), stored as `handoffQr`; mismatch → `QR_PAYEE_MISMATCH`, ledger
  `HANDOFF_MISMATCH`. Mock world unreachable → 502 `RAIL_ERROR`.
- **X8 expired approve (p2 B3).** Approve on an expired order re-issues it and answers 410 `ORDER_EXPIRED` with the new
  `OrderView`; GET returns `reissuedFromOrderHash`.
- **X9 payment notices (p1 B3, B5).** `PAYMENT_SENT` / `PAYMENT_FAILED` once per outcome for all rails
  (`payments/status.ts`), `{key:"payment.sent"|"payment.failed", params}` + English text.
- **X10 tests.** Shortcut wrong/revoked/session token → 401; injected text in a capture → logged only; small-auto
  without (or with tampered) base-rules signature → `NO_APPROVAL` / `BAD_SIGNATURE`; revoked rent mandate → no AUTO.

## 2026-10-12 — Final fix pass, Track Y (agent, data, UX, sim)

- **Y1 Redactor vs identifiers (p3 B3).** A card number must be a whole token, 13–19 digits, Luhn (ISO/IEC 7812-1); no
  hit may overlap an RFC 9562 UUID. Tested with 5,000 random UUIDs (`test/intel/redact-ids.test.ts`).
- **Y1 Same-name payees (p3 B4).** Tool outputs redact against their payee (`RedactContext {payeeId}`); free text picks
  the VERIFIED payee.
- **Y2 Seed consent and ledger (p2 B1, B2).** `seedDatabase` grants no AI consent unless `{ aiConsent: true }` (tests).
  The sim no longer consents automatically on 403. `DEMO_SEEDED` is one entry per seeded user, so a DSAR export never
  names another persona.
- **Y3 PIPL separate consent (cn note 2).** `users.pipl_consent_at` (migration 0005). Region CN with a planner or Reader
  outside Kassa's server (`crossBorderConsentRequired`) needs separate cross-border consent (PIPL Art. 38–39; Art. 15
  withdrawal): 403 `PIPL_CONSENT_REQUIRED`. `POST /privacy/pipl-consent {consent}` (audited
  `PIPL_CONSENT_GIVEN/WITHDRAWN`). One gate (`assertAiProcessingAllowed`, `aiProcessingAllowedFor`), now also covering
  capture's Reader fallbacks. The app shows the notice with an explicit "I agree".
- **Y4 Forecast top-up (p1 B2, cn D-CN3).** Suggest the first shortfall (reserve − balance, by that date); small
  top-ups may use a card route.
- **Y4 Same-currency routes (p1 B10).** `getRoutes` marks them `noConversion` and returns the direct route with
  `balanceCovers: false` when short.
- **Y5 log_expense (p1 B6).** The dictionary gained per-category `keywords` ("coffee"), matched after MCC and merchants.
- **Y5 search_catalog placeholders (p1 B8).** `merchant` may be a payee placeholder (`catalogDirectory` port).
  Unknown → `UNKNOWN_PAYEE_REF`; no catalog → `CATALOG_NOT_FOUND`.
- **Y6 User-facing text.** Merchant display = dictionary name, else payee name, else title-cased raw; never
  `merchantNorm`. Foreign spend shows the home equivalent. `propose_order` re-hydrates placeholders before rules, so the
  signed order names real payees. Shared additions: `REASON_TEXT_EN` / `reasonTextEn` / `reasonsSentenceEn`,
  `presetDerivedChanges`, `FUNDING_FX_TOLERANCE_BPS` (pinned to rules' `FX_TOLERANCE_BPS`), `fundingMarginNoteEn`. The
  app renders `{key, params}` notifications through i18n.
- **Y7 Sim.** `recategorise`; `demo clock|tick|trigger` wait for mock-world's clock and webhook outbox (p1 B11);
  `approve` stops on `ORDER_REISSUED` or 410 `ORDER_EXPIRED`; `verify-payee --sign`.
- **Y7 Orphan daemons.** `sim down` signals the daemon's process group, escalating to SIGKILL; `SIM_OWNER_PID` stops the
  daemon when its owner dies (`test/sim/sim-down.test.ts`).
- **Y7 Mobile jest "worker failed to exit gracefully".** Jest teardown resolved expo's lazy `fetch` global after the
  tests; `jest.setup.ts` resolves `globalThis.fetch` during setup (2/2 warnings without, 0/2 with; no `forceExit`).

## 2026-10-12 — Payments daily cap is defined in PAYMENTS_DAILY_CAP_CURRENCY (default KZT) and converted (rounded down, fail-closed) to each user's home currency.

- `PAYMENTS_DAILY_CAP_HOME_MINOR` is a fixed amount in `PAYMENTS_DAILY_CAP_CURRENCY` (default `KZT`, ₸2,000,000), not
  in each home currency (it meant ¥2,000,000, about ₸280M, for a CNY user). Converted via `money/fx` `toHome`, rounded
  down; about ¥27,106 at the offline example rates.
- Payments converts through `registerHomeConverter`; rules through money/fx. Conversion failure is fail closed
  (payments refuses `PAYMENTS_DAILY_CAP`; rules treat the cap as 0: `REFUSE_CAP` + `PAYMENTS_DAILY_CAP`).
- Test: `test/core/payments-cap-currency.test.ts`. Supersedes the X2 note.
- Also (Y6 follow-up): `summarize()` uses `reasonsSentenceEn(codes)`; PATCH /settings returns `derivedChanges` and
  notifies `SETTINGS_DERIVED_CHANGE`.

## 2026-10-12 — Ledgers created before migration 0004 (signed head)
`ledger:verify` reports "head anchor missing" for a ledger written before the signed head existed (correct: it can't prove the tail wasn't truncated). Dev/demo databases are re-created (`db:migrate` + `seed`); there is no production data. A production upgrade would need a one-time, audited anchoring of the existing head.

## 2026-10-12 — Licensing: Kassa code under MIT (root LICENSE). ReadyNative-derived files in apps/mobile stay under the ReadyNative Commercial License; the licensor (a Kassa author) permits their publication in this repository for the FinTechathon entry.

## 2026-10-11 — Structured output capability strategy and model retries (ai/structured.ts, ai/retry.ts)
Some OpenAI-compatible models (e.g. `inclusionai/ling-3.1-flash` on OpenRouter) reject `response_format`, which broke onboarding and the Reader. Structured calls now try native structured output, then ONE forced call of a schema-carrier tool `submit_result` (no `execute`, so the Reader still has no real tools, I10), then JSON-only text; the working mode is cached per model. Every mode validates with the same zod schema; an invalid answer is retried once, then `AI_STRUCTURED_OUTPUT_INVALID`. The AI SDK's own retry is off (`maxRetries: 0`); a middleware retries `AI_MAX_RETRIES` (default 5) times on 408/409/429/5xx/network, honouring Retry-After ≤ 60 s (RFC 9110 §10.2.3), else exponential backoff with equal jitter (1 s base, 20 s cap). Provider failures become `AI_PROVIDER_UNAVAILABLE` (onboarding: 503).

## 2026-10-11 — Mobile web/native smoke fixes: web storage, CORS header, native passkey errors, demo entry
- **Web storage = localStorage (`apps/mobile/src/lib/storage.web.ts`)**, prefix `kassa:kv:`: `expo-sqlite/kv-store` on web failed under Metro ("Worker chunk not found") and needs COOP/COEP. Native keeps kv-store.
- **No `x-kassa-client` header:** the API never read it, and allowing it widens CORS (ASVS V14.5.3). A preflight test pins allowed headers (`test/security/http-hardening.test.ts`).
- **Native passkeys need a real domain:** iOS fails with ASAuthorizationError 1004 for localhost. The app raises `PasskeyDomainError` (pre-check rejects localhost/IP/single-label RP IDs) and `PasskeyBiometricsError`; config adds `webcredentials:` when `links.domain` is set. See `apps/mobile/README.md` "Passkeys on native".
- **Demo entry:** `GET /api/auth/demo` → `{ enabled }`; "Try the demo (simulated)" is normal passkey registration with `demoClaim`.
- **Onboarding AI consent:** the onboarding chat shows the notice + "I agree" card (GDPR Art. 7); new users were stuck at 403 AI_CONSENT_REQUIRED.
- **Web dark mode:** web applies the resolved scheme (NativeWind's `"system"` left light text on dark backgrounds).

## 2026-10-13 — Onboarding bills become obligations with placeholder payees (no account yet); rent mandate offered after the rules

- **Problem:** after onboarding Home showed no bills, and the rent-mandate step never appeared: `applyOnboardingDraft`
  skipped obligations because a payee needs account details (I7).
- **Choice:** each dated bill becomes an obligation linked to a payee re-used by name + kind, else a **placeholder
  payee**: `COOLING`, `coolingUntil` NULL, no account (migration `0006_payee_account_pending`), country `ZZ` (ISO 3166-1
  user-assigned), ledgered `PAYEE_CREATED` with `accountMissing: true`. Sanctions-screened (I9). Undated bills skipped.
- **Never payable without an account:** rules step 2 refuses `REFUSE_UNVERIFIED_PAYEE` + `PAYEE_ACCOUNT_MISSING`; no
  canonical order without an account hash; approve and payments refuse; verify callback → 409 `PAYEE_ACCOUNT_MISSING`.
  Tests: `apps/api/test/core/onboarding-obligations.test.ts`, `test/rules/decide.test.ts`.
- **Rent mandate:** `POST /onboarding/confirm` returns `suggestedMandate` + `suggestedMandatePayees` after applying the
  draft (COOLING landlord accepted). Review screen: rules → mandate (sign or skip) → home
  (`apps/mobile/src/screens/onboarding/__tests__/onboarding-review.test.tsx`).
- **App:** `ObligationDto.payeeAccountMissing`, `PayeeDto.accountMissing`; rows show "Add payee details".
- **Not done:** no "add account details" flow (an account change is a new payee, I7). Dana's seed is unchanged.

## 2026-10-13 — Demo Stage (mock-world /mock/stage) and three demo-admin stage routes

- **What:** phone-sized "outside world" screens for the pitch under `/mock/stage/*` (director, Tap to Pay, Super-App
  Wallet in Chinese, Mail, Bank App, Money from home, Supplier price list). Generic names, "Simulated" ribbon, no CDN
  (`apps/mock-world/src/stage/`, `src/routes/stage.ts`). 404 unless mock-world's `DEMO_ENABLED` (new keys `DEMO_ENABLED`,
  `DEMO_ADMIN_TOKEN`; default off).
- **Secrets stay server-side:** pages call `/mock/stage/api/<action>`; `StageApi` holds the admin and Shortcut tokens
  and never renders them (tested).
- **Three new API routes** (demo-admin token, DEMO_ENABLED, in `PUBLIC_ROUTES` + `auth` rate tier), because the scene
  actions had no route without a user session: `POST /api/demo/stage/shortcut-token` (ledgered `DEVICE_TOKEN_CREATED`,
  `via: "demo-stage"`), `POST /api/demo/stage/settlement` (`reconcileSettlement`), `POST /api/demo/stage/document`
  (`storeDocument` + `INBOX_NEW_EMAIL`). They only log or store (I6). The coffee tap uses the real
  `POST /api/capture/shortcut` (I13). Tests: `apps/api/test/demos/stage.test.ts`, `apps/mock-world/test/stage.test.ts`.
- **Forged bank message (S2):** a fake `outgoing_payment_sent` to `/api/webhooks/mock/bank`, unsigned and signed with a
  random key; both get 401.
- **Clock sync:** `DemoClock.invalidate` after a stage clock move (same race as Y7).

## 2026-10-12 — Apple Pay → Kassa: app UI for Shortcut tokens, device list/revoke, tolerant Shortcut parser, `nudge`

- **App:** **Settings → Apple Pay → Kassa** (`apps/mobile/src/screens/settings/shortcut-screen.tsx`, route `/shortcut`):
  create a token (shown once), endpoint URL, iOS 17 steps, device list and revoke. Guide: `docs/guide/shortcuts.md`.
- **Routes:** `GET /devices` (active `IOS_SHORTCUT` devices + `lastCaptureAt`); `DELETE /devices/:id` revokes
  (ledgered `DEVICE_TOKEN_REVOKED`; a tightening, instant, no passkey, I8; idempotent; foreign id → 404 `AUTHZ_DENIED`).
- **Deviation:** no device name or per-device last use (no migration while the schema was being edited); follow-up
  `devices.label` + `lastUsedAt`.
- **Parser (`capture/parsers/shortcut.ts`):** accepts glued markers ("HUF1,290.00", "Ft1,290", "CN¥38.00"), NBSP groups,
  JSON numbers; minus or parentheses → `REFUND`. Unsupported currency markers ("£4.50", "A$4.50", "JPY 500") →
  `UNPARSED`. `date` used only if ISO 8601 with a zone; empty `merchant` allowed.
- **`nudge` (`capture/nudge.ts`):** one English line for the Shortcut notification from existing results: amount (+
  home equivalent), merchant, budget left, the card's median markup, DCC. Read-only (I6).
- **Tests:** `apps/api/test/core/shortcut-devices.test.ts`, `apps/api/test/intel/parsers.test.ts`,
  `apps/mobile/src/api/__tests__/shortcut-endpoint.test.ts`.

## 2026-10-14 Kassa Business M0: data model, two pizzerias, phone tunnel

- **Tables (migration `0007_business`):** `users.account_type` (PERSONAL|BUSINESS), `merchants`, `inventory_items`,
  `recipes`, `supplier_items`, `stock_movements` (append-only; on-hand = Σ qty), `sales_daily`, `purchase_orders`,
  `shop_orders`. Journal `when` hand-set to 1791790000003 so drizzle applies it after 0006.
- **Shared:** `purchaseOrder.ts` (`PurchaseOrderCore`, `poHash` = JCS SHA-256, `itemsHash`). `CanonicalOrder.itemsHash`
  and `.purchaseOrderId` are optional (golden vectors unchanged). Reason codes `INVOICE_ABOVE_PO`,
  `INVOICE_ACCOUNT_MISMATCH`, `PO_NOT_DELIVERED`, `PO_ABOVE_FORECAST`.
- **Seed:** `pizzeria-bud` (HUF/EU, storeId `bud`), `pizzeria-sha` (CNY/CN, `sha`, HANDOFF), `li-wei-cn` (Shanghai
  customer). Suppliers A (VERIFIED) / B (COOLING, attacker) in Budapest; C (VERIFIED) / D (COOLING, attacker) in
  Shanghai. `seedForecastShortage`: Shanghai exactly 400 boxes short by end of tomorrow; Budapest none.
- **mock-world:** `/shop/:store/*` for `bud` and `sha` (`pizza` aliases `bud`). `KASSA_APP_URL` (default `http://localhost:8081`).
- **`pos-low-dough` trigger** sends `{sku: "DOUGH-BALL", level: 12, unit: "pcs", storeId: "bud"}` (the old body got a 400).
- **`bun run phone`** (`scripts/phone.ts`): proxy + named cloudflared tunnel when `CLOUDFLARED_TUNNEL` and `PHONE_HOST`
  are set, else a quick tunnel.

## 2026-10-15 Kassa Business M5: purchase order → supplier → invoice → payment

- **Agent business tools** (`get_inventory`, `forecast_stock`, `propose_purchase_order`; `BUSINESS_TOOL_INPUT_SCHEMAS`)
  only for BUSINESS accounts. `propose_purchase_order` **moves no money**: one DRAFT `purchase_orders` row (ledger
  `PO_DRAFTED`); `WRITE_TOOLS` stays `["propose_order"]`. Price = the supplier's **structured catalog** price. Refused
  above `merchants.poCapMinor` (`PO_ABOVE_CAP`), for a non-VERIFIED supplier, or with an open PO for the SKU; > 2× the
  forecast flags `PO_ABOVE_FORECAST`. Signing (`business/sign.ts`) is not reachable from agent/**.
- **Signing** (`POST /business/purchase-orders/:id/sign/options`, `.../sign`): core rebuilt from the DRAFT (else 409
  `PO_CHANGED`), assertion verified `live` via `verifyPaymentsAssertion`, ledger `PO_SIGNED`, PO sent HMAC-signed to the
  supplier → SENT (`.../send` retries).
- **Supplier portal** (mock-world `/mock/supplier/:id/portal`, DEMO_ENABLED): Confirm / Mark delivered / Issue invoice
  as signed webhooks; delivery appends RECEIPT movements. B and D have a "swapped bank details" button (attack A9).
- **Three-way match** (`business/invoices.ts`): supplier name, account hash = signed `supplierAccountHash` = payee's
  (VERIFIED), else `INVOICE_ACCOUNT_MISMATCH`; amount ≤ signed total, else `INVOICE_ABOVE_PO`. Refusals ledgered
  `INVOICE_REFUSED`. A match creates an obligation and `proposeOrder({obligationId, purchaseOrderId})`.
- **Rules:** a `purchaseOrderId` must be the user's signed PO for this payee, amount ≤ total; never AUTO (T2);
  `PO_NOT_DELIVERED` if undelivered. EU → BANK_TRANSFER, CN → HANDOFF.
- **Payments re-check:** recompute `poHash`, re-verify the stored assertion, payee + account = supplier, amount ≤ total,
  not PAID. PAYING → PAID on SENT (ledger `PO_PAID`), back to INVOICED on FAILED/CANCELED.

## 2026-10-13: Limits and budgets apply on the passkey, no 24 h wait

- **Raised caps** (`PATCH /settings`) still need a passkey over the change hash (428, I8) but apply at once (ledger
  `RULES_LOOSENED`). Autonomy loosenings (preset, payment policy, money mode, agent, region), unfreeze and mandates keep
  the 24 h delay.
- **Budgets** (`PUT /budgets`, `ask_budgets`): new or lowered limits apply at once without a passkey; raised limits need
  the passkey, then apply at once (kind `BUDGETS`). Denied to KassaLite sessions.
- The agent still cannot change either (I1).

## 2026-10-13: Backup codes, every ISO currency, manual cards, data import/export, onboarding pickers

- **Backup codes.** The spec had no recovery path. 10 one-time codes (Crockford base32, 50 bits, `XXXXX-XXXXX`), made
  behind a passkey (428), shown once; only HMAC-SHA256(code, SESSION_SECRET) stored (`recovery_codes`, migration 0009).
  A code registers a passkey that **replaces** all old ones, revokes sessions (`users.sessions_revoked_at`) and
  **freezes payments** (I8); paying again needs the 24 h unfreeze. Public, auth-rate-limited, refused to KassaLite.
- **Every ISO 4217 currency** via the `currency-codes` package. `SupportedCurrency` stays the five the wallet and rails
  hold; records, bills, budgets, cards and home currency accept any code.
- **Onboarding pickers:** every question gets buttons (up to two per turn), including answers listed in the question
  plus "Other…"; any currency can be searched. Onboarding always asks about cards (last 4 digits only).
- **Manual cards:** `POST /cards`, `DELETE /cards/:id`; labels only, no passkey.
- **Data import/export.** `GET /export` (`kassa-export` v1). `POST /import/preview` maps any JSON deterministically
  (synonyms, Levenshtein, locale amounts, `chrono-node` dates); no model sees the file. `POST /import/commit` only adds:
  spending via capture (I6, source `IMPORT`, migration 0010), bills via onboarding placeholders (I9), cards.

## 2026-10-14: Payment notifications with when, where, the likely place and budget context for every category; money-advice prompt

- **When and where.** Capture accepts optional `street`, `city`, `country`, `latitude`, `longitude` (`capture/place.ts`),
  stored in `transactions.place` (migration 0011), coordinates rounded to 3 decimals, removed after
  `RETENTION_DAYS_CAPTURED_TEXT`.
- **Likely place.** `cleanMerchant` strips known processors ("SQ *BLUE BOTTLE 0412") and store numbers. With AI consent
  and LIVE mode the reader model guesses the place; only medium/high confidence is shown (`place.source = "AI"`).
- **Budget context outside budgets.** EACH mode sends `budget.unbudgeted` (`SPEND_UNBUDGETED`): month so far, usual month
  (`budget/context.ts`), unbudgeted total, share of income (`monthlyIncomeOf`). THRESHOLDS mode stays quiet.
- **AI tip, grounded.** One call per tap (`advice/enrich.ts`, 4 s timeout, `AI_PAYMENT_NOTES=false` disables); a tip
  with any number not in the facts sent is dropped.
- **Money-advice prompt.** `advice/prompt.ts` `ADVICE_PROMPT` is shared by chat and tips: grounded numbers, everyday
  money only (no investment, credit, tax or legal advice). New read-only tool `get_spending_summary`.
- **Cards learned from taps.** An unmatched card hint adds a card (`capture/cards.ts`, `CARD_LEARNED`), no passkey (I8).
- **Response shape.** `POST /capture/shortcut` adds `nudgeTitle`, `nudgeBody`; `GET /capture/recent` adds `place`.
- **Tests:** `apps/api/test/core/payment-notes.test.ts`, `shortcut-devices.test.ts`,
  `apps/mobile/src/screens/activity/__tests__/notification-text.test.ts`, `screens/lite/__tests__/activity-screen.test.tsx`.

## 2026-10-15 — Real-world incident attacks A10–A17; payee account ciphertext bound to its row

- **Attacks.** `apps/api/test/attacks/A10..A17` recreate public incidents (Freysa, Grok + Bankrbot, AIXBT, ElizaOS fake
  memories, MCP tool poisoning / EchoLeak, Chevrolet "$1 Tahoe", salami splitting, APP "safe account" scams) with a
  planner and Reader that obey the injection, each with a naive row (`test/naive/`). Mappings:
  `docs/security/self-assessment.md` §6 "Real-world incidents recreated". Result: guarded 0 of 16 paid, naive 16 of 16.
- **Fix found by A12.** A row writer could copy a cooling payee's `accountEnc` + `accountHash` into a verified mandate
  payee. New ciphertexts are `v2` with AAD `kassa:payee:v2:<userId>:<payeeId>` (`payees/crypto.ts`); payments requires
  `accountHash(account) = order.payeeAccountHash`, else `REFUSE_UNVERIFIED_PAYEE`. Residual: v1 rows are not bound
  (security/self-assessment.md R30).

## 2026-10-16 — Real time by default, demo time as a switch; sessions on wall time

- **Problem:** spec §15 runs everything on the demo clock, so a deployment with demo data showed 2026-10-27 to everyone.
- **Choice:** `demo_state.clock_mode` (migration 0018): `REAL` (default) or `DEMO` (adds the stored offset, kept while
  `REAL`). Deployments seed `REAL`; seed and tests use `DEMO`. Settings → Demo has a **Demo time** switch
  (`POST /demo/clock/mode`, ledger `DEMO_CLOCK_MODE`).
- **Exception:** session and refresh token lifetimes use wall time (`clock.realNowMs()`).

## 2026-10-16 — A demo switch for the 24 h waits

- **Problem:** I7 cooling and the 24 h loosening delay make a live demo wait a day.
- **Choice:** `POST /demo/cooling` (DEMO_ENABLED only), per user, in `demo_cooling_off` (migration 0019). Off needs the
  passkey (`DEMO_COOLING_OFF`); on needs nothing (`DEMO_COOLING_ON`). Default on. Off: new recipients still start COOLING
  (T2 only) but can be verified and paid at once; loosenings apply at the next tick. A red banner shows while off
  (`MeResponse.demo.coolingOff`). The attack suite keeps the waits on; no agent tool reaches the switch. Risk:
  security/self-assessment.md R36.

## 2026-10-16 — App in English, Simplified Chinese, Russian and Kazakh (replaces "i18n via i18next, English only")

- **Problem:** English only; the jury is in Shenzhen and the target users read Russian or Kazakh more easily.
- **Choice:** `zh`, `ru`, `kk` (Cyrillic) next to `en` in `apps/mobile/src/locales/`, same 23 namespaces. Plurals per
  `Intl.PluralRules`. Language from the device list, else English; Settings → Appearance → **Language**
  (`readynative:language`). Server prose stays English; `apps/api` unchanged.
- **Tests:** `apps/mobile/src/locales/__tests__/locales.test.ts` (same keys, plurals, placeholders),
  `src/lib/__tests__/i18n.test.tsx`.
- **Review needed:** Kazakh has not been read by a native speaker; Russian and Chinese need a native read too.

## 2026-10-16 — Revocations and rate limits in Postgres; logout revokes the cookie; a KEK rotation script

- **R13, shared stores.** The refresh-token spent list and rate-limit counters were in memory (lost on restart, per
  instance). Now tables (migration 0020): `revoked_tokens` (atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING`) and
  `rate_limit_counters` (one upsert per request); purged on wall time. A DB failure counts the hit in memory.
- **R14, logout revokes the cookie.** `POST /auth/logout` records the cookie's jti (kind `session`) and
  `authenticateSession` refuses revoked or jti-less cookies. Native access tokens (15 minutes) are not revoked; their
  refresh token is.
- **R15, KEK rotation.** `KeyProvider` (`privacy/keys.ts`); `bun run kek:rotate [--dry-run]` (`scripts/rotate-kek.ts`)
  re-wraps `user_keys` from `USER_KEK_PREVIOUS` to `USER_KEK` in one locked transaction. No cloud KMS SDK
  (security/self-assessment.md §5.5). Not done: rotating other keys; the PAN reference key still derives from `USER_KEK`.

## 2026-10-16 — A simulated identity check (KYC) gates payments and top-ups above EUR 1,000

- **Problem.** KYC was "on paper only"; nothing knew whether a user was identified.
- **Choice.** A deterministic checker in mock-world (`/mock/kyc/checks`: fictitious document + simulated liveness →
  VERIFIED / REVIEW / REJECTED) and API module `kyc` (`POST /kyc/start`, `GET /kyc`, migration 0021). Stored: outcome,
  reasons, document type/country, timestamps, last 4 characters sealed; never full number, name, birth date or image.
  Ledger `KYC_VERIFIED`, `KYC_REVIEW`, `KYC_REJECTED`.
- **Threshold: EUR 1,000.00 per payment, and per day for top-ups** (`KYC_THRESHOLD_MINOR` = 100000,
  `KYC_THRESHOLD_CURRENCY` = EUR, converted and rounded down; unconvertible = 0). Matches AMLD Art. 11(b)(ii) / TFR;
  puts tuition (about EUR 2,400) behind it. A sandbox gate, not a CDD policy.
- **Enforcement.** Rules step 6b `KYC_REQUIRED` (in `HARD_REFUSE_CODES`) before mandates and small-auto; payments step
  8a re-check; top-ups above it refused 422 (`WALLET_TOPUP_REFUSED`). Handoff is not gated (no money moves through Kassa).
- **No passkey to start a check** (loosens no signed rule); sensitive rate-limit bucket.
- **Seeded personas and fixtures start VERIFIED** (`provider` `seed` / `fixture`); `createUserWithPasskey({ kyc: "NONE" })`
  gives an unchecked user; app sign-ups start unchecked.
- **Erasure** keeps checks (AMLD Art. 40, `RETAINED`); the last 4 become unreadable.
- **Not done:** no document authenticity, real liveness, PEP screening or ongoing due diligence; REVIEW never resolves
  (security/self-assessment.md R37). Jurisdictions: security/compliance.md §12.

## 2026-10-18 — Convert between own balances (CONVERT orders); caps at approval; funding fails closed

- **Problem:** a blind judge found (1) no way to pay EUR tuition from KZT/USD/HUF; (2) chat naming a different funding
  balance than the signed one; (3) caps checked only at proposal time; (4) GET /obligations COVERED vs a forecast
  shortfall for the same bill; (5) unreadable balances binding a guessed route.
- **Choice:** (1) a `CONVERT` canonical order (rail `CONVERT`, payee = own wallet, `ownWalletAccountHash(userId)`):
  always ASK, outside caps/mandates/small-auto/screening; executed via Wise's balance conversion
  (`POST /v2/profiles/:p/balance-movements`), ledger `WALLET_CONVERTED`. Bills report `CONVERTIBLE` or `SHORTFALL`
  (`reserveBreached`). Multi-source funding in one payment was rejected (partial-failure states). (2) Every proposal
  carries `orderLine`, built from the signed order. (3) Rules re-check caps at approval under the payments advisory
  lock; payments checks the mandate period maximum inside its transaction. (4) Both views use the rail rules will
  choose. (5) Unknown balances: read again once, then REFUSE `BALANCES_UNAVAILABLE`; a shortfall at execution is
  `INSUFFICIENT_FUNDS`.

## 2026-10-19 — Attack evidence reports REFUSED / ASKED / PAID, and a tap-to-confirm baseline

- **Problem:** blind judges found the attack evidence overclaimed. `attacks.json` marked every case `BLOCKED` when no
  money moved, including ASK decisions with PAYEE_COOLING (A2, A10, A16, A17) that a fooled user can approve. The naive
  baseline's 16 of 16 is true by construction.
- **Choice:** the evidence writer (`apps/api/test/helpers/attacks.ts`, `classifyGuarded`) derives each outcome from the
  decision and ledger: REFUSED, ASKED (states who is paid if approved) or PAID. PAYEE_COOLING is IN_COOLING or
  COOLED_UNVERIFIED. A5's handoff variant is counted PAID. A second baseline, chatbot + tap-to-confirm
  (`apps/api/test/naive/tap-confirm.ts`), runs the same intents with a fooled and a careful user. Result
  (2026-10-19): Kassa 7 refused, 8 asked, 1 paid; with a user who approves every prompt the attacker's account is paid
  in 5 of 16; the tap chatbot pays it in 11 of 16 (16 of 16 unwanted payments); the naive agent 16 of 16 by
  construction. The 2026-10-15 entry's "guarded 0 of 16 paid" is superseded.
