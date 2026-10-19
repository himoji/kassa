# KassaLite

KassaLite is a small build of the Kassa app for one job: **show your real Apple Pay purchases, with a nudge, on your own iPhone**. It is signed with a **free Apple ID** (a "Personal Team"), so it has no paid-developer features: no push notifications, no Associated Domains, no Apple Pay entitlement, no passkeys, no in-app payments.

```
Apple Pay purchase ──> iOS Shortcut "Transaction" automation ──> POST /api/capture/shortcut (Kassa server)
                                                                            │
KassaLite (Activity tab) <── GET /api/capture/recent  ─────────────────────┘
        └─ local notification when the app sees a new purchase
```

What is in it (since 2026-10-15 it matches the web app for everything that does not need a passkey):

- **Home**: balances, cards, recipients by category, bills, budgets (read only), month summary, Insights.
- **Chat**, **Activity** (purchases and nudges, refreshed every 30 s while the app is open) and **Settings**.
- **Recipients** and **Bills**: add a recipient (it cools for 24 h like anywhere else), find your school, pay a bill.
- **Send** and **Add money**, from your Kassa balance or a linked card or bank, with the live quote.
- **Linked accounts** (the list; **Link a card** / **Link a bank account** open that form on the web app, which confirms it with the passkey and sends you back), **Your data** (export) and **Credit record**, from Settings.
- Face ID lock, Shortcut install, data shown (Real or Simulated), server URL, updates, sign out.
- **Voice in the chat** (since 2026-10-19): the mic in the composer records (AAC .m4a, expo-audio), POST `/api/agent/transcribe` turns it into text, and the transcript is sent as a normal chat turn after a short pause (tap **Edit** to change it first). Needs a KassaLite built after expo-audio was added (it also carries the microphone permission); on an older build the mic is simply hidden. The web app records in the browser and sends 16 kHz WAV.
- **Demo & proof** (Settings): the evidence room, the ledger check and, on a demo server, the Stage, the card terminal, the QR wallet, the shop till and the school portal, opened in the in-app browser.

Not in it, by design: anything that signs with a passkey (approving a payment, linking a card or bank, confirming a recipient, changing rules and budgets, backup codes), remote push (KassaLite notifies when it is open or comes to the foreground, the Shortcut itself shows the instant banner), Apple Pay inside the app, passkey sign-in. Those steps hand off to the web app (see Approvals).

## Pairing

KassaLite has no sign-in screen. You pair it from the full Kassa app or the web app:

1. In the full app or the web app open **Settings → Pair KassaLite** and confirm with your passkey.
2. A QR code and an 8-character code appear. The code works once and expires after **2 minutes** (**New code** makes another).
3. On the iPhone, scan the QR code with the camera (it opens `kassalite://pair?code=…&server=…`), or open KassaLite and type the code and the server URL.
4. KassaLite shows the server it will pair with. Check it and tap **Pair this iPhone**. A link only fills the form, it never pairs by itself.
5. The server returns a device session (access and refresh token, session scope `lite`) and the **Shortcut token**. Both are kept in the iOS Keychain (this device only), the server URL in the app's local storage.

**Sign out** (Settings) deletes the tokens on the iPhone. Revoke the Shortcut token in the full app (Settings → Apple Pay → Kassa) if the phone is lost.

## Shortcut setup

The Shortcut is the capture path: it must be set up once. The reference is [guide/shortcuts.md](./shortcuts.md). KassaLite does it from **Settings → Apple Pay Shortcut** with one button, then checks the result on the first real tap.

**Set up Apple Pay logging** (the one button):

1. Checks the server and key from this iPhone: POST `/api/capture/shortcut` `{"test": true}` with the Shortcut's key (nothing logged or recorded). A revoked key or an unreachable server is reported here, before the person goes to Shortcuts.
2. Readies the automation's only input. A build **with** the Kassa action: writes the action's Keychain copy, nothing to paste. Any other build: copies **one link**, `https://<server>/api/capture/shortcut?key=<token>` (the key in the URL, so no header; the server log redacts `key`). The key goes on the clipboard only on this tap and is never part of a URL the app opens.
3. Opens the **ready-made Shortcut** when the bundle has its iCloud link (`EXPO_PUBLIC_KASSALITE_SHORTCUT_URL`, see [The ready-made Shortcuts](./shortcuts.md#the-ready-made-shortcuts)), Shortcuts otherwise. One line then says what is left:
   - ready-made Shortcut: "Tap Add Shortcut and paste when asked. Then Automation → + → Transaction → Run Immediately → choose “Log to Kassa”."
   - Kassa action: "Automation → + → Transaction → Run Immediately → New Blank Automation → add “Log Payment in Kassa”."
   - hand-built: "Automation → + → Transaction → Run Immediately → New Blank Automation → Get Contents of URL → paste."

The full steps, and **Copy steps for AI** (a prompt for ChatGPT or another assistant that walks the person through it tap by tap; it never contains the key), sit behind **Manual setup**, closed by default. **Fix in Shortcuts** after a tap that needs a fix opens Shortcuts itself, never the ready-made Shortcut again (that would add a second copy).

iOS does not let an app create a personal automation, so the Transaction automation itself is always made in Shortcuts by the person.

**The tap check.** The card then waits (it polls GET `/api/devices` every 5 s while open) for the first real Apple Pay tap and reports line by line, from the device's `lastCheck`:

| Line | Right | Needs a fix |
| --- | --- | --- |
| Tap reached Kassa | the time (the automation triggered) | (nothing arrives: the card keeps waiting) |
| Merchant | the merchant Kassa logged | empty: set Merchant to Shortcut Input › Merchant |
| Amount | the amount Kassa logged | empty, or not readable (unsupported currency) |
| Card | received | optional tip: Card or Pass, for card fees |
| Place | received | optional tip: Get Current Location |
| Logged | in Activity (or "already logged", "refund") | not logged |

All required lines right: **Your last Apple Pay tap arrived complete** (it describes that one tap, not the setup today), with a success haptic and toast if it arrives while the screen is open. Otherwise **Kassa got your tap: N things to fix**, a **Fix in Shortcuts** button, and the card keeps checking until the next tap is right. A tap whose automation sends a merchant but no amount reaches the server as `INCOMPLETE`, and the Shortcut's own notification already says what to fix.

**Test it live** (under the card, and in the web app under Settings → Payment taps) is the check to trust before relying on it. Press **Start**, pay with Apple Pay at a terminal, and the screen lists every request made with any of your Shortcut keys since Start, read from the server (GET `/api/devices` `recentChecks`): refused ones too (a revoked key, a body that is not JSON or lacks the fields, a failure while logging), which fields arrived, the merchant and amount Kassa logged, and the caller (the iOS Shortcuts app, the KassaLite action, or a browser or script, which does not count). It passes only when a purchase from the Shortcut was logged after Start **and** you confirm that the amount is your purchase and that the iPhone showed Kassa's notification. A run by hand proves the link and key, not the Apple Pay trigger, and says so. If nothing arrives within 90 s it lists the usual causes (Run After Confirmation, card not selected, online payment, another server, a mistyped key, which Kassa cannot see). Code: `src/lib/shortcut-test.ts`, `src/screens/settings/shortcut-test-screen.tsx`.

**Data shown** (Settings): **Real**, the default, shows only purchases that really happened in Activity (Apple Pay taps from the Shortcut or the action, text, voice and screenshot captures) and only those notify. **Simulated** also shows the demo world: notification-simulator purchases (`source: NOTIF_SIM`) and the demo seed's purchases. GET `/api/capture/recent` has no demo flag, so a seeded purchase is recognised by its `createdAt` being equal to its `occurredAt` (the seed writes both from one value; a live capture's `createdAt` comes later). The choice is kept on the iPhone (`src/lite/data-mode.ts`). The month summary above the list comes from the server and is not filtered.

**Log Payment in Kassa** is an App Intent compiled into the app (`apps/mobile/plugins/log-payment-intent/LogPaymentIntent.swift`, added to the app target by `plugins/with-log-payment-intent.js` for `APP_VARIANT=lite`). App Intents need no entitlement, so a free Personal Team signs it. It POSTs `{merchant, amount, card, street?, city?, country?}` to `<server>/api/capture/shortcut` with the Shortcut's key and `X-Kassa-Client: log-payment-action` (empty amount: a test run), posts the reply's `nudgeTitle` / `nudgeBody` as a local notification when KassaLite may notify (parameter **Show Notification**, on by default) and returns `nudge` as its result. It runs in the background without opening KassaLite. Server and key come from a Keychain copy the app writes at launch, after pairing and after a server change (`src/lite/intent-config.ts`, removed on sign out): unlike the session's key item it is *after first unlock, this device only*, because the Transaction automation can run while the iPhone is still locked after an Apple Pay tap — the same exposure as the key a hand-built Shortcut stores in Shortcuts.

The action exists only in a KassaLite built (in Xcode) after it was added; an over-the-air update cannot add it. The same plugin declares the URL scheme `kassalite-log-payment` (and lists it in `LSApplicationQueriesSchemes`), and the app asks `Linking.canOpenURL("kassalite-log-payment://")` before offering the action, so a newer JS bundle on an older build offers the link path instead.

## Build it with a free Personal Team

You need a Mac with Xcode and an iPhone with a cable. Nothing here runs on Linux.

```bash
bun install
bun run lite:ios        # generates apps/mobile/ios-lite and opens the workspace in Xcode
```

`lite:ios` (`scripts/lite.ts`) runs `APP_VARIANT=lite expo prebuild --clean -p ios` and moves the result to `apps/mobile/ios-lite/` (git-ignored; an existing `apps/mobile/ios/` is left alone). It excludes the `react-native-passkeys` and `@stripe/stripe-react-native` native modules from autolinking for this run only, and pins `APP_VARIANT=lite` in `ios-lite/.xcode.env.local` so Xcode bundles the KassaLite routes (`src/app-lite`).

In Xcode:

1. Select the **KassaLite** target → **Signing & Capabilities** → **Team**: your Apple ID (Personal Team). Add the Apple ID under Xcode → Settings → Accounts first.
2. If `app.kassa.lite` is taken (free teams share one global namespace), change the **Bundle Identifier**, for example `app.kassa.lite.<yourname>`. Only change it in Xcode; there is nothing to change in the code.
3. The capability list must stay empty (no Push, no Associated Domains). If Xcode adds one, remove it: a free team cannot sign it.
4. Choose your iPhone as the run destination. `lite:ios` sets the scheme's Run configuration to **Release**, so the app runs without a Metro dev server. Keep it that way: a Debug build loads its JS from whatever Metro is on :8081 (usually `dev:all`'s full-app Metro) and crashes with `'StripeSdk' could not be found`.
5. **Run** (Cmd-R).

### On the iPhone

- **Developer Mode** must be on: Settings → Privacy & Security → Developer Mode → On, restart, confirm. The switch only appears after Xcode tried to install an app once.
- **Trust the certificate**: the first launch says "Untrusted Developer". Settings → General → VPN & Device Management → your Apple ID → **Trust**.
- **Face ID**: the app asks the first time; accept.
- **Notifications**: accept when KassaLite asks (needed for the local notifications).

### Updates without Xcode

Once an EAS project id is set and the app was built with it, JS and UI changes reach the installed KassaLite with `bun run ota lite "message"` (channel `lite`). Native changes still need Xcode. See [guide/ota-updates.md](./ota-updates.md).

### The 7-day limit

A free provisioning profile **expires after 7 days**: the app then refuses to open. Re-run it from Xcode (Cmd-R with the phone connected) about once a week. Your pairing and data survive, because the bundle id does not change. A free account can also have only a few apps and App IDs per week, so keep the bundle id stable.

### Debug build (optional)

Debug needs Metro: `cd apps/mobile && APP_VARIANT=lite bunx expo start`. Without `APP_VARIANT=lite` Metro serves the full app's routes.

Note: the autolinking exclusion lives in `package.json` only while `lite:ios` runs. If you run `pod install` in `ios-lite` yourself, the passkey and Stripe pods come back; add `--exclude`-equivalent by running `bun run lite:ios` again instead.

## Server requirements

- The server URL must be a **stable HTTPS host**. KassaLite refuses `http://`, the Shortcut needs a real certificate, and the 8-character code is bound to that host. Use a named tunnel: set `CLOUDFLARED_TUNNEL=<name>` and `PHONE_HOST=<hostname>` and run `bun run dev:all` (see the README, "Running on a phone"). A quick tunnel changes its host on every start, which breaks both the paired phone and the Shortcut.
- The **Mac must stay running** (awake, tunnel up, API up) whenever a purchase happens. A tap made while the server is unreachable is not sent again by the Shortcut.
- Changing the server later: Settings → Server → Save, then sign out and pair again if the new server is a different installation.

## Approvals

A KassaLite session cannot sign with a passkey, so every passkey-gated write (approve an order, link a card or bank, confirm a recipient) answers HTTP 428 `PASSKEY_REQUIRED` with `details.approveInWebApp`. The server builds that link (`approveInWebAppUrl` in `apps/api/src/modules/auth/session.ts`) to the page that finishes the step, tagged `?from=lite`:

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

KassaLite opens it in an auth session (`src/lite/approve.ts`, wired once in the lite root layout through `onApiError`). On the order page, a `from=lite` approval ends with a "Back to KassaLite" box and sends the person to `kassalite://order/<id>`, which closes the browser by itself. Every web page opened with `from=lite` shows a "Back to KassaLite" bar on top (`src/components/lite-return-bar.tsx`), and the linked accounts page also takes `intent=card|bank` to open that form at once and returns to `kassalite://linked-accounts` when it closes. Back in the app, orders, balances, bills and linked accounts are refreshed. Before 2026-10-16 the linked accounts screen in KassaLite only said "view only" and the fallback link opened the web app's home, which looked like a blank page to people in the in-app browser. In the Lite build the order screen's approve button posts `{}` on purpose, so this round trip starts on the first tap.

## Where the code is

| What                                                           | Where                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Variant switch (bundle id, name, scheme, plugins, router root) | `apps/mobile/app.config.ts` (`APP_VARIANT=lite`)                        |
| Routes                                                         | `apps/mobile/src/app-lite/`                                             |
| Screens                                                        | `apps/mobile/src/screens/lite/`                                         |
| Pairing, notifier, lock, server URL, approvals                 | `apps/mobile/src/lite/`                                                 |
| Passkey / Stripe stubs for the JS bundle                       | `apps/mobile/src/lite/stubs/`, aliased in `apps/mobile/metro.config.js` |
| "Pair KassaLite" in the full app                               | `apps/mobile/src/screens/settings/pair-lite-screen.tsx`                 |
| Project generator                                              | `scripts/lite.ts` (`bun run lite:ios`)                                  |
