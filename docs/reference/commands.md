# Commands

Run from the repo root with `bun run <name>`.

## Develop

| Command | Does |
| --- | --- |
| `env:setup` | Writes gitignored `.env` files with generated dev keys (root, `apps/api`, `apps/mock-world`, `apps/mobile`); prints no secrets |
| `keys:generate` | Prints fresh Ed25519 and AES keys in `.env` format (deployments) |
| `db:migrate` | Drizzle migrations (PGlite in `.data/`, or `DATABASE_URL`) |
| `seed` | Dana, other personas, demo clock |
| `dev` | API :4000, mock world :4001 (turbo) |
| `dev:all` | Tunnel, one HTTPS origin, API, mock world, web app (phone testing) |
| `dev:tunnel` | Tunnel and proxy part of `dev:all` only |
| `phone` | Older proxy-and-tunnel command |
| `docs:dev` / `docs:build` | This site (VitePress) |

`apps/mobile` has its own: `bun run web`, `bun run dev`, `bun run build`.

## Check

| Command | Does |
| --- | --- |
| `typecheck` | `tsc` in every workspace |
| `lint` | ESLint (I1 and I2 import fences for api, mock world, shared; `expo lint` for mobile) |
| `test` | Vitest (api, mock world, shared), Jest (mobile) |
| `ledger:verify` | Hash chain, checkpoint signatures, head anchor; writes `docs/evidence/ledger-verify.json`; exits 1 on mismatch |
| `ledger:anchor:verify` | Sepolia anchors vs `anchors.json` and the ledger (`--no-db` file only, `--url <deployment>` live) |
| `credit:verify <record.json> --key <jwks>` | Credit record hash and Ed25519 signature, offline |

## Produce evidence

| Command | Writes |
| --- | --- |
| `evidence:attacks` | `docs/evidence/attacks.json`, `naive-baseline.json`, `tap-confirm-baseline.json` (scripted models, no network) |
| `evidence:live` | `docs/evidence/live-agent.md` and `.json` (a live run against the judge build) |
| `eval:invoices` | `docs/evidence/invoice-eval.json` (live Reader, 30 labelled invoices; needs `READER_MODEL`'s key) |
| `ledger:anchor` | Anchors new checkpoints on Sepolia, updates `docs/evidence/anchors.json` (needs `ANCHOR_PRIVATE_KEY`) |
| `ledger:anchor:keygen` | Testnet-only key in `.anchor-key` (gitignored, never printed); prints address, faucet links, Vercel commands |
| `sim <up\|status\|story\|down>` | Simulation stack and reports ([Simulation](../guide/simulation.md)) |
| `demo:video` | Playwright recording of the demo beats into `demo-video-out/` |

## Ship

| Command | Does |
| --- | --- |
| `vercel-build` | Vercel build: migrations on production builds, then web export |
| `lite:ios` | KassaLite for iPhone with a free Apple ID ([KassaLite](../guide/kassalite.md)) |
| `ota` | Over-the-air update ([OTA updates](../guide/ota-updates.md)) |
| `scripts/deploy-vercel.sh` | All Vercel steps (`bash scripts/deploy-vercel.sh`, later `--redeploy`) |
