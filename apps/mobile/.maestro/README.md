# Maestro E2E flows

[Maestro](https://maestro.mobile.dev) drives the app on a simulator, emulator or device by visible text, so flows need no `testID`s.

## Run

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash   # once
bunx expo run:ios   # or run:android - a dev build must be installed and the Metro server running
bun run test:e2e                                  # all flows, dev variant
bun run test:e2e .maestro/flows/theme-switch.yaml # one flow (any extra arg goes to maestro)
bun run test:e2e --variant preview                # dev | preview | prod (aliases: development, production)
bun run test:e2e --dry-run                        # print the maestro command, run nothing
```

`bun run test:e2e` (`scripts/e2e.ts`) passes these variables from `readynative.config.ts`:

- `${APP_ID}` - `app.ios.bundleId` plus the variant suffix from `app.config.ts` (`.dev`, `.preview`, none for production).
- `${APP_NAME}` - `app.name` as rendered _inside_ the app (no ` (Dev)` suffix; the springboard label is `${APP_DISPLAY_NAME}`).

Expo Go cannot be targeted: flows assume the app's own id.

## Flows

- `flows/theme-switch.yaml` - **Settings** → **Appearance** → **Dark**, asserts "Currently Dark", restores **Light** / **System**. Skips onboarding if shown.

## Notes

- Strings come from `src/locales/en/`; the app starts in the device language, so keep the simulator in English.
- Kassa's own flows (passkey onboarding, paying a bill) are covered by Jest and the API sim (`docs/evidence/sim/`), not Maestro.
