# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are tagged
`v<version>-sdk<expo major>`, the Expo SDK the release targets.

## [Unreleased]

## [1.3.0-sdk57] - 2026-09-28

### Added

- A weather demo is the app you see on first run (`bun install && bun ios`): the forecast where you are, an hourly strip, a 10-day list, detail tiles, city search and saved cities, °C / °F, pull to refresh, share and "notify me", a Pro gate on the 10-day forecast. It runs on every module choice and keylessly on [Open-Meteo](https://open-meteo.com); `setup` removes it unless you pass `--with-examples`.
- Native navigation throughout: the tab bar is `NativeTabs` (Liquid Glass on iOS 26, Material 3 on Android), and the demo's Cities tab uses a large-title native stack, `Stack.SearchBar` and `Link.Menu` context menus. `bun run gen screen --tab` writes a `<NativeTabs.Trigger>`.
- `location` category: `expo-location` (foreground position and reverse geocoding behind `@/lib/location`, resolving `null` instead of throwing) or `none`. In the `default` and `saas` presets.
- `widgets` category: `expo-widgets` (an iOS home-screen widget in `@expo/ui` SwiftUI views, fed by `widgets.update()`) or `none`. In the `saas` preset; needs a dev build.
- Six languages in both i18n modules - English, Spanish, Russian, Chinese (Simplified), Portuguese and Arabic - with right-to-left layout: picking Arabic mirrors the app and restarts it. Settings lists languages as rows.
- `@/lib/cache`: an offline cache on the storage adapter; the last good response paints on the first frame and without a connection.
- Native feel in every UI stack: `toast.show()` is a native iOS toast (Burnt) in dev and store builds, with the themed card as the Expo Go / Android / web fallback; `Pressable` runs on Pressto (UI-thread press animation on a gesture-handler button); `<Screen scroll>` is keyboard-controller's `KeyboardAwareScrollView`. The root layout mounts `GestureHandlerRootView` and `KeyboardProvider`.
- `Sheet` primitive in the UI contract: `@expo/ui`'s native bottom sheet (SwiftUI on iOS, Material 3 on Android, a drawer on web), with detents. Works in Expo Go.
- Live Activities: `widgets.activity.start / update / end` with a Lock Screen + Dynamic Island layout in `src/widgets/app-activity.tsx` (widgets/expo-widgets).
- Docs: [No ios/ or android/ folders](https://readynative.app/docs/native-without-native-folders) - how Continuous Native Generation and over-the-air updates fit together.

### Changed

- The Explore tab is gone; the weather demo's Cities tab replaces it.
- The onboarding Maestro flow ends on the tab bar instead of the Home title.

## [1.2.1-sdk57] - 2026-09-27

### Removed

- The GitHub Actions workflows (`.github/workflows/ci.yml`, `eas-preview.yml`): the repo no longer runs CI or EAS builds on GitHub. Build and submit with `eas build` / `eas submit`; add your own CI if you want one ([Expo's guide](https://docs.expo.dev/eas-update/github-actions/)). `setup` still re-renders a `ci.yml` you kept from 1.2.0 for your package manager.

### Fixed

- `bun run typecheck` on a fresh clone: Expo's global types are now referenced from the committed `expo-types.d.ts` (the generated `expo-env.d.ts` is gitignored and only appears after `expo start`).
- `bun run test` before setup: the UI stack's jest mocks (the `@/global.css` stub) load without `.readynative.json`.
- `docs/graph.json` / `docs/ARCHITECTURE.md` now match the tree you receive, so `bun run gen:graph --check` passes out of the box.
- README links point to the docs at https://readynative.app/docs/.

## [1.2.0-sdk57] - 2026-09-25

First public release, on Expo SDK 57 (Expo 57.0.24, React Native 0.86, Expo Router 57, React 19.2).

### Added

- Module system: every optional feature lives in `modules/<category>/<option>/`; `bun run setup` applies a preset (`minimal`, `default`, `saas`) or a per-category selection, generates `src/providers.tsx`, `src/lib/env.ts`, `.env.example` and `.readynative.json`, and stays idempotent. Setup then finalizes the tree into a plain Expo Router app (`modules/` and the setup tooling removed, `src/ui` → `src/components/ui`); `--keep-modules` keeps the module system.
- Five UI stacks behind one component contract: NativeWind 4 (the default: stable `4.2.7` on Tailwind 3, in every preset), NativeWind 5 (RC · Tailwind 4, `5.0.0-rc.0`, one `--ui nativewind5` away), Tamagui, Unistyles and plain StyleSheet, with `bun run gen:theme` deriving each stack's theme from `src/theme/tokens.ts` and the brand in `readynative.config.ts`.
- App-layer modules: data (TanStack Query, Apollo, SWR), state (Zustand, Jotai), storage (expo-sqlite/kv-store, MMKV, AsyncStorage), forms (react-hook-form), i18n (i18next, Lingui; English and Spanish, with a language picker in Settings), onboarding flow.
- Service modules (Pro), each with a no-op shim for its `none` option: auth (Supabase, Clerk, Better Auth), payments (RevenueCat, Stripe, Adapty), analytics (PostHog, Amplitude), crash (Sentry), push (expo-notifications), backend (API routes).
- Account deletion on every auth module (Supabase via a shipped `delete_user()` migration, Clerk `user.delete()`, Better Auth `deleteUser`) and a confirm-guarded "Delete account" row in Settings.
- Payments: `presentPaywall()` shows RevenueCat's native paywall only to users without the entitlement and falls back to `/paywall` (auto-renewal disclosure, "Compare all plans", "Manage subscription"); RevenueCat follows the signed-in user. A guide covers web checkout next to the App Store: RevenueCat and Stripe Checkout with one `pro` entitlement across both rails (`examples/snap-recipe` is the reference).
- Feature flags on the analytics contract: `analytics.isFeatureEnabled(key)`, `analytics.getFeatureFlag(key)` and `useFeatureFlag(key)` (PostHog; Amplitude and `none` read `undefined`).
- App Tracking Transparency with the analytics modules: `expo-tracking-transparency`, `src/lib/tracking.ts`, and a one-time prompt when `features.tracking` is on in `readynative.config.ts`.
- Privacy and consent: a `consent` category whose default asks once (EU/EEA, UK, Switzerland, Canada, Brazil, or no device region) with Analytics / Crash reports toggles. PostHog, Amplitude and Sentry follow the choice, and Sentry events are scrubbed of IP, email, username, headers and cookies. Settings → Privacy adds "Do not sell or share my personal information" and "Export my data"; sign-out and account deletion wipe local data.
- Store paperwork from the modules: every module declares its privacy data. Setup composes the Apple privacy manifest (`ios.privacyManifests`) and the Play Data safety rows, and `bun run gen:privacy` writes a privacy-policy draft to `docs/privacy-policy.md`.
- `bun run doctor`: env keys (with a dashboard link and a docs guide for each missing one), native toolchains and runtime versions in one checklist; store identity (placeholder ids, urls, store ids, EAS link and login, the placeholder app icon) is listed under "Before you ship" as warnings, so a fresh setup exits 0. `bun run doctor --store` (Pro) checks the app against the App Store Review Guidelines and Google Play policies, with a guideline id and a fix per finding.
- Package manager of your choice: setup detects bun / pnpm / yarn / npm (or `--pm`), installs with it, drops the other lockfiles and renders CI for it. `scripts/*.ts` run under plain Node 22.18+ (`setup` and `doctor` check it first); bun is the recommended default.
- First run in Expo Go: `start` is `expo start --go` when every selected module runs there and `expo start --dev-client` otherwise; `start:dev` always targets the dev build. Module tools such as `push:test` survive setup and run under any package manager.
- `bun run gen:graph` writes `docs/graph.json` + `docs/ARCHITECTURE.md`, the app as one graph (modules, providers, routes, screens, libs, env keys); CI checks it stays current.
- Agent skills in `.agents/skills/` (`readynative`, `expo-router`, `expo-native-ui`, `expo-data-fetching`; Pro adds `store-review`).
- `examples/` (Pro): Field Notes and Snap Recipe, standalone apps that boot with no `.env` (`cd examples/notes && bun install && bun ios`).
- Always-on extras: icon / splash / favicon from `assets/brand/icon.png` (`bun run gen:assets`), universal and app links (`bun run gen:links`), updates banner, store review prompt, clipboard / share / browser helpers, root error boundary, and the iOS 27 UIScene life cycle (`plugins/with-scene-lifecycle.js`).
- CI and EAS workflows: typecheck, lint, test and the architecture graph on every push; EAS preview builds on pull requests and production build + submit on your own `v*` tags.
- Every preset and every module option is set up, typechecked, linted, bundled and tested in CI before a release ships.
- Free tier: `readynative-free`, a public MIT repo with one fixed stack (Expo Router, NativeWind 4, TanStack Query, Zustand, `expo-sqlite/kv-store`), already set up: no `modules/`, no setup, no EAS / CI / scripts.
- Licensing: Starter and Pro ship under the ReadyNative Commercial License, the Free tier under MIT; third-party notices (the Expo template's MIT text) are in `LICENSES/`.
