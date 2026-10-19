# Kassa app

Kassa's iOS, Android and web app: [Expo](https://expo.dev) SDK 57, Expo Router, TypeScript, started from the ReadyNative Pro kit (licence in `LICENSE`, publication permission in [PUBLICATION_PERMISSION.md](PUBLICATION_PERMISSION.md)). Screens, flows and locales (en, kk, ru, zh) are Kassa's. To run the whole system, see the [root README](../../README.md); the commands below are for the app alone.

```bash
bun install
cp .env.example .env         # then fill in the keys it lists, if any
bun run start                 # press i / a, or scan the QR code
bun run doctor                # env keys, toolchains, what to do before you ship
```

`start` opens in **Expo Go** when every package runs there, else in your **development build**; `bun run start:dev` always targets the dev build. Build one with `bun run ios` (or `android`), or `bunx eas-cli build --profile development`.

## Scripts

| Script | What it does |
| --- | --- |
| `bun run start` | Dev server: Expo Go when every module runs there (`--go`), else dev build (`--dev-client`) |
| `bun run start:dev` | Dev server for a development build (`expo start --dev-client`) |
| `bun run ios` / `android` | Build and run the dev build |
| `bun run web` | Dev server for web |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `lint:fix` | `expo lint` (`--fix`: auto-fixable rules + Prettier) |
| `bun run format` | `prettier --write .` |
| `bun run test` | Unit tests (jest + Testing Library) |
| `bun run test:e2e` | Maestro flows in `.maestro/flows` against an installed dev build |
| `bun run doctor` | Env keys, placeholders in `readynative.config.ts`, EAS login, SDKs; `--store` adds the store review check (Pro) |
| `bun run gen:assets` | `assets/brand/icon.png` + brand colour → app icon, adaptive icon, splash, favicon |
| `bun run gen:links` | `links` config → `public/.well-known/*` for universal / App Links |
| `bun run gen:privacy` | Privacy-policy draft → `docs/privacy-policy.md` (not legal advice) |
| `bun run gen:graph` | The tree → `docs/graph.json` + `docs/ARCHITECTURE.md` (`--check` fails on drift) |
| `bun run gen:theme` | Design tokens → theme file (`--check` fails on drift) |
| `bun run gen` | `gen screen <name> [--tab \| --modal]` → a screen + its route |
| `bun run push:test` | `push:test <ExponentPushToken[…]> [title] [body]` → one test push |

## Structure

| Path | What lives there |
| --- | --- |
| `src/app` | Routes (Expo Router); `_layout.tsx` files are navigators |
| `src/screens` | Screen bodies; routes stay thin |
| `src/components` | Shared components |
| `src/components/ui` | Primitive kit (`Screen`, `Box`, `Text`, `Button`, `List`, …), prop types in `types.ts` |
| `src/lib` | Env, storage, i18n, analytics/auth/payments shims |
| `src/stores` | Client state |
| `src/theme` | Design tokens, colour scheme, navigation theme |
| `src/locales` | Translation JSON |

## Config

- `readynative.config.ts`: app identity (name, slug, scheme, bundle ids), brand, urls, store ids, deep-link domain, feature toggles. Most edits start here.
- `app.config.ts`: the Expo config; reads `readynative.config.ts` and applies the per-variant bundle id / name (`APP_VARIANT=dev | preview | prod`).
- `.env`: copy `.env.example`. Only `EXPO_PUBLIC_*` keys reach the app (typed in `src/lib/env.ts`).
- `assets/brand/icon.png`: 1024px icon for `gen:assets`; `doctor` flags the placeholder.

## Passkeys on native (Kassa)

Every sign-up, sign-in and approval is a WebAuthn passkey. On **web** this works against a local API (`RP_ID=localhost`, `PUBLIC_ORIGIN=http://localhost:8081`). The **native** app cannot use a local API for passkeys, because of two OS rules (checked on the iOS 26.5 simulator, 2026-10-11):

1. **Biometrics enrolled.** `react-native-passkeys` refuses unless Face ID / Touch ID is enrolled (`ERR_BIOMETRIC`). On a fresh simulator: Features > Face ID > Enrolled. The app says "Passkeys need Face ID or Touch ID set up".
2. **App associated with the RP ID's domain.** iOS checks that the app holds `webcredentials:<RP_ID>` and that `https://<RP_ID>/.well-known/apple-app-site-association` lists `<TEAMID>.<bundle id>`. Otherwise: ASAuthorizationError 1004 ("Application with identifier … is not associated with domain localhost", OS log only). `localhost` and IP addresses never pass, so the app stops before the OS sheet and says "Passkeys need the app's domain".

Native passkeys need an HTTPS domain you control (a tunnel works) serving the API and the AASA file:

- `readynative.config.ts`: `links.domain` = that domain, `links.appleTeamId` = your team. The app config then adds `applinks:` and `webcredentials:` (rebuild: `bunx expo run:ios`). `bun run gen:links` writes `public/.well-known/apple-app-site-association` (with `webcredentials.apps`), served from the domain root.
- API env: `RP_ID=<domain>`, `PUBLIC_ORIGIN=https://<domain>`; app: `EXPO_PUBLIC_API_URL=https://<domain>`. Use a signed development build, not Expo Go. iOS fetches the AASA through Apple's CDN, so a new domain can take a while; `webcredentials:<domain>?mode=developer` fetches it directly (the app config does not add this suffix).

**Demo without a domain:** use the web build. With `DEMO_ENABLED=true` on the API, the welcome screen shows **Try the demo (simulated)** (`GET /api/auth/demo`). It runs normal passkey registration with `demoClaim`, binding the seeded account to a new passkey; every payment still needs it. On native + localhost the button shows "Passkeys need the app's domain".

## Ship

```bash
bunx eas-cli build --profile preview --platform all      # internal build
bunx eas-cli build --profile production --platform all   # store build
bunx eas-cli submit --profile production --platform ios  # upload to the store
```

Over-the-air fixes: `bunx eas-cli update --channel production --message "…"`.

## Running on a physical iPhone

Use the **web app in Safari** over one HTTPS origin: passkeys work through iCloud Keychain. Native passkeys need a paid Apple Developer team (free teams lack the Associated Domains entitlement).

Steps used (2026-10-11, iPhone 17 Pro; the phone was not visually verified by the agent):

1. Repo root: `bun run db:migrate && bun run seed`.
2. Export the web app with `EXPO_PUBLIC_API_URL` set to the tunnel host. Use `-c` when it changes (Metro caches it; `.env` wins over an inline empty string). No real admin token in the web export:
   `EXPO_PUBLIC_API_URL=https://HOST EXPO_PUBLIC_DEMO_ADMIN_TOKEN=not-available-in-web-build bunx expo export -p web -c`
   `apps/mobile/dist/_expo/static/js/web` must not contain `localhost:4000` or the old token.
3. Serve one origin on port 8080: `/api/*` → `127.0.0.1:4000`, `/mock/*` → `127.0.0.1:4001`, else `apps/mobile/dist` with SPA fallback to `index.html`. The repo `Caddyfile` does this routing (a small Bun proxy outside the repo was used here).
4. Tunnel: `cloudflared tunnel --url http://127.0.0.1:8080`; HOST is the `trycloudflare.com` line in its log and changes on restart.
5. Start the API and mock-world directly, not through turbo (turbo filters inline env vars):
   `cd apps/api && RP_ID=HOST PUBLIC_ORIGIN=https://HOST EXTRA_ORIGINS=https://HOST TRUST_PROXY=true DEMO_ENABLED=true AGENT_MODE=REPLAY bun src/index.ts`
   and `cd apps/mock-world && bun src/index.ts`. Use `AGENT_MODE=LIVE` for real model calls.
6. Check: `curl -s https://HOST/` is 200 HTML, `curl -s https://HOST/api/health` is `{"ok":true,...}`, `curl -s https://HOST/api/auth/demo` is `{"enabled":true}`.
7. On the phone, open `https://HOST` in Safari, tap **Try the demo (simulated)**, create the passkey with Face ID.

Native build (not done): with a free team the app should show "Passkeys need the app's domain". Set `links.domain` and `links.appleTeamId` only with a paid team.
