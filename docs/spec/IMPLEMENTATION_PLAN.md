# Kassa — implementation plan

## Context
Build the FinTechathon 2026 Topic C entry described in `~/Downloads/TECH_SPEC.md` (source of truth for *how*) and `~/Downloads/Kassa — Build Plan.md` (*what/why*): a student finance agent that drafts payments while deterministic rules decide and only passkey‑signed approvals move money. Full spec scope, greenfield repo at `~/Documents/git/kassa`.

User deviations from the spec (record each in `docs/DECISIONS.md`, dated 2026‑10‑10):
1. **Expo app from ReadyNative Pro** (`github.com/ReadyNative/ready-native-pro`, private, SDK 57, bun, Expo Router, `@/ui` kit, `@/lib/*` shims). Native-first: native tabs, `@expo/ui` controls, form sheets, SF Symbols, haptics, native passkeys. Web still builds (spec demo target) via `.web.tsx` fallbacks where `@expo/ui` has no web.
2. **i18n via i18next**, English only for now; every user-facing string goes through `t()`, including server reason-code labels (mapped client-side from codes).
3. **LLM is provider-agnostic**: Vercel AI SDK (`ai`) + provider registry instead of the Anthropic SDK. Model chosen by env string `provider:model` — `anthropic`, `openai`, `google`, `ollama`/any OpenAI-compatible local endpoint (`LOCAL_BASE_URL`). Defaults: `PLANNER_MODEL=anthropic:claude-sonnet-5-5`, `READER_MODEL=anthropic:claude-haiku-5-5`.
4. **bun workspaces + Turborepo** instead of pnpm (boilerplate is bun; same layout). `pnpm ledger:verify` etc. become `bun run ledger:verify`.

Build subagents: only `model-routing:dev` (Opus 5.5 medium) for code and `model-routing:scout` (Haiku 5.5 medium) for lookups. No other tiers.

## Repo layout (spec §4, unchanged except tooling)
```
kassa/  package.json (bun workspaces) turbo.json docker-compose.yml Caddyfile .env.example
  apps/mobile      ReadyNative app (after setup)
  apps/api         Fastify + fastify-type-provider-zod, Drizzle/Postgres
  apps/mock-world  Fastify mocks (bank, shops, suppliers, invoices, inbox, QR, POS, remittance)
  packages/shared  zod schemas, CanonicalOrder, JCS hash, enums, money utils, tool schemas, reason codes
  fixtures/  docs/  .github/workflows/ci.yml
```

## Phase 0 — scaffold (one dev agent, sequential, ~first)
- `gh repo clone ReadyNative/ready-native-pro apps/mobile`, drop its `.git`, then
  `bun run setup --preset default --auth none --backend none --data react-query --state zustand --i18n i18next --ui nativewind4 --forms react-hook-form --storage kv-store --push expo-notifications --payments none --analytics none --crash none --consent none --location none --onboarding off --widgets none --testing jest --yes`
  (auth/payments are ours: passkeys + Stripe; verify flag names with `--dry-run` first).
- Root bun workspace + Turborepo (`dev`, `build`, `typecheck`, `lint`, `test`), shared `tsconfig.base.json` (strict), root ESLint with the §4 `no-restricted-imports` rules for `apps/api/src/modules/agent/**` and `payments/**`.
- `packages/shared`: `CanonicalOrder` (spec §7 verbatim), `orderHash()` using `canonicalize` + SHA‑256 base64url, money utils (`formatMoney`, currency exponents), enums, `ReasonCode` list, tool input schemas, Mandate core schema, API DTOs. Golden-vector tests.
- `docker-compose.yml` (postgres16, api, mock-world, caddy serving `apps/mobile` web export at `/`, `/api`, `/mock`), `.env.example` (spec §20 + `LOCAL_BASE_URL`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`), `scripts/keys-generate.ts`.

## Phase 1 — parallel tracks (4 dev agents at once, disjoint directories)

**A. Core money path** — `apps/api/src/{db,modules/{clock,ledger,rules,payments,rails,payees,mandates,screening,users,auth,notifications,demo}}`
- Drizzle schema = spec §6 verbatim; drizzle-kit migrations; `pg` in prod, **PGlite** in tests (no Docker in CI).
- Clock (`now = real + demo_state.clockOffsetMs`), 15 s scheduler (§15 jobs).
- Ledger: hash chain + Ed25519 checkpoints every 20; `scripts/ledger-verify.ts`.
- Rules: §10 evaluation order, `riskWeights.ts`, presets + zod refinement, canonical order build, WebAuthn verify (`@simplewebauthn/server`, counter 0 accepted), Ed25519 approval signing. `rules/publicKey.ts` is the only export payments may import.
- Payments: §7 independent verification (sig/expiry, recomputed hash, own credential table, mandate scope + mandate assertion, `used_nonces` PK insert, own daily cap, screening), rail dispatch.
- Rails: `fakeIssuing` + `stripeIssuing` (selected by `ISSUING_PROVIDER`), auth webhook (no LLM, <1 s), expiry job; `mockBank` (Wise-shaped client to mock-world); `handoff` (fuzzy name ≥0.92 → `QR_PAYEE_MISMATCH`); `payInPlace` (PaymentIntent → one-time card).
- Payees (AES-GCM account, cooling 24 h, change ⇒ new payee), mandates, `rule_changes` (loosen +24 h with passkey, tighten instant), freeze, screening (`fastest-levenshtein` Jaro-Winkler + `transliteration`).
- Auth: passkey register/login writing both credential tables; httpOnly cookie (web) / bearer JWT 15 min + refresh (native). Webhook auth (Stripe sig, mock HMAC 5‑min window, shortcut device token).
- Routes for every §8 endpoint in A's modules.

**B. Intelligence** — `apps/api/src/modules/{ai,agent,reader,fx,capture,budget}`
- `ai/registry.ts`: `createProviderRegistry({ anthropic, openai, google, local: createOpenAICompatible({baseURL: LOCAL_BASE_URL}) })`; `getModel(env.PLANNER_MODEL)`. Verify current AI SDK APIs from docs before coding (`streamText`, tools, `stopWhen: stepCountIs(8)`, structured output).
- Agent: system prompt (§9), 11 tools (only write tool `propose_order`, which calls `rules.decide` via an interface — no payments import), redaction + `placeholder_maps`, streaming to app (AI SDK UI message stream over Fastify), replay: `RECORD=1` saves model responses to `fixtures/agent-recordings/<scenario>.json`; `AGENT_MODE=REPLAY` serves them through the AI SDK mock language model so replay is provider-independent.
- Reader: no tools, structured output per doc type, evidence-substring + number re-checks → `UNVERIFIED` / `READER_SOURCE_MISMATCH`; `pdf-parse`; images as vision input (providers without vision → error code, documented).
- FX: Frankfurter + NBK rates (verify endpoints; labelled fallback), daily cache; route optimizer; coverage forecast; fee x-ray + DCC flag.
- Capture: regex parsers (KZ bank, Alipay, WeChat Pay, Revolut/Wise, Shortcut JSON) → Reader fallback, merchant normalize, dedupe (10‑min buckets ± neighbour), categorize (MCC → `fixtures/merchants.json` → Reader; user correction memory), settlement reconcile. Budget pace + notification modes.
- Onboarding chat endpoint (profile draft via structured output).

**C. Mobile app** — `apps/mobile` (load `building-native-ui` + `mobile-app-design` skills; read Expo SDK 57 docs, not memory)
- Routes per spec §16 under `src/app`, bodies in `src/screens`, UI from `@/ui`, data via TanStack Query hooks in `src/api/` (typed from `packages/shared`), zustand for UI state.
- Native: `NativeTabs` (Home, Chat, Activity, Cards, Settings), confirmation sheet as form-sheet modal rendering **only** `canonicalOrder` + server budget impact, `@expo/ui` pickers/switches/sliders in Settings, SF Symbols, haptics on approve/reject, `react-native-passkeys` (web fallback `@simplewebauthn/browser`), `expo-notifications`, Stripe PaymentSheet (native) / Payment Element (`.web.tsx`).
- i18n: `src/locales/en/*.json` namespaces (common, home, chat, order, activity, cards, settings, payees, errors/reasonCodes, demo); no hardcoded strings (lint check via `i18next` key extraction script or test that scans screens for raw `<Text>` literals).
- Screens: auth (welcome/register/login), onboarding chat + review (passkey-signed base rules + rent mandate), home, chat (streamed + proposal/route/budget cards), order sheet, activity (ledger timeline, reason codes in plain language), cards/fee x-ray, settings (presets, advanced, caps, mandates, pending loosenings with countdown), payees (status chips w/ countdown), bills, credit-record, verify/[id] (public), handoff/[paymentId], demo panel (clock, scenarios, agent mode, reset, notification simulator). "Replay" and "Simulated" badges. Dark mode, ≥44 pt targets, status = label + colour.

**D. Mock world + fixtures** — `apps/mock-world`, `fixtures/`
- All §17 services, "Simulated" banner on HTML pages, HMAC-signed outgoing webhooks, mock bank status machine on demo clock (reads clock offset from API), Stripe test helper / FakeIssuing checkout.
- Fixtures: seed (§18 Dana), `rails.json`, `merchants.json`, notification samples, sanctions sample (+ Cyrillic/translit test name, licence note), supplier B price list with A1 hidden instruction, A2 inbox email, swapped tuition invoice, 30 labelled invoices (generated PDFs + `labels.json`).

## Phase 2 — integration & proof (dev agents, after Phase 1)
- Wire app ↔ API end to end; tuition scenario live first, then rent autopay (+3 days clock), pizza one-time card (+ second charge declined), handoff.
- Tests (Vitest, PGlite): every §10 rule, risk, golden hashes, WebAuthn (mocked), ledger, optimizer, forecast, fees, dedupe, parsers, screening; invariants I1–I13 (I1 = import-graph test); `test/attacks/A1..A8`; `test/naive/` baseline.
- Scripts: `scenarios`, `eval:invoices`, `results:table`, `demo:evidence`, `ledger:verify`, `keys:generate`.
- CI (GitHub Actions): lint, typecheck, unit, invariants, attacks in REPLAY mode, no keys. Mobile: `tsc`, `expo lint`, jest.
- Docs: README (docker compose up, reviewer login), `docs/SECURITY.md`, `docs/TESTS.md`, `docs/DECISIONS.md`, algorithms section; mobile `bun run gen:graph`.

## Risks to flag
- **ReadyNative licence** forbids publishing the kit's source; the competition requires a public GitHub repo. Check with the vendor or keep the repo private and share access with judges.
- Native passkeys need associated domains + dev build (not Expo Go); web passkeys need HTTPS domain (spec §23 open item). Dev uses localhost RP ID on web.
- Stripe Issuing test access unknown → start with `ISSUING_PROVIDER=fake`.
- Local models may not support tool calling/vision well; replay mode covers the demo.

## Verification
- `bun install && docker compose up -d postgres && bun run db:migrate && bun run seed`
- `bun run typecheck && bun run lint && bun run test` (all workspaces via turbo) — attacks A1–A8 green, naive baseline shows paid attacks.
- `bun run ledger:verify` exits 0; tamper a row → non-zero.
- `bun run dev` → API + mock-world + Expo; web: register passkey in browser pane on localhost, run tuition flow through approval and watch mock transfer states; iOS simulator dev build: native tabs, form sheet, passkey prompt, screenshots.
- Switch `PLANNER_MODEL` to `openai:…` / `local:…` and run one chat turn to prove provider swap; `AGENT_MODE=REPLAY` runs with no keys.
