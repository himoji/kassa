# Run locally

This is the primary path. The database is file-backed PGlite in `.data/`, so no database server is needed.

## Prerequisites

| Tool | Version |
| --- | --- |
| Bun | 1.4.0 (`packageManager` in the root `package.json`). The root `bunfig.toml` sets the hoisted linker, which Expo needs |
| Node.js | 22.18 or later (`engines` of `apps/mobile`). Only needed for the mobile app |

## Start the API and the mock world

```bash
bun install
bun run env:setup      # writes gitignored .env files with generated dev keys; prints no secret values
bun run db:migrate     # creates the PGlite database in .data/kassa
bun run seed           # inserts Dana and the other personas
bun run dev            # API on http://localhost:4000, mock world on http://localhost:4001
```

`seed` prints the demo clock it set:

```text
seeded user c83d27e3-4e03-570f-8fea-87db32399c12 (Dana) + 4 persona(s); demo clock = 2026-10-27T09:00:00.000Z
```

Things worth knowing:

- Without a `.env`, the API still starts: it generates development secrets once into `.data/dev-secrets.json`. Production refuses to start without real keys.
- `AGENT_MODE` defaults to `LIVE`. With no AI key, or when the model is unreachable, each turn falls back to a recorded replay labelled **Replay**. Set `AGENT_MODE=REPLAY` to always use the recordings.
- PGlite allows one process per data directory. Stop the API before `bun run seed`, or use `POST /api/demo/reset` while it runs with `DEMO_ENABLED=true`.
- The demo routes are only registered when `DEMO_ENABLED=true`.
- Health checks: `curl localhost:4000/api/health` and `curl localhost:4001/mock/health`.

## The app

```bash
cd apps/mobile
bun run web            # Expo web on http://localhost:8081 (the default PUBLIC_ORIGIN and WebAuthn origin)
bun run dev            # Expo dev-client build for native devices
```

`env:setup` writes `apps/mobile/.env` with `EXPO_PUBLIC_API_URL=http://localhost:4000`. Passkeys need a secure context, and `localhost` counts as one.

### Sign in without a passkey device

Set `DEV_LOGIN=true` (with `DEMO_ENABLED=true`) to get `POST /api/auth/dev/login` and a "Continue as dev user" button. Approvals are then signed by a server-held test passkey (`POST /api/auth/dev/assert`). It is never available with `NODE_ENV=production`, and on a public tunnel only when you set it yourself. [Call the API](../examples/api-basics.md) uses it.

## On a phone

```bash
bun run dev:all                # tunnel + one HTTPS origin + api, mock world and web app; prints a URL and a QR code
bun run dev:all --no-tunnel    # localhost only
```

`dev:all` needs `cloudflared`. It starts the tunnel, then a proxy on `:8080` so the phone gets one HTTPS origin (web app, `/api` and `/mock`), writes the gitignored `.env.dev-runtime` and runs the services with that env. Scan the QR code with the phone camera; Ctrl-C stops everything.

- **Named tunnel (recommended):** set `CLOUDFLARED_TUNNEL=<name>` and `PHONE_HOST=<hostname>`. `RP_ID` stays the same across restarts, so passkeys keep working.
- **Quick tunnel (default):** a random `trycloudflare.com` host per run; passkeys made on it stop working after a restart.
- **KassaLite** needs the named tunnel: see [KassaLite](./kassalite.md).

## Checks

```bash
bun run typecheck      # tsc in every workspace
bun run lint           # ESLint, including the I1 and I2 import fences around the agent and payments
bun run test           # Vitest (api, mock-world, shared) and Jest (mobile)
bun run ledger:verify  # recomputes the hash chain and checkpoint signatures; exits 1 on any mismatch
```

The [test catalogue](../reference/tests.md) lists what each suite asserts.
