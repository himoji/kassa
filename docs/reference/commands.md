# Commands

Every command runs from the repository root with `bun run <name>`.

## Develop

| Command | What it does |
| --- | --- |
| `env:setup` | Writes gitignored `.env` files with generated dev keys (root, `apps/api`, `apps/mock-world`, `apps/mobile`); prints no secret values |
| `keys:generate` | Prints a fresh set of Ed25519 and AES keys in `.env` format (for deployments) |
| `db:migrate` | Applies the Drizzle migrations (PGlite in `.data/` locally, or `DATABASE_URL`) |
| `seed` | Inserts Dana and the other personas and sets the demo clock |
| `dev` | API on :4000 and mock world on :4001 (turbo) |
| `dev:all` | Tunnel, one HTTPS origin, API, mock world and the web app, for testing on a phone |
| `dev:tunnel` | Only the tunnel and proxy part of `dev:all` |
| `phone` | The older proxy-and-tunnel command |
| `docs:dev` / `docs:build` | This documentation site (VitePress) |

The app has its own commands in `apps/mobile` (`bun run web`, `bun run dev`, `bun run build`).

## Check

| Command | What it does |
| --- | --- |
| `typecheck` | `tsc` in every workspace |
| `lint` | ESLint (root config with the I1 and I2 import fences for api, mock world and shared; `expo lint` for mobile) |
| `test` | Vitest (api, mock world, shared) and Jest (mobile) |
| `ledger:verify` | Recomputes the hash chain, checkpoint signatures and head anchor; writes `docs/evidence/ledger-verify.json`; exits 1 on any mismatch |
| `ledger:anchor:verify` | Compares the Sepolia anchor transactions with `anchors.json` and the ledger (`--no-db` for the file only, `--url <deployment>` for a live one) |
| `credit:verify <record.json> --key <jwks>` | Checks a credit record's hash and Ed25519 signature offline |

## Produce evidence

| Command | Writes |
| --- | --- |
| `evidence:attacks` | `docs/evidence/attacks.json`, `naive-baseline.json`, `tap-confirm-baseline.json` (scripted models, no network) |
| `evidence:live` | `docs/evidence/live-agent.md` and `.json` (a live run against the judge build) |
| `eval:invoices` | `docs/evidence/invoice-eval.json` (the live Reader on 30 labelled invoices; needs `READER_MODEL`'s key) |
| `ledger:anchor` | Anchors unanchored checkpoints on Sepolia and updates `docs/evidence/anchors.json` (needs `ANCHOR_PRIVATE_KEY`) |
| `ledger:anchor:keygen` | Makes a testnet-only anchor key in `.anchor-key` (gitignored, never printed) and prints its address, faucet links and the Vercel commands |
| `sim <up\|status\|story\|down>` | The simulation stack and its reports ([Simulation](../guide/simulation.md)) |
| `demo:video` | A Playwright recording of the demo beats into `demo-video-out/` |

## Ship

| Command | What it does |
| --- | --- |
| `vercel-build` | Vercel's build command: migrations on production builds, then the web export |
| `lite:ios` | Builds KassaLite for an iPhone with a free Apple ID ([KassaLite](../guide/kassalite.md)) |
| `ota` | Publishes an over-the-air update ([OTA updates](../guide/ota-updates.md)) |
| `scripts/deploy-vercel.sh` | Every Vercel step in one script (`bash scripts/deploy-vercel.sh`, later `--redeploy`) |
