# Over-the-air updates

Both iPhone builds (KassaLite and the full app) can take JS, UI, text and image changes over the air with
[EAS Update](https://docs.expo.dev/eas-update/introduction/), without rebuilding in Xcode or EAS Build. The update
client is `expo-updates`, already a dependency of `apps/mobile`.

## What can ship over the air

| Over the air | Needs a new build |
| --- | --- |
| Anything under `apps/mobile/src` (screens, hooks, API calls, styles, copy, locales) | A new or upgraded native module (anything with iOS code, a new `expo-*` package) |
| `@kassa/shared` code the app imports | `app.config.ts` native keys: plugins, bundle id, scheme, Info.plist, entitlements, icon, splash |
| Images and fonts the JS bundle imports | The app version in `apps/mobile/package.json` (it is the runtime version, see below) |

`EXPO_PUBLIC_*` values are inlined into the bundle when you publish, not taken from the build, so publish with
the same `.env` / environment the build had.

An update only reaches phones whose build has the same **channel** and **runtime version**. The runtime version
is the app version (`runtimeVersion.policy: "appVersion"`, today `1.3.0` from `apps/mobile/package.json`). Bump it
only together with a rebuild, otherwise the installed build stops receiving updates.

| Build | How it is built | Channel |
| --- | --- | --- |
| KassaLite | Xcode, `bun run lite:ios` ([KASSALITE.md](KASSALITE.md)) | `lite` (set in `app.config.ts`) |
| Full app | `eas build --profile production` / `preview` | `production` / `preview` (from `eas.json`) |
| Full app, local Xcode build | `UPDATES_CHANNEL=<name> expo run:ios --configuration Release` | whatever `UPDATES_CHANNEL` says |

## One-time setup

1. **Link an EAS project** (free Expo account): in `apps/mobile` run `npx eas-cli@latest login`, then
   `npx eas-cli@latest init`. It cannot write into the dynamic `app.config.ts`, so paste the id it prints into
   `apps/mobile/readynative.config.ts` → `app.easProjectId` (and your Expo username into `app.owner` if `init`
   asks for an owner). Commit that change: every later build and publish reads it.
2. **Rebuild once** so the installed app contains the update URL and channel. KassaLite: `bun run lite:ios`, then
   Run in Xcode with the **Release** configuration (Debug loads from Metro and ignores updates). Full app: a new
   `eas build`. Builds made before the project id was set have no update URL and never check for updates.

## Publishing

```bash
bun run ota lite "Fix activity list"          # KassaLite
bun run ota production "Fix activity list"    # full app, production builds
bun run ota preview                           # full app, preview builds
```

`scripts/ota.ts` runs `eas update` in `apps/mobile` with the matching `APP_VARIANT` (KassaLite needs it for its
routes and the passkey / Stripe stubs), channel and platform. Anything after `--` goes to `eas update` as is.

On the phone, the app checks for an update every time it starts and downloads it in the background; the
download is applied on the **next** start. So: open the app, wait a few seconds, swipe it away, open it again.
The full app also shows an "Update ready" banner with a Restart button (`src/components/updates-banner.tsx`).

To undo a bad update, publish the previous commit again, or use `npx eas-cli@latest update:republish` /
`update:rollback` from `apps/mobile`.

## KassaLite and the 7-day limit

An update does not extend the free provisioning profile: KassaLite still has to be re-run from Xcode about once a
week. Re-running installs the bundle Xcode built from your checkout; the app then picks up the latest `lite`
update again on its next starts.

## When an update does not arrive

Open KassaLite → **Settings → App updates**. It says which case you are in:

- **"Over-the-air updates are off in this build"**: the installed app was built without an EAS project id
  (`bun run lite:ios` also prints this). Do the one-time setup above, then build again. No publish can reach it.
- **"Debug build"**: Xcode ran the Debug configuration, which loads JS from Metro. Run Release.
- **"Channel lite, version X"**: the client works. If **Check for updates** says "Up to date", the update was
  published to another channel or runtime version: publish with `bun run ota lite` and keep
  `apps/mobile/package.json`'s version equal to the one shown. Otherwise the button downloads it and restarts.
