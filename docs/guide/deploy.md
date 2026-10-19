# Deploy

One Vercel project serving everything from one origin (WebAuthn needs that). Docker Compose is an alternative.

## Vercel

| Path | Served by |
| --- | --- |
| `/` | Static web export of `apps/mobile` (`apps/mobile/dist`) |
| `/api/*`, `/mock/*` | One Vercel Function, `api/index.ts` (Bun runtime), which starts the API and mock world on loopback and proxies to them |

Files: `vercel.json`, `api/index.ts`, `scripts/vercel-build.ts` (migrations on production builds, then `expo export`), `.vercelignore`.

Needs Postgres (a function has no writable disk for PGlite): any `postgres://` URL in `DATABASE_URL`, e.g. Neon from the Vercel Marketplace.

`bash scripts/deploy-vercel.sh` runs every step below (later deploys: `--redeploy`).

```bash
npm i -g vercel
vercel login
vercel link                                   # from the repo root; framework preset "Other", root directory ./
vercel integration add neon                   # or Dashboard → Storage; it sets DATABASE_URL

# Secrets: generated locally into a gitignored file, then sent to Vercel
bun run keys:generate > .env.vercel
grep -v '^#' .env.vercel | while IFS= read -r line; do
  printf '%s' "${line#*=}" | vercel env add "${line%%=*}" production --force
done
printf '%s' true   | vercel env add DEMO_ENABLED production
printf '%s' LIVE   | vercel env add AGENT_MODE production
printf '%s' "$OPENROUTER_API_KEY" | vercel env add OPENROUTER_API_KEY production   # without a key every turn is a labelled Replay
printf '%s' fake   | vercel env add ISSUING_PROVIDER production

vercel deploy --prod                          # migrations run in the build
```

- No domain setup: the production domain (`VERCEL_PROJECT_PRODUCTION_URL`) becomes the passkey origin, RP ID and mock-world link base. `PUBLIC_ORIGIN`, `RP_ID`, `MOCK_PUBLIC_URL` and `KASSA_APP_URL` override it.
- With `DEMO_ENABLED=true` the first start loads demo data into an empty database. If startup fails, every `/api` call answers 500 `STARTUP_FAILED` with the reason.
- Passkeys are bound to the production domain: use it, not a per-deployment URL. Turn Deployment Protection off for a public demo.
- Migrations run only on production builds; `MIGRATE_ON_BUILD=true` for a preview with its own database.
- Mock-world state lives in the same Postgres (`mock_world_*` tables), shared across instances; `GET /mock/health` reports `"persistence": "postgres"`.
- Timers run only while an instance is awake, so the 15 s scheduler and mock bank tick also run after requests.
- `DEV_LOGIN` does not work on Vercel (production mode); use a passkey.

## Judge build

A second Vercel project (`kassa-judge`) with `JUDGE_MODE=true`, `DEMO_ENABLED=true`, its own Neon database and signing keys.

- Each dev sign-in gets its own persona copy, with onboarding and rent mandate signed by its server-held test passkey (`judgeModeActive` in `apps/api/src/modules/auth/dev.ts`).
- A copy starts with seeded balances, this month's money from home (KZT 1,000,000) and a simulated 6-month history (`simulated: true`).
- Mandated rent falls due within the scheduler's 3-day window: paid on the next tick, or via Settings → Demo → "Run today's scheduled payments" (`POST /api/demo/run-due-payments`).
- Settings → Demo → "Parents send money" (`POST /api/demo/money-from-home`) adds KZT 1,000,000, 3 times a day per copy.
- Optional Sepolia anchoring: `bun run ledger:anchor:keygen`, then `vercel env add ANCHOR_PRIVATE_KEY production < .anchor-key` and redeploy ([On-chain anchoring](./on-chain-anchoring.md#turn-it-on-for-a-deployment)).

## Docker Compose

`docker-compose.yml`: Postgres 16, the API, the mock world and Caddy (serves the web build at `/`, proxies `/api` and `/mock`, provides HTTPS for WebAuthn).

```bash
cd apps/mobile && bun run build && cd ../..
docker compose up
```

Not used for local development; no verified Docker run is part of the submission evidence.

## The docs site

A static [VitePress](https://vitepress.dev) site in `docs/`, deployable to any static host (GitHub Pages, Vercel, Netlify):

```bash
bun run docs:build                     # docs/.vitepress/dist
DOCS_BASE=/docs/ bun run docs:build    # to serve it under a sub-path
```
