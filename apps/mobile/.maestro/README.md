# Maestro E2E flows

[Maestro](https://maestro.mobile.dev) drives the app on a simulator/emulator or device by visible text, so the flows need no `testID`s and work with every UI stack.

## Run

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash   # once
bunx expo run:ios   # or run:android - a dev build must be installed and the Metro server running
bun run test:e2e                                  # all flows, dev variant
bun run test:e2e .maestro/flows/theme-switch.yaml # one flow (any extra arg goes to maestro)
bun run test:e2e --variant preview                # dev | preview | prod (aliases: development, production)
bun run test:e2e --dry-run                        # print the maestro command, run nothing
```

`bun run test:e2e` (`scripts/e2e.ts`) reads `readynative.config.ts` and passes the flows their variables, so a rebrand needs no edit here:

- `${APP_ID}` - `app.ios.bundleId` plus the variant suffix from `app.config.ts` (`.dev`, `.preview`, none for production).
- `${APP_NAME}` - `app.name` as it is rendered _inside_ the app (no ` (Dev)` suffix; the suffixed springboard label is `${APP_DISPLAY_NAME}`).

Expo Go cannot be targeted: the flows assume the app is installed under its own id.

## Flows

- `flows/theme-switch.yaml` - opens **Settings**, taps **Dark** and asserts the "Currently Dark" readout (then restores **Light** / **System**). Skips onboarding when it is still showing.

## Notes

- Strings come from the English locale (`src/locales/en/`; the i18n module starts in the device language, so keep the simulator in English or translate the assertions).
- Kassa's own flows (onboarding with a passkey, paying a bill) are covered by the Jest suite and the API sim (`docs/evidence/sim/`), not by Maestro yet.
