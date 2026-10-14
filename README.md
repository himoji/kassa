# Kassa

**An AI agent that pays your bills across borders, inside the limits you signed.**

Kassa is a finance agent for people whose money lives in one country and whose bills live in another, starting with international students. It was built for the 2026 Shenzhen International FinTech Competition (FinTechathon), International Track, Topic C (Cross-border and Student Finance Assistant), under the theme "AI as a Financial Participant".

The agent does real financial work: it logs spending in every currency, exposes hidden card fees, plans bills against the forecast and pays by the cheapest route. Inside a mandate the user signed with a passkey (rent and insurance to verified payees, small purchases under a signed limit), it pays on its own, with no prompt at payment time. Anything else it prepares as an exact order that the user approves with a passkey. Plain code, not the model, decides which case applies: the agent cannot raise a limit, skip the 24-hour cooling period for a new payee, or pay above a signed cap.

The safety line: **the agent can prepare anything, but only your signature, now or in a mandate signed earlier, can move your money.**

Hero user: Dana, a Kazakh master's student in Budapest. Her money arrives in KZT and USD, her bills are in HUF and EUR.

> **Scope.** Everything runs in sandbox and simulated mode. There is no real money, no real bank or Wise API, and no custody. In production the wallet would be held by a licensed bank or e-money institution. All companies in the demo are fictitious and carry generic names with no real brand logos.

## Quickstart

Needs Bun 1.4 and, for the app, Node.js 22.18 or later.

1. `bun install`
2. `bun run env:setup` (writes gitignored `.env` files with generated dev keys). For live AI, put `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` in the root `.env`; without one the chat uses recorded replays.
3. `bun run db:migrate && bun run seed` (file-backed PGlite in `.data/`, seeds Dana)
4. `bun run dev` (API on http://localhost:4000, mock world on http://localhost:4001)
5. In a second terminal: `cd apps/mobile && bun run web`, then open http://localhost:8081

Details, phone testing and deployment are below.

## What it does

- **An agent that acts within signed limits.** The planner reads balances, budgets, bills and documents and proposes orders. Rules decide: inside a passkey-signed mandate or small-auto limit the payment goes through on its own; otherwise the user approves the exact order with a passkey. The model itself has no payment tool ([SECURITY.md](docs/SECURITY.md)).
- **AI runs LIVE by default** (`AGENT_MODE=LIVE`). It needs `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` (or another provider, see "AI configuration"). Without a key, or if the model cannot be reached, the turn falls back to a recorded replay and the message is labelled **Replay** in the chat.
- **Spending in every currency.** Captures card taps, wallet notifications and Shortcut events, categorises them, and keeps budgets with a pace forecast.
- **Fee x-ray and cheapest route.** Shows hidden card FX fees and compares funding routes for each bill.
- **Bills and autopay.** Obligations (rent, tuition, insurance) are planned against the forecast; recurring ones can be paid inside a passkey-signed mandate.
- **Credit building.** The credit record (app: `apps/mobile/src/app/credit-record.tsx`; API: `apps/api/src/modules/credit-record/`) lets a student pick a period and what to include (income, bills paid on time, budgets, payments) and export a signed summary for a landlord or bank: Ed25519-signed, recorded in the ledger, with a public verify link and a PDF. Only the selected items are shared.
- **Add money.** A stand-in for the phone's wallet sheet (Apple Pay, Google Pay, Samsung Pay or a test card). The tap is simulated, or a Stripe test-mode charge with `sk_test_` keys. Test money only ([docs/SANDBOX_PAYMENTS.md](docs/SANDBOX_PAYMENTS.md)).
- **Send to another Kassa user** by Kassa ID (for example `KSA-ZVMS-3NXE`). The new payee cools down for 24 hours like any payee, and each send needs the passkey ([docs/SANDBOX_PAYMENTS.md](docs/SANDBOX_PAYMENTS.md)).
- **China handoff.** In region CN Kassa prepares the payment and hands off to the user's QR wallet after checking the QR payee name.
- **Small business mode** (hidden by default; `EXPO_PUBLIC_SHOW_BUSINESS=true` shows it). Stock forecast, purchase orders signed with the passkey, and a three-way invoice match that refuses swapped bank details (attack A9).

## How Kassa covers Topic C

| Pain point named in the brief | What Kassa does | Where |
| --- | --- | --- |
| Remittances | Money from home (KZT, USD) is logged as it arrives; each bill gets the cheapest funding route with the FX cost shown | Route and FX optimizer, [ARCHITECTURE.md §4.1](docs/ARCHITECTURE.md) |
| Tuition payments | The agent reads the invoice, checks the payee, and prepares the transfer; the student approves the exact order with a passkey | Demo beat 2, [DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) |
| Credit building | A signed credit record (bills paid on time, income, budgets) the student can share with a landlord or bank, with a public verify link | `apps/api/src/modules/credit-record/` |
| Multi-currency management | Spending in every currency with a home-currency equivalent, budgets with a pace forecast, and a fee x-ray for card FX markups | Capture, budget and fee x-ray modules |

## Submission map

| Brief checklist item | In this repository |
| --- | --- |
| Technical documentation | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (architecture, core algorithms), [docs/SECURITY.md](docs/SECURITY.md) (security design) |
| Source code | This repository: README, deployment (below), tests ([docs/TESTS.md](docs/TESTS.md)) |
| Security self-assessment | [docs/SECURITY.md](docs/SECURITY.md): permission tiers T0 to T3 (§2), known risks (§7) |
| Execution evidence | Sandbox logs and reports in [docs/evidence/](docs/evidence/): attack results, ledger verification, story run, persona simulations |

## Documents

| Document                                                     | What it covers                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                 | System parts, request flow, the three core algorithms, data model, AI layer                           |
| [docs/SECURITY.md](docs/SECURITY.md)                         | Security self-assessment: permission tiers, invariants I1 to I13, threat model, known risks           |
| [docs/PRIVACY.md](docs/PRIVACY.md)                           | GDPR record of processing, data map, data subject rights, retention, DPIA summary                     |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md)                     | Requirement-by-requirement mapping with status (Implemented, Simulated, Planned)                      |
| [docs/TESTS.md](docs/TESTS.md)                               | Test catalogue: file-by-file counts from the final `bun run test` run, and attack evidence            |
| [docs/evidence/sim/SUMMARY.md](docs/evidence/sim/SUMMARY.md) | Persona and attacker simulation reports (p1, p2, p3, cn, security) and the fix status of each finding |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Dated log of every deviation from the technical spec |
| [docs/SANDBOX_PAYMENTS.md](docs/SANDBOX_PAYMENTS.md) | Sandbox payouts for EU, China and US; Add money (test money); sending to another Kassa user by Kassa ID |
| [docs/SHORTCUT_SETUP.md](docs/SHORTCUT_SETUP.md) | Log real iPhone Apple Pay taps: iOS 17+ Shortcuts Transaction automation, device token, limits |
| [docs/spec/TECH_SPEC.md](docs/spec/TECH_SPEC.md) | Technical specification (source of truth for how) |
| [docs/evidence/sim/RUNBOOK.md](docs/evidence/sim/RUNBOOK.md) | Simulation runbook: personas, attackers, command reference |

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/api` | Fastify 5 API (TypeScript, Bun). Modules under `src/modules/` include `agent`, `ai`, `reader`, `rules`, `payments`, `rails`, `capture`, `budget`, `fx`, `screening`, `ledger`, `privacy`, `payees`, `mandates`, `users`, `auth`, `scheduler`, `demo`, `webhooks`, `wallet`, `credit-record`, `business` and `commerce`. Drizzle schema in `src/db/`, migrations in `drizzle/`, tests in `test/` |
| `apps/mock-world` | Fastify mock services: a Wise-shaped mock bank, a pizza shop, two food suppliers, a university, a landlord, an insurer, an email inbox, a "QR Wallet (simulated)", a POS emitter, and a remittance sender |
| `apps/mobile` | Expo app (Expo Router, React Native Web, native passkeys). Source in `src/app/`. Generated from the ReadyNative Pro boilerplate, see Licences |
| `packages/shared` | `@kassa/shared`: zod schemas, `CanonicalOrder`, `orderHash` and `mandateHash` (RFC 8785 JCS), reason codes, money helpers (integer minor units), IBAN helpers, mock webhook HMAC |
| `fixtures` | Seed data for Dana, 30 labelled invoice PDFs, notification samples, a fictitious sanctions sample, FX example rates, recorded agent replays |
| `docs` | The documents above, the spec, decisions, and evidence |
| `scripts` | `env-setup.ts` (local `.env` files), `keys-generate.ts` (Ed25519 and AES keys) |
| `api/index.ts`, `vercel.json` | Vercel deployment (one function for the API and the mock world), see "Deploy on Vercel" |
| `docker-compose.yml`, `Caddyfile`, `apps/*/Dockerfile` | Optional deployment path, see below |

## Run locally (without Docker)

This is the primary path. The database is file-backed PGlite in `.data/`, so no database server is needed.

### Prerequisites

| Tool    | Version                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------- |
| Bun     | 1.4.0 (`packageManager` in the root `package.json`). The root `bunfig.toml` sets the hoisted linker, which Expo needs |
| Node.js | 22.18 or later (`engines` of `apps/mobile`). Only needed for the mobile app                                           |

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
- `AGENT_MODE` defaults to `LIVE` in the code and in `.env.example`. With no AI key, or when the model is unreachable, each turn falls back to a recorded replay labelled Replay. Set `AGENT_MODE=REPLAY` to always use the recordings. `env:setup` writes `ISSUING_PROVIDER=fake`.
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

### Running on a phone

```bash
bun run dev:all                # tunnel + single HTTPS origin + api, mock-world and mobile web; prints the URL and a QR code
bun run dev:all --no-tunnel    # localhost only, same as `turbo run dev`
```

`dev:all` needs `cloudflared` (`brew install cloudflared`). It starts the tunnel, then a proxy on `:8080` so the phone gets one HTTPS origin (web app, `/api` and `/mock`), writes the gitignored `.env.dev-runtime` (`PUBLIC_ORIGIN`, `EXTRA_ORIGINS`, `RP_ID`, `EXPO_PUBLIC_API_URL`) and runs the services through turbo with that env. Scan the QR code with the phone camera. Ctrl-C stops everything.

- **Named tunnel (stable host, recommended):** set `CLOUDFLARED_TUNNEL=<tunnel name>` and `PHONE_HOST=<its hostname>` (route it once with `cloudflared tunnel route dns <name> <host>`). `RP_ID` stays the same across restarts, so passkeys keep working.
- **Quick tunnel (default):** a random `trycloudflare.com` host that changes on every run, so passkeys made on it stop working after a restart. Dev sign-in is off by default, also on a tunnel. Set `DEV_LOGIN=true` yourself to get `POST /auth/dev/login` and a "Continue as dev user" button; approvals then use a server-held test passkey (`POST /auth/dev/assert`). It is never available with `NODE_ENV=production` (SECURITY.md §7.0).
- `bun run phone` is the older proxy-and-tunnel-only command; it shares the same tunnel and proxy code (`scripts/lib/`).
- **KassaLite** (a build signed with a free Apple ID that shows your Apple Pay purchases): see [docs/KASSALITE.md](docs/KASSALITE.md); it needs the named tunnel above.

### AI configuration

| Mode | Setting | Needs |
| --- | --- | --- |
| Live (default) | `AGENT_MODE=LIVE`, `PLANNER_MODEL`, `READER_MODEL` | One key for the chosen provider, for example `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`. Without a key, or if the model is unreachable, the turn is served from the matching recording and labelled Replay |
| Replay | `AGENT_MODE=REPLAY` | Nothing. Recorded tool calls from `fixtures/agent-recordings/` are served through the AI SDK mock model |

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

- Counts from the latest run (2026-10-14): API 828 tests in 104 files, one opt-in live-AI smoke test skipped (unit, invariant, attack, security and integration), mock world 338, shared 53, mobile Jest 527. Each test file and what it asserts is listed in [docs/TESTS.md](docs/TESTS.md) and [docs/SECURITY.md](docs/SECURITY.md).
- `ledger:verify` writes its report to `docs/evidence/ledger-verify.json`.
- CI: `.github/workflows/ci.yml` runs on every push and pull request (typecheck, lint, tests in replay mode, migrate, seed, `ledger:verify`).

## Deploy on Vercel

One Vercel project serves everything from one origin (needed for WebAuthn), the same layout as the Caddy setup:

| Path                | Served by                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                 | Static web export of `apps/mobile` (`apps/mobile/dist`)                                                                                                           |
| `/api/*`, `/mock/*` | One Vercel Function, `api/index.ts` (Bun runtime). It starts the API and the mock world on loopback inside the instance and proxies each request to the right one |

Files: `vercel.json`, `api/index.ts`, `scripts/vercel-build.ts` (build command: migrations on production builds, then `expo export`), `.vercelignore`.

Needs a Postgres database (PGlite needs a writable disk, which a function does not have). Any `postgres://` URL in `DATABASE_URL` works, for example Neon from the Vercel Marketplace.

Shortcut: `bash scripts/deploy-vercel.sh` runs every step below (later deploys: `--redeploy`). The Vercel build never starts cloudflared or the dev proxy; those are only in `bun run dev:all` and `bun run phone`.

```bash
npm i -g vercel
vercel login
vercel link                                   # from the repo root; framework preset "Other", root directory ./
vercel integration add neon                   # or Dashboard → Storage; connect it to the project, it sets DATABASE_URL

# Secrets: generated locally into a gitignored file, then sent to Vercel
bun run keys:generate > .env.vercel
grep -v '^#' .env.vercel | while IFS= read -r line; do
  printf '%s' "${line#*=}" | vercel env add "${line%%=*}" production --force
done
printf '%s' true   | vercel env add DEMO_ENABLED production
printf '%s' LIVE   | vercel env add AGENT_MODE production
printf '%s' "$ANTHROPIC_API_KEY" | vercel env add ANTHROPIC_API_KEY production   # or OPENROUTER_API_KEY; without a key every turn is a labelled Replay
printf '%s' fake   | vercel env add ISSUING_PROVIDER production

vercel deploy --prod                          # migrations run in the build
```

No domain to configure: the function takes the project's production domain (`VERCEL_PROJECT_PRODUCTION_URL`, e.g. `kassa-sand.vercel.app`, or your primary custom domain) as the passkey origin and RP ID and as the base of mock-world links (`PUBLIC_ORIGIN`, `RP_ID`, `MOCK_PUBLIC_URL`, `KASSA_APP_URL` still override it). With `DEMO_ENABLED=true` the first start loads the demo data into an empty database. If the server cannot start, every `/api` call answers 500 `STARTUP_FAILED` with the reason (also in `vercel logs`).

Notes:

- Passkeys are bound to the production domain: open the app there, not on a per-deployment URL. With Deployment Protection (Vercel Authentication) on, visitors must log in to Vercel first; turn it off under Project → Settings → Deployment Protection for a public demo.
- Migrations run only on production builds (`VERCEL_ENV=production`). Set `MIGRATE_ON_BUILD=true` for a preview environment that has its own database.
- The mock world keeps its state (bank transfers, QR payments, shop orders) in memory. A cold start, or a second instance under load, starts it empty; `POST /api/demo/reset` puts the API and the mock world back in step.
- Function timers only run while an instance is awake, so the 15 s scheduler and the mock bank tick also run, at most once per interval, after incoming requests.
- `DEV_LOGIN` does not work on Vercel (production mode); sign in with a passkey.

## Docker Compose (optional deployment path)

`docker-compose.yml` defines Postgres 16, the API, the mock world, and Caddy. Caddy serves the static web build at `/`, proxies `/api` to the API and `/mock` to the mock world, and provides HTTPS for WebAuthn. Build the web export first with `cd apps/mobile && bun run build`, then run `docker compose up`.

This path is not used for local development. The Dockerfiles exist, but this repository does not contain a verified Docker run as part of the submission evidence.

## Licences

| Item                                    | Where                                                 | Note                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kassa's own code                        | `LICENSE` (repository root)                           | MIT License, Copyright (c) 2026 Madiyar Baizhigitov and the Kassa team. `package.json` files of the root, `apps/api`, `apps/mock-world` and `packages/shared` carry `"license": "MIT"`                                                                                                                                                                                                                                                       |
| ReadyNative Pro (base of `apps/mobile`) | `apps/mobile/LICENSE`; notice at the end of `LICENSE` | Commercial ReadyNative licence, unchanged. The licensor (Madiyar Baizhigitov, trading as ReadyNative) is also an author of Kassa and permits publication of these files in this repository as part of the Kassa entry to the 2026 Shenzhen International FinTech Competition (FinTechathon). Further redistribution of the boilerplate outside this entry requires a ReadyNative licence. Recorded in [docs/DECISIONS.md](docs/DECISIONS.md) |
| Third-party notices                     | `apps/mobile/LICENSES/`                               | `expo-skills-MIT.txt`, `expo-template-MIT.txt`. Do not remove                                                                                                                                                                                                                                                                                                                                                                                |
| npm dependencies                        | `package.json` files and `bun.lock`                   | Licences come from each package. Not audited in this pass                                                                                                                                                                                                                                                                                                                                                                                    |
| Mock companies                          | `apps/mock-world/src/world/`                          | Fictitious, generic names (for example "Pizza Shop in Budapest", "QR Wallet (simulated)"). No real brand logos                                                                                                                                                                                                                                                                                                                               |
| Sanctions sample                        | `fixtures/sanctions-sample.json`                      | Fictitious entries in the EU Financial Sanctions Files schema, with a licence note inside the file. The screening module can load the real FSF export, which has the same structure                                                                                                                                                                                                                                                          |
| Invoice PDFs                            | `fixtures/invoices/`                                  | Generated by `apps/mock-world` with pdf-lib, using the standard 14 PDF fonts (no embedded fonts)                                                                                                                                                                                                                                                                                                                                             |
| FX reference rates                      | `fixtures/fx-rates.json`                              | Example values, labelled `STATIC_EXAMPLE` in every quote. Live sources are ECB (via Frankfurter) and the National Bank of Kazakhstan                                                                                                                                                                                                                                                                                                         |
