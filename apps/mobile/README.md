# ReadyNative

An [Expo](https://expo.dev) app (SDK 57, Expo Router, TypeScript).

```bash
bun install
cp .env.example .env         # then fill in the keys it lists, if any
bun run start                 # press i / a, or scan the QR code
bun run doctor                # env keys, toolchains, what to do before you ship
```

`start` opens in **Expo Go** when every package in the app runs there, and in your
**development build** otherwise; `bun run start:dev` always targets the dev build. Build and
install a dev build once with `bun run ios` (or `android`), or in the cloud with
`bunx eas-cli build --profile development`.

## Scripts

| Script                | What it does                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run start`       | Start the dev server - opens in Expo Go when every module runs there (`--go`), else in your dev build (`--dev-client`)                |
| `bun run start:dev`   | Start the dev server for a development build (`expo start --dev-client`)                                                              |
| `bun run ios`         | Build and run the iOS dev build                                                                                                       |
| `bun run android`     | Build and run the Android dev build                                                                                                   |
| `bun run web`         | Start the dev server for web                                                                                                          |
| `bun run typecheck`   | `tsc --noEmit`                                                                                                                        |
| `bun run lint`        | `expo lint`                                                                                                                           |
| `bun run lint:fix`    | `expo lint --fix` (auto-fixable rules + Prettier)                                                                                     |
| `bun run format`      | `prettier --write .`                                                                                                                  |
| `bun run test`        | Unit tests (jest + Testing Library)                                                                                                   |
| `bun run test:e2e`    | Maestro flows in `.maestro/flows` against an installed dev build                                                                      |
| `bun run doctor`      | Checklist: env keys, placeholders in `readynative.config.ts`, EAS login, SDKs; `--store` adds the App Store / Play review check (Pro) |
| `bun run gen:assets`  | `assets/brand/icon.png` + brand colour → app icon, adaptive icon, splash, favicon                                                     |
| `bun run gen:links`   | `links` config → `public/.well-known/*` for universal / App Links                                                                     |
| `bun run gen:privacy` | Privacy-policy draft from the selected modules → `docs/privacy-policy.md` (not legal advice)                                          |
| `bun run gen:graph`   | The tree → `docs/graph.json` + `docs/ARCHITECTURE.md` (`--check` fails on drift)                                                      |
| `bun run gen:theme`   | Design tokens → the generated theme file (`--check` fails on drift)                                                                   |
| `bun run gen`         | `gen screen <name> [--tab                                                                                                             | --modal]` → a screen + its route (and tab / modal entry) |
| `bun run push:test`   | `push:test <ExponentPushToken[…]> [title] [body]` → one test push via the Expo push service                                           |

## Structure

| Path                | What lives there                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `src/app`           | Routes (Expo Router). Every file is a screen, `_layout.tsx` files are navigators           |
| `src/screens`       | Screen bodies - routes stay thin and render one of these                                   |
| `src/components`    | Shared components                                                                          |
| `src/components/ui` | The primitive kit (`Screen`, `Box`, `Text`, `Button`, `List`, …), prop types in `types.ts` |
| `src/lib`           | App services: env, storage, i18n, analytics/auth/payments shims                            |
| `src/stores`        | Client state                                                                               |
| `src/theme`         | Design tokens, colour scheme, navigation theme                                             |
| `src/locales`       | Translation JSON                                                                           |

## Examples

`examples/` holds finished example apps - standalone projects, not part of this app.
Nothing under `src/` imports them. Run one with:

```bash
cd examples/<name>
bun install
bun run ios       # or android / start
```

Delete `examples/` (or any app inside it) once you no longer need the reference.

## Config

- `readynative.config.ts` - app identity (name, slug, scheme, bundle ids), brand colour and
  radius, urls, store ids, deep-link domain, feature toggles. Most edits start here.
- `app.config.ts` - the Expo config; it reads `readynative.config.ts` and applies the per-variant
  bundle id / name (`APP_VARIANT=dev | preview | prod`).
- `.env` - copy `.env.example`. Only `EXPO_PUBLIC_*` keys reach the app (typed in `src/lib/env.ts`).
- `assets/brand/icon.png` - your 1024px icon; `gen:assets` derives the app icon, adaptive icon,
  splash and favicon from it. `doctor` flags the placeholder until you replace it.

## Passkeys on native (Kassa)

Every sign-up, sign-in and approval is a WebAuthn passkey ceremony. On **web** this works against a
local API (`RP_ID=localhost`, `PUBLIC_ORIGIN=http://localhost:8081`). The **native** app cannot use
a local API for passkeys. Two OS rules decide this (checked on the iOS 26.5 simulator, 2026-10-11):

1. **Biometrics enrolled.** `react-native-passkeys` refuses before any sheet unless Face ID / Touch ID
   is enrolled (`ERR_BIOMETRIC`). A fresh simulator has none: Features > Face ID > Enrolled. The app
   then says "Passkeys need Face ID or Touch ID set up".
2. **App associated with the RP ID's domain.** iOS checks that the app holds
   `webcredentials:<RP_ID>` and that `https://<RP_ID>/.well-known/apple-app-site-association` lists
   `<TEAMID>.<bundle id>`. Otherwise it fails with ASAuthorizationError 1004 ("Application with
   identifier … is not associated with domain localhost", visible only in the OS log). `localhost`
   and IP addresses can never pass this check, so with such an RP ID the app stops before the OS
   sheet and says "Passkeys need the app's domain".

To run native passkeys for real, you need an HTTPS domain you control (a tunnel works) that serves
the API and the AASA file:

- `readynative.config.ts` `links.domain` = that domain and `links.appleTeamId` = your team. The app
  config then adds `applinks:` and `webcredentials:` associated domains (rebuild:
  `bunx expo run:ios`). `bun run gen:links` writes `public/.well-known/apple-app-site-association`
  (with `webcredentials.apps`), which must be served from the domain root.
- API env: `RP_ID=<domain>`, `PUBLIC_ORIGIN=https://<domain>`, and `EXPO_PUBLIC_API_URL=https://<domain>`
  for the app. Use a signed development build, not Expo Go. iOS normally fetches the AASA through
  Apple's CDN, so a new or private domain can take a while. During development,
  `webcredentials:<domain>?mode=developer` makes the device fetch it directly. The app config
  does not add this suffix.

**Demo without a domain:** use the web build. When the API runs with `DEMO_ENABLED=true`, the welcome
screen shows **Try the demo (simulated)** (`GET /api/auth/demo`). It runs the normal passkey
registration with `demoClaim`, so the seeded demo account is bound to a new passkey and every
payment still needs that passkey. Where passkeys cannot work (native + localhost), the same button
shows the "Passkeys need the app's domain" message.

## Ship

```bash
bunx eas-cli build --profile preview --platform all      # internal build
bunx eas-cli build --profile production --platform all   # store build
bunx eas-cli submit --profile production --platform ios  # upload to the store
```

Over-the-air fixes: `bunx eas-cli update --channel production --message "…"`.
