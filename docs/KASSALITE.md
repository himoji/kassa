# KassaLite

KassaLite is a small build of the Kassa app for one job: **show your real Apple Pay purchases, with a nudge, on your own iPhone**. It is signed with a **free Apple ID** (a "Personal Team"), so it has no paid-developer features: no push notifications, no Associated Domains, no Apple Pay entitlement, no passkeys, no in-app payments.

```
Apple Pay purchase ──> iOS Shortcut "Transaction" automation ──> POST /api/capture/shortcut (Kassa server)
                                                                            │
KassaLite (Activity tab) <── GET /api/capture/recent  ─────────────────────┘
        └─ local notification when the app sees a new purchase
```

What is in it: Face ID lock, **Activity** (purchases and nudges, refreshed every 30 s while the app is open), **Chat** (the normal Kassa chat), **Settings** (Shortcut install, server URL, sign out). Approvals that need a passkey open the Kassa web app instead (the server answers HTTP 428 with `details.approveInWebApp`).

Not in it: remote push (KassaLite notifies when it is open or comes to the foreground, the Shortcut itself shows the instant banner), Apple Pay inside the app, passkey sign-in.

## Pairing

KassaLite has no sign-in screen. You pair it from the full Kassa app or the web app:

1. In the full app or the web app open **Settings → Pair KassaLite** and confirm with your passkey.
2. A QR code and an 8-character code appear. The code works once and expires after **2 minutes** (**New code** makes another).
3. On the iPhone, scan the QR code with the camera (it opens `kassalite://pair?code=…&server=…`), or open KassaLite and type the code and the server URL.
4. KassaLite shows the server it will pair with. Check it and tap **Pair this iPhone**. A link only fills the form, it never pairs by itself.
5. The server returns a device session (access and refresh token, session scope `lite`) and the **Shortcut token**. Both are kept in the iOS Keychain (this device only), the server URL in the app's local storage.

**Sign out** (Settings) deletes the tokens on the iPhone. Revoke the Shortcut token in the full app (Settings → Apple Pay → Kassa) if the phone is lost.

## Shortcut setup

The Shortcut is the capture path: it must be set up once. The reference is [SHORTCUT_SETUP.md](SHORTCUT_SETUP.md); KassaLite mirrors its steps in **Settings → Apple Pay Shortcut**.

1. Tap **Install Shortcut**. KassaLite copies two lines to the clipboard: the endpoint (`https://<server>/api/capture/shortcut`) and the header value (`Bearer <token>`). iCloud Shortcuts cannot take parameters, so you paste them where the Shortcut asks.
2. If the build has a Shortcut template link, the Shortcut opens next. Without one (the default), build it by hand with the steps on the screen (they are the steps of SHORTCUT_SETUP.md).
3. Shortcuts → Automation → **Transaction** → your Wallet cards → **Run Immediately**.
4. Pay with Apple Pay. The purchase appears in Activity within seconds.

The template link is `extra.shortcutTemplateUrl` in `apps/mobile/app.config.ts`. Create the Shortcut once, share it (Shortcuts → Share → Copy iCloud Link) and set `KASSALITE_SHORTCUT_TEMPLATE_URL=https://www.icloud.com/shortcuts/<id>` when you generate the project (or edit the constant). It is empty by default, and the screen then shows only the manual steps.

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
4. Choose your iPhone as the run destination. **Product → Scheme → Edit Scheme → Run → Build Configuration: Release** makes the app run without a Metro dev server.
5. **Run** (Cmd-R).

### On the iPhone

- **Developer Mode** must be on: Settings → Privacy & Security → Developer Mode → On, restart, confirm. The switch only appears after Xcode tried to install an app once.
- **Trust the certificate**: the first launch says "Untrusted Developer". Settings → General → VPN & Device Management → your Apple ID → **Trust**.
- **Face ID**: the app asks the first time; accept.
- **Notifications**: accept when KassaLite asks (needed for the local notifications).

### Updates without Xcode

Once an EAS project id is set and the app was built with it, JS and UI changes reach the installed KassaLite with `bun run ota lite "message"` (channel `lite`). Native changes still need Xcode. See [OTA_UPDATES.md](OTA_UPDATES.md).

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

A KassaLite session cannot sign with a passkey. When the chat proposes a payment, the order screen opens as usual; the approve action gets HTTP 428 `PASSKEY_REQUIRED` with `details.approveInWebApp = <origin>`, and KassaLite opens that page in the in-app browser (`src/lite/approve.ts`, wired once in the lite root layout through `onApiError`). Approve there with your passkey, then return to the app.

## Where the code is

| What | Where |
| --- | --- |
| Variant switch (bundle id, name, scheme, plugins, router root) | `apps/mobile/app.config.ts` (`APP_VARIANT=lite`) |
| Routes | `apps/mobile/src/app-lite/` |
| Screens | `apps/mobile/src/screens/lite/` |
| Pairing, notifier, lock, server URL, approvals | `apps/mobile/src/lite/` |
| Passkey / Stripe stubs for the JS bundle | `apps/mobile/src/lite/stubs/`, aliased in `apps/mobile/metro.config.js` |
| "Pair KassaLite" in the full app | `apps/mobile/src/screens/settings/pair-lite-screen.tsx` |
| Project generator | `scripts/lite.ts` (`bun run lite:ios`) |
