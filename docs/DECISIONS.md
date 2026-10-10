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
