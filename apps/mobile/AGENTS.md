This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Start here

1. Read `docs/ARCHITECTURE.md` - the generated map of this app (mermaid graph + a table per
   kind: routes, screens, `@/lib` shims, providers, stores, env keys, services).
   `docs/graph.json` is the same thing machine-readable.
2. Run `bun run gen:graph` after adding or removing a route, a screen, a `@/lib` shim, a
   provider, a store, a hook or an env key. `bun run gen:graph --check` fails when it is stale.
3. Whatever the generator cannot see (a background job, a webhook, an external service),
   annotate where you wrote it:
   `// @graph node=job:digest kind=feature label="Nightly digest" edges=lib:api/client`
   or add it to `docs/graph.extra.json`, which is merged verbatim.
4. `.agents/skills/readynative` has the long version: the shim contract, the generated files and
   the commands.

## Expo has changed - do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt - an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use the package manager whose lockfile is in the repo (`bun.lock` → `bun`/`bunx`,
`pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `package-lock.json` → `npm`/`npx`).
bun is the default the docs show.

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add - resolves SDK-compatible versions
npx expo start --go         # dev server in Expo Go (`--dev-client` for a dev build; the `start` script picks)
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` - every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Layout

- `src/components/ui` (import as `@/components/ui`) - the primitive kit (`Screen`, `Box`, `Text`, `Button`, `Row`, `List`, …). Prefer it over raw `react-native` views in screens; the components' prop types live in `src/components/ui/types.ts`.
- `src/screens` holds screen bodies, `src/app` only routes to them.
- `readynative.config.ts` is the app's identity/brand/urls config; `src/theme/tokens.ts` derives the design tokens from it (`gen:theme` regenerates the stylesheet).
- `scripts/` holds the app's own tools (`doctor`, `gen`, `gen:*`, `test:e2e`, plus the tools of modules you picked - `push:test` only exists with `push=expo-notifications`); run them through `package.json`.

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) - no local Xcode or Android Studio required. Run EAS CLI as `npx eas-cli@latest <command>`; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand - configure native behavior in `app.config.ts` (driven by `readynative.config.ts`) and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- `examples/` holds standalone example apps. They are separate projects with their own `package.json` - never import from them, and do not count them when you lint, typecheck or test this app.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
