# KassaLite

A build of the Kassa app that **shows your real Apple Pay purchases, with a nudge, on your own iPhone**. Signed with a **free Apple ID** ("Personal Team"), so no push, Associated Domains, Apple Pay entitlement, passkeys or in-app payments.

```
Apple Pay purchase ──> iOS Shortcut "Transaction" automation ──> POST /api/capture/shortcut (Kassa server)
                                                                            │
KassaLite (Activity tab) <── GET /api/capture/recent  ─────────────────────┘
        └─ local notification when the app sees a new purchase
```

What is in it: everything in the web app that needs no passkey. Home, Chat (with voice: the mic records AAC .m4a and POST `/api/agent/transcribe` transcribes it; hidden on builds without expo-audio), Activity (refreshed every 30 s while open), Recipients, Bills, Send, Add money, Linked accounts (linking opens the web app), Your data, Credit record, Face ID lock, Shortcut install, Real/Simulated data, server URL, updates, and **Demo & proof** pages in the in-app browser.

Not in it: anything passkey-signed, remote push, in-app Apple Pay, passkey sign-in. Those hand off to the web app ([Approvals](#approvals)).

## Pairing

1. In the full app or web app: **Settings → Pair KassaLite**, confirm with your passkey.
2. A QR code and 8-character code appear (single use, expires after **2 minutes**; **New code** for another).
3. On the iPhone, scan the QR (opens `kassalite://pair?code=…&server=…`) or type code and server URL in KassaLite.
4. Check the server and tap **Pair this iPhone** (a link never pairs by itself).

The device session (scope `lite`) and the **Shortcut token** go to the iOS Keychain (this device only). **Sign out** deletes them; if the phone is lost, revoke the Shortcut token in the full app (Settings → Apple Pay → Kassa).

## Shortcut setup

**Settings → Apple Pay Shortcut** → **Set up Apple Pay logging**:

1. Checks server and key (POST `/api/capture/shortcut` `{"test": true}`, nothing logged).
2. A build **with** the Kassa action writes its Keychain copy; any other build copies **one link**, `https://<server>/api/capture/shortcut?key=<token>` (clipboard only on this tap).
3. Opens the ready-made Shortcut if `EXPO_PUBLIC_KASSALITE_SHORTCUT_URL` is set ([The ready-made Shortcuts](./shortcuts.md#the-ready-made-shortcuts)), else Shortcuts, and says what is left:
   - ready-made Shortcut: "Tap Add Shortcut and paste when asked. Then Automation → + → Transaction → Run Immediately → choose “Log to Kassa”."
   - Kassa action: "Automation → + → Transaction → Run Immediately → New Blank Automation → add “Log Payment in Kassa”."
   - hand-built: "Automation → + → Transaction → Run Immediately → New Blank Automation → Get Contents of URL → paste."

**Manual setup** has the full steps and **Copy steps for AI** (a prompt without the key). **Fix in Shortcuts** opens Shortcuts, not the ready-made Shortcut again (that would add a second copy).

The card then polls GET `/api/devices` every 5 s for the first real tap and checks each line (tap reached Kassa, Merchant, Amount, Card, Place, Logged) from `lastCheck`: **Your last Apple Pay tap arrived complete**, or **Kassa got your tap: N things to fix** with **Fix in Shortcuts**.

**Test it live** (also in the web app, Settings → Payment taps) is the check to trust: press **Start**, pay at a terminal, confirm the amount and notification. After 90 s with nothing it lists the usual causes (Run After Confirmation, card not selected, online payment, another server, a mistyped key). See [Shortcuts](./shortcuts.md). Code: `src/lib/shortcut-test.ts`, `src/screens/settings/shortcut-test-screen.tsx`.

**Data shown**: **Real** (default) shows and notifies only real captures; **Simulated** adds `NOTIF_SIM` and seed purchases (a seeded one has `createdAt` equal to `occurredAt`). Stored on the iPhone (`src/lite/data-mode.ts`).

**Log Payment in Kassa** is an App Intent (`apps/mobile/plugins/log-payment-intent/LogPaymentIntent.swift`, added by `plugins/with-log-payment-intent.js` for `APP_VARIANT=lite`; no entitlement needed). It POSTs `{merchant, amount, card, street?, city?, country?}` with `X-Kassa-Client: log-payment-action`, shows the nudge (parameter **Show Notification**) and runs without opening the app. Server and key come from a Keychain copy (`src/lite/intent-config.ts`) readable *after first unlock*, since the automation can run on a locked phone. Only Xcode builds made after it was added have it; the app checks `Linking.canOpenURL("kassalite-log-payment://")` and otherwise offers the link path.

## Build it with a free Personal Team

Needs a Mac with Xcode and an iPhone with a cable.

```bash
bun install
bun run lite:ios        # generates apps/mobile/ios-lite and opens the workspace in Xcode
```

`lite:ios` (`scripts/lite.ts`) prebuilds with `APP_VARIANT=lite` into `apps/mobile/ios-lite/` (git-ignored), excluding the `react-native-passkeys` and `@stripe/stripe-react-native` native modules, and pins `APP_VARIANT=lite` in `ios-lite/.xcode.env.local`.

In Xcode:

1. **KassaLite** target → **Signing & Capabilities** → **Team**: your Personal Team (add the Apple ID under Xcode → Settings → Accounts first).
2. If `app.kassa.lite` is taken, change the **Bundle Identifier** in Xcode only, e.g. `app.kassa.lite.<yourname>`.
3. Keep the capability list empty; a free team cannot sign Push or Associated Domains.
4. Choose your iPhone. Keep the Run configuration on **Release**: Debug loads JS from Metro on :8081 and crashes with `'StripeSdk' could not be found`.
5. **Run** (Cmd-R).

### On the iPhone

- **Developer Mode**: Settings → Privacy & Security → Developer Mode → On, restart, confirm (appears after Xcode's first install attempt).
- "Untrusted Developer": Settings → General → VPN & Device Management → your Apple ID → **Trust**.
- Accept **Face ID** and **Notifications**.

### Updates without Xcode

JS and UI changes: `bun run ota lite "message"` (channel `lite`). See [guide/ota-updates.md](./ota-updates.md).

### The 7-day limit

A free provisioning profile **expires after 7 days**. Re-run from Xcode (Cmd-R) weekly; pairing and data survive. Keep the bundle id stable (free accounts get few App IDs per week).

### Debug build (optional)

`cd apps/mobile && APP_VARIANT=lite bunx expo start`. Don't run `pod install` in `ios-lite` yourself (the passkey and Stripe pods come back); run `bun run lite:ios` again.

## Server requirements

- A **stable HTTPS host** (KassaLite refuses `http://`; the code is bound to the host): a named tunnel, `CLOUDFLARED_TUNNEL=<name>`, `PHONE_HOST=<hostname>`, `bun run dev:all` ([Run locally](./run-locally.md#on-a-phone)). A quick tunnel breaks pairing and the Shortcut on restart.
- The **Mac must stay running** at every purchase; failed taps are not resent.
- To change server: Settings → Server → Save; pair again if it is another installation.

## Approvals

Passkey-gated writes answer 428 `PASSKEY_REQUIRED` with `details.approveInWebApp` (`approveInWebAppUrl` in `apps/api/src/modules/auth/session.ts`), which KassaLite opens in an auth session (`src/lite/approve.ts`):

| Refused write                                 | Opens                           |
| --------------------------------------------- | ------------------------------- |
| `POST /orders/:id/approve`                    | `/order/<proposalId>?from=lite` |
| `POST /payees/:id/verify-callback`            | `/payees/<id>?from=lite`        |
| `POST /funding-sources/:id/confirm`           | `/linked-accounts?from=lite`    |
| `PATCH /settings`, `PUT /budgets/*`, unfreeze | `/settings?from=lite`           |
| mandates                                      | `/payees?from=lite`             |
| `POST /privacy/erase`                         | `/data?from=lite`               |
| recovery codes                                | `/backup-codes?from=lite`       |
| Shortcut device keys                          | `/shortcut?from=lite`           |
| `POST /pair/start`                            | `/pair-lite?from=lite`          |
| business purchase-order signing               | `/orders?from=lite`             |
| onboarding confirm                            | `/onboarding/review?from=lite`  |
| anything else                                 | `/?from=lite`                   |

`from=lite` pages show a "Back to KassaLite" bar (`src/components/lite-return-bar.tsx`) and return via `kassalite://order/<id>` or `kassalite://linked-accounts`; the app then refreshes.

## Where the code is

| What | Where |
| --- | --- |
| Variant switch | `apps/mobile/app.config.ts` (`APP_VARIANT=lite`) |
| Routes | `apps/mobile/src/app-lite/` |
| Screens | `apps/mobile/src/screens/lite/` |
| Pairing, notifier, lock, server URL, approvals | `apps/mobile/src/lite/` |
| Passkey / Stripe stubs | `apps/mobile/src/lite/stubs/`, aliased in `apps/mobile/metro.config.js` |
| "Pair KassaLite" in the full app | `apps/mobile/src/screens/settings/pair-lite-screen.tsx` |
| Project generator | `scripts/lite.ts` (`bun run lite:ios`) |
