# Deploy

Kassa deploys to Vercel as one project that serves everything from one origin (WebAuthn needs that). Docker Compose is an alternative path.

## Vercel

| Path | Served by |
| --- | --- |
| `/` | Static web export of `apps/mobile` (`apps/mobile/dist`) |
| `/api/*`, `/mock/*` | One Vercel Function, `api/index.ts` (Bun runtime). It starts the API and the mock world on loopback inside the instance and proxies each request to the right one |

Files: `vercel.json`, `api/index.ts`, `scripts/vercel-build.ts` (migrations on production builds, then `expo export`), `.vercelignore`.

A Postgres database is required (PGlite needs a writable disk, which a function does not have). Any `postgres://` URL in `DATABASE_URL` works, for example Neon from the Vercel Marketplace.

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

No domain to configure: the function takes the project's production domain (`VERCEL_PROJECT_PRODUCTION_URL`) as the passkey origin and RP ID, and as the base of mock-world links. `PUBLIC_ORIGIN`, `RP_ID`, `MOCK_PUBLIC_URL` and `KASSA_APP_URL` still override it. With `DEMO_ENABLED=true` the first start loads the demo data into an empty database. If the server cannot start, every `/api` call answers 500 `STARTUP_FAILED` with the reason.

Notes:

- Passkeys are bound to the production domain: open the app there, not on a per-deployment URL. Turn Deployment Protection off for a public demo.
- Migrations run only on production builds. Set `MIGRATE_ON_BUILD=true` for a preview environment with its own database.
- The mock world keeps its state in the same Postgres database (`mock_world_*` tables), so every instance and cold start sees the same world. `GET /mock/health` reports `"persistence": "postgres"`.
- Function timers only run while an instance is awake, so the 15 s scheduler and the mock bank tick also run after incoming requests.
- `DEV_LOGIN` does not work on Vercel (production mode); sign in with a passkey.

## Judge build

A second Vercel project (here `kassa-judge`) with `JUDGE_MODE=true`, `DEMO_ENABLED=true`, its own Neon database and its own signing keys.

- Dev sign-in is on. Each sign-in gets its own copy of the chosen persona, seeded through the normal code paths, with onboarding and the rent mandate signed by that copy's own server-held test passkey (`judgeModeActive` in `apps/api/src/modules/auth/dev.ts`).
- A copy starts with the seeded balances plus this month's money from home (KZT 1,000,000) and a simulated 6-month history (`simulated: true`) that the credit record and the agent read.
- Its rent, covered by the signed mandate, falls due within the scheduler's 3-day window: the scheduler pays it on the next tick, or at once with Settings → Demo → "Run today's scheduled payments" (`POST /api/demo/run-due-payments`).
- Settings → Demo → "Parents send money" (`POST /api/demo/money-from-home`) adds KZT 1,000,000, 3 times a day per copy.
- Optional: `ANCHOR_PRIVATE_KEY` anchors the judge ledger on Sepolia on a schedule ([On-chain anchoring](./on-chain-anchoring.md)).

## Docker Compose

`docker-compose.yml` defines Postgres 16, the API, the mock world and Caddy. Caddy serves the static web build at `/`, proxies `/api` and `/mock`, and provides HTTPS for WebAuthn.

```bash
cd apps/mobile && bun run build && cd ../..
docker compose up
```

This path is not used for local development, and the repository does not contain a verified Docker run as part of the submission evidence.

## The docs site

The documentation is a static [VitePress](https://vitepress.dev) site in `docs/`:

```bash
bun run docs:build                     # docs/.vitepress/dist
DOCS_BASE=/docs/ bun run docs:build    # to serve it under a sub-path
```

It deploys anywhere that serves static files (GitHub Pages, Vercel, Netlify).
