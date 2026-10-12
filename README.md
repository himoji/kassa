# Kassa

**The agent can prepare anything, but only your signature can move your money.**

Kassa is a student finance assistant for cross-border payments, built for the WeBank FinTechathon 2026, Topic C (Cross-border and Student Finance Assistant). It logs spending in every currency, exposes hidden card fees, plans bills against the forecast, and pays by the cheapest route. The AI agent only drafts. Deterministic rules decide what is allowed. Money moves only with a passkey signature over the exact order, or inside a mandate the user signed with a passkey earlier.

Hero user: Dana, a Kazakh master's student in Budapest. Her money arrives in KZT and USD, her bills are in HUF and EUR.

> **Scope.** Everything runs in sandbox and simulated mode. There is no real money, no real bank or Wise API, and no custody. In production the wallet would be held by a licensed bank or e-money institution. All companies in the demo are fictitious and carry generic names with no real brand logos.

## Documents

| Document | What it covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System parts, request flow, the three core algorithms, data model, AI layer |
| [docs/SECURITY.md](docs/SECURITY.md) | Security self-assessment: permission tiers, invariants I1 to I13, threat model, known risks |
| [docs/PRIVACY.md](docs/PRIVACY.md) | GDPR record of processing, data map, data subject rights, retention, DPIA summary |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md) | Requirement-by-requirement mapping with status (Implemented, Simulated, Planned) |
| [docs/TESTS.md](docs/TESTS.md) | Test catalogue: file-by-file counts from the final `bun run test` run, and attack evidence |
| [docs/evidence/sim/SUMMARY.md](docs/evidence/sim/SUMMARY.md) | Persona and attacker simulation reports (p1, p2, p3, cn, security) and the fix status of each finding |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Dated log of every deviation from the technical spec |
| [docs/SHORTCUT_SETUP.md](docs/SHORTCUT_SETUP.md) | Log real iPhone Apple Pay taps: iOS 17+ Shortcuts Transaction automation, device token, limits |
| [docs/spec/TECH_SPEC.md](docs/spec/TECH_SPEC.md) | Technical specification (source of truth for how) |
| [docs/evidence/sim/RUNBOOK.md](docs/evidence/sim/RUNBOOK.md) | Simulation runbook: personas, attackers, command reference |

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/api` | Fastify 5 API (TypeScript, Bun). Modules under `src/modules/`: `agent`, `reader`, `rules`, `payments`, `rails`, `capture`, `budget`, `fx`, `screening`, `ledger`, `privacy`, `payees`, `mandates`, `users`, `auth`, `scheduler`, `demo`, `webhooks`. Drizzle schema in `src/db/`, migrations in `drizzle/`, tests in `test/` |
| `apps/mock-world` | Fastify mock services: a Wise-shaped mock bank, a pizza shop, two food suppliers, a university, a landlord, an insurer, an email inbox, a "QR Wallet (simulated)", a POS emitter, and a remittance sender |
| `apps/mobile` | Expo app (Expo Router, React Native Web, native passkeys). Source in `src/app/`. Generated from the ReadyNative Pro boilerplate, see Licences |
| `packages/shared` | `@kassa/shared`: zod schemas, `CanonicalOrder`, `orderHash` and `mandateHash` (RFC 8785 JCS), reason codes, money helpers (integer minor units), IBAN helpers, mock webhook HMAC |
| `fixtures` | Seed data for Dana, 30 labelled invoice PDFs, notification samples, a fictitious sanctions sample, FX example rates, recorded agent replays |
| `docs` | The documents above, the spec, decisions, and evidence |
| `scripts` | `env-setup.ts` (local `.env` files), `keys-generate.ts` (Ed25519 and AES keys) |
| `docker-compose.yml`, `Caddyfile`, `apps/*/Dockerfile` | Optional deployment path, see below |

## Run locally (without Docker)

This is the primary path. The database is file-backed PGlite in `.data/`, so no database server is needed.

### Prerequisites

| Tool | Version |
| --- | --- |
| Bun | 1.4.0 (`packageManager` in the root `package.json`). The root `bunfig.toml` sets the hoisted linker, which Expo needs |
| Node.js | 22.18 or later (`engines` of `apps/mobile`). Only needed for the mobile app |

### Start the API and the mock world

```bash
bun install
bun run env:setup      # writes gitignored .env files with generated dev keys; prints no secret values
bun run db:migrate     # creates the PGlite database in .data/kassa
bun run seed           # inserts the seed data for Dana
bun run dev            # API on http://localhost:4000, mock world on http://localhost:4001
```

Notes:

- Without a `.env`, the API still starts. It generates development secrets once into `.data/dev-secrets.json`. Production refuses to start without real keys.
- `env:setup` writes `AGENT_MODE=REPLAY` and `ISSUING_PROVIDER=fake` into the generated `.env`. The code default for `AGENT_MODE` is `LIVE`, so use `env:setup` or set `AGENT_MODE=REPLAY` yourself.
- PGlite allows one process per data directory. Stop the API before `bun run seed`, or use `POST /api/demo/reset` while it runs with `DEMO_ENABLED=true`.
- The demo user Dana is created by `bun run seed`. To bind a passkey to her, set `DEMO_ENABLED=true` and register with `demoClaim` (`POST /api/auth/register/options`). The demo routes are not registered unless `DEMO_ENABLED=true`.
- Health check: `curl http://localhost:4000/api/health`.

### Mobile app (optional)

```bash
cd apps/mobile
bun run web            # Expo web on http://localhost:8081 (the default PUBLIC_ORIGIN and WebAuthn origin)
bun run dev            # Expo dev-client build for native devices
```

`env:setup` writes `apps/mobile/.env` with `EXPO_PUBLIC_API_URL=http://localhost:4000`, so the web app reaches the API from port 8081. Passkeys need a secure context, and `localhost` counts as one.

### AI configuration

| Mode | Setting | Needs |
| --- | --- | --- |
| Replay (default in `env:setup`) | `AGENT_MODE=REPLAY` | Nothing. Recorded tool calls from `fixtures/agent-recordings/` are served through the AI SDK mock model |
| Live | `AGENT_MODE=LIVE`, `PLANNER_MODEL`, `READER_MODEL` | One key for the chosen provider |

- Models are `provider:model` strings. Providers: `anthropic`, `openai`, `google`, `openrouter`, `local`. Bare ids are treated as Anthropic.
- Defaults: `PLANNER_MODEL=anthropic:claude-sonnet-5-5`, `READER_MODEL=anthropic:claude-haiku-5-5`.
- Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`.
- OpenRouter: `PLANNER_MODEL=openrouter:inclusionai/ling-3.1-flash` (any OpenRouter model id) with `OPENROUTER_API_KEY`; the base URL `https://openrouter.ai/api/v1` is built in.
- Structured output works with any model: native structured output first; if the provider rejects it, one forced call of a schema-carrier tool that never executes; if tools are rejected too, JSON text. Every answer is validated with the same schema (one retry on invalid output). The working mode is detected once per model; `AI_STRUCTURED_MODE=native|tool|json` sets the first mode to try.
- Rate limits: 429 and 5xx answers are retried `AI_MAX_RETRIES` times (default 5) with exponential backoff and jitter, honouring `Retry-After`.
- Local: `local` is any OpenAI-compatible endpoint at `LOCAL_BASE_URL` (default `http://localhost:11434/v1`, Ollama). `LOCAL_API_KEY` is optional. Set `LOCAL_VISION=true` if the local model accepts images.
- Chat, document upload and onboarding need the user's AI consent (`aiConsent` at registration, or `POST /api/privacy/ai-consent`). Seeded users, Dana included, have no consent until they give it. For region CN with a model outside Kassa's server, a separate cross-border consent is also needed (`POST /api/privacy/pipl-consent`, 403 `PIPL_CONSENT_REQUIRED` without it).
- The cap `PAYMENTS_DAILY_CAP_HOME_MINOR` is a fixed amount in `PAYMENTS_DAILY_CAP_CURRENCY` (default `KZT`). Each user gets it converted to their home currency, rounded down.

## Simulation

The simulation runs the real API and mock world, drives them through the same HTTP routes the app uses, and gives the planner only placeholders.

```bash
bun run sim up --fresh   # new sim database (.data/sim/pglite), seed, API :4000, mock world :4001, control :4099
bun run sim status
bun run sim down         # stops everything it started and reports the ports
```

Do not run `bun run dev` at the same time: both use ports 4000 and 4001. The runbook is in [docs/evidence/sim/RUNBOOK.md](docs/evidence/sim/RUNBOOK.md). It lists every command, the personas (average user, careful user, bad-actor user), and the security scenarios with the test files that cover them.

Persona and attacker runs (Haiku 5.5 acting as user and planner, no real AI calls) have their reports in `docs/evidence/sim/`: `p1/` (average user), `p2/` (careful user), `p3/` (bad actor), `cn/` (Chinese-context demos and a compromised planner), and `security/` (scenario review). [docs/evidence/sim/SUMMARY.md](docs/evidence/sim/SUMMARY.md) has the results and the fix status of every finding.

## Tests and checks

```bash
bun run typecheck      # tsc in every workspace
bun run lint           # ESLint: root config for api, mock-world and shared (includes the I1 and I2 import rules); mobile runs `expo lint`
bun run test           # Vitest suites (api, mock-world, shared) and the mobile Jest suite
bun run ledger:verify  # recomputes the hash chain and checkpoint signatures; exits 1 on any mismatch
```

- Counts from the final `bun run test`: API 633 tests in 72 files (unit, invariant, attack, security and integration), mock world 279, shared 34, mobile Jest 410. Each test file and what it asserts is listed in [docs/TESTS.md](docs/TESTS.md) and [docs/SECURITY.md](docs/SECURITY.md).
- `ledger:verify` writes its report to `docs/evidence/ledger-verify.json`.
- CI: `.github/workflows/ci.yml` runs on every push and pull request (typecheck, lint, tests in replay mode, migrate, seed, `ledger:verify`).

## Docker Compose (optional deployment path)

`docker-compose.yml` defines Postgres 16, the API, the mock world, and Caddy. Caddy serves the static web build at `/`, proxies `/api` to the API and `/mock` to the mock world, and provides HTTPS for WebAuthn. Build the web export first with `cd apps/mobile && bun run build`, then run `docker compose up`.

This path is not used for local development. The Dockerfiles exist, but this repository does not contain a verified Docker run as part of the submission evidence.

## Licences

| Item | Where | Note |
| --- | --- | --- |
| Kassa's own code | `LICENSE` (repository root) | MIT License, Copyright (c) 2026 Madiyar Baizhigitov and the Kassa team. `package.json` files of the root, `apps/api`, `apps/mock-world` and `packages/shared` carry `"license": "MIT"` |
| ReadyNative Pro (base of `apps/mobile`) | `apps/mobile/LICENSE`; notice at the end of `LICENSE` | Commercial ReadyNative licence, unchanged. The licensor (Madiyar Baizhigitov, trading as ReadyNative) is also an author of Kassa and permits publication of these files in this repository as part of the Kassa entry to the 2026 Shenzhen International FinTech Competition (FinTechathon). Further redistribution of the boilerplate outside this entry requires a ReadyNative licence. Recorded in [docs/DECISIONS.md](docs/DECISIONS.md) |
| Third-party notices | `apps/mobile/LICENSES/` | `expo-skills-MIT.txt`, `expo-template-MIT.txt`. Do not remove |
| npm dependencies | `package.json` files and `bun.lock` | Licences come from each package. Not audited in this pass |
| Mock companies | `apps/mock-world/src/world/` | Fictitious, generic names (for example "Pizza Shop in Budapest", "QR Wallet (simulated)"). No real brand logos |
| Sanctions sample | `fixtures/sanctions-sample.json` | Fictitious entries in the EU Financial Sanctions Files schema, with a licence note inside the file. The screening module can load the real FSF export, which has the same structure |
| Invoice PDFs | `fixtures/invoices/` | Generated by `apps/mock-world` with pdf-lib, using the standard 14 PDF fonts (no embedded fonts) |
| FX reference rates | `fixtures/fx-rates.json` | Example values, labelled `STATIC_EXAMPLE` in every quote. Live sources are ECB (via Frankfurter) and the National Bank of Kazakhstan |
