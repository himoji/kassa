# Over-the-air updates

Both iPhone builds (KassaLite and the full app) take JS, UI, text and image changes over the air with [EAS Update](https://docs.expo.dev/eas-update/introduction/) (`expo-updates`, already in `apps/mobile`), without rebuilding.

## What can ship over the air

| Over the air | Needs a new build |
| --- | --- |
| Anything under `apps/mobile/src` (screens, hooks, API calls, styles, copy, locales) | A new or upgraded native module (anything with iOS code, a new `expo-*` package) |
| `@kassa/shared` code the app imports | `app.config.ts` native keys: plugins, bundle id, scheme, Info.plist, entitlements, icon, splash |
| Images and fonts the JS bundle imports | The app version in `apps/mobile/package.json` (the runtime version) |

`EXPO_PUBLIC_*` values are inlined at publish time, so publish with the same `.env` / environment as the build.

An update reaches only builds with the same **channel** and **runtime version**. The runtime version is the app version (`runtimeVersion.policy: "appVersion"`, today `1.3.0`); bump it only with a rebuild, or installed builds stop receiving updates.

| Build | How it is built | Channel |
| --- | --- | --- |
| KassaLite | Xcode, `bun run lite:ios` ([guide/kassalite.md](./kassalite.md)) | `lite` (set in `app.config.ts`) |
| Full app | `eas build --profile production` / `preview` | `production` / `preview` (from `eas.json`) |
| Full app, local Xcode build | `UPDATES_CHANNEL=<name> expo run:ios --configuration Release` | whatever `UPDATES_CHANNEL` says |

## One-time setup

1. **Link an EAS project** (free Expo account): in `apps/mobile` run `npx eas-cli@latest login`, then `npx eas-cli@latest init`. Paste the printed id into `apps/mobile/readynative.config.ts` → `app.easProjectId` (and your Expo username into `app.owner` if asked); `init` cannot write the dynamic `app.config.ts`. Commit it.
2. **Rebuild once** so the app has the update URL and channel. KassaLite: `bun run lite:ios`, then Run in Xcode with **Release** (Debug loads from Metro and ignores updates). Full app: a new `eas build`. Builds without the project id never check for updates.

## Publishing

```bash
bun run ota lite "Fix activity list"          # KassaLite
bun run ota production "Fix activity list"    # full app, production builds
bun run ota preview                           # full app, preview builds
```

`scripts/ota.ts` runs `eas update` in `apps/mobile` with the matching `APP_VARIANT`, channel and platform. Anything after `--` is passed to `eas update`.

The app checks on every start and applies the download on the **next** start: open, wait a few seconds, swipe away, reopen. The full app also shows an "Update ready" banner with Restart (`src/components/updates-banner.tsx`).

To undo, republish the previous commit, or run `npx eas-cli@latest update:republish` / `update:rollback` in `apps/mobile`.

## KassaLite and the 7-day limit

Updates do not extend the free provisioning profile: re-run KassaLite from Xcode weekly ([KassaLite](./kassalite.md#the-7-day-limit)).

## When an update does not arrive

KassaLite → **Settings → App updates** shows the running update and one of:

- **"Over-the-air updates are off in this build"**: no EAS project id. Do the one-time setup and rebuild.
- **"Debug build"**: run Release.
- **"Channel lite, version X"**: if **Check for updates** says "Up to date", publish with `bun run ota lite` and keep `apps/mobile/package.json`'s version equal to the one shown.
