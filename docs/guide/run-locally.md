# Run locally

The database is file-backed PGlite in `.data/`; no database server needed.

## Prerequisites

| Tool | Version |
| --- | --- |
| Bun | 1.4.0 (`packageManager` in root `package.json`; root `bunfig.toml` sets the hoisted linker Expo needs) |
| Node.js | 22.18 or later (`engines` of `apps/mobile`), only for the mobile app |

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

- Without a `.env` the API generates dev secrets once into `.data/dev-secrets.json`. Production refuses to start without real keys.
- `AGENT_MODE` defaults to `LIVE`, falling back to a labelled **Replay** with no key or an unreachable model. `AGENT_MODE=REPLAY` always uses recordings.
- PGlite allows one process per data directory: stop the API before `bun run seed`, or use `POST /api/demo/reset` while it runs.
- Demo routes exist only with `DEMO_ENABLED=true`.
- Health: `curl localhost:4000/api/health` and `curl localhost:4001/mock/health`.

## The app

```bash
cd apps/mobile
bun run web            # Expo web on http://localhost:8081 (the default PUBLIC_ORIGIN and WebAuthn origin)
bun run dev            # Expo dev-client build for native devices
```

`env:setup` writes `apps/mobile/.env` with `EXPO_PUBLIC_API_URL=http://localhost:4000`. Passkeys need a secure context; `localhost` is one.

### Sign in without a passkey device

Set `DEV_LOGIN=true` (with `DEMO_ENABLED=true`) for `POST /api/auth/dev/login` and a "Continue as dev user" button; approvals are signed by a server-held test passkey (`POST /api/auth/dev/assert`). Never available with `NODE_ENV=production`, and on a public tunnel only if you set it. Used by [Call the API](../examples/api-basics.md).

## On a phone

```bash
bun run dev:all                # tunnel + one HTTPS origin + api, mock world and web app; prints a URL and a QR code
bun run dev:all --no-tunnel    # localhost only
```

Needs `cloudflared`. It starts the tunnel and a proxy on `:8080` (one HTTPS origin for the web app, `/api` and `/mock`), writes the gitignored `.env.dev-runtime` and runs the services. Scan the QR code with the phone camera; Ctrl-C stops everything.

- **Named tunnel (recommended):** set `CLOUDFLARED_TUNNEL=<name>` and `PHONE_HOST=<hostname>`. `RP_ID` stays stable, so passkeys keep working.
- **Quick tunnel (default):** random `trycloudflare.com` host per run; passkeys break after a restart.
- **KassaLite** needs the named tunnel ([KassaLite](./kassalite.md)).

## Checks

```bash
bun run typecheck      # tsc in every workspace
bun run lint           # ESLint, including the I1 and I2 import fences around the agent and payments
bun run test           # Vitest (api, mock-world, shared) and Jest (mobile)
bun run ledger:verify  # recomputes the hash chain and checkpoint signatures; exits 1 on any mismatch
```

The [test catalogue](../reference/tests.md) lists what each suite asserts.
