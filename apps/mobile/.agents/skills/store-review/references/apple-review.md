# App Store Review Guidelines - checklist for a ReadyNative app

Last reviewed: 2026-09-15

Source: https://developer.apple.com/app-store/review/guidelines/
Also read:
- Account deletion: https://developer.apple.com/support/offering-account-deletion-in-your-app/
- App Privacy details: https://developer.apple.com/app-store/app-privacy-details/
- Tracking / ATT: https://developer.apple.com/app-store/user-privacy-and-data-use/

Distilled from the pages above on the date shown. Every bullet is: the guideline id, what it
says, what to look for in this tree. The guidelines are a living document; re-fetch the source
before trusting a borderline call.

## 1 Safety

- **1.1 Objectionable content** - nothing defamatory, discriminatory, gratuitously violent,
  sexual, or capitalising on current events. Look at: onboarding copy, sample content in
  `src/screens/**`, any seeded data.
- **1.1.6 False information** - no fake features, prank or trick functionality. Look at:
  example screens left in the app (`src/app/examples/**` shipped by mistake).
- **1.2 User-generated content** - if users post content the app needs: a filter for
  objectionable material, a report mechanism with timely response, a way to block users, and
  published support contact. Look at: any screen that submits text/images to your backend;
  `readynative.config.ts` `urls.support`.
- **1.3 Kids category** - no outbound links, purchases or third-party analytics/ads without a
  parental gate. Look at: `.readynative.json` `analytics` / `crash` options if the app targets
  children.
- **1.4 Physical harm** - medical claims need disclosed methodology; no device-sensor
  diagnostics (blood pressure, glucose). Look at: health/fitness copy.
- **1.5 Developer information** - an easy way to contact support. Look at:
  `readynative.config.ts` `urls.support` (`"mailto:"` alone is a placeholder) and the Settings
  screen row that opens it (`src/screens/settings/settings-screen.tsx`).
- **1.6 Data security** - appropriate measures against unauthorised access. Look at: tokens in
  `expo-secure-store` not `AsyncStorage`; HTTPS-only `EXPO_PUBLIC_*` URLs in `.env.example`.

## 2 Performance

- **2.1(a) App completeness** - final build, no placeholder text or dead URLs, a demo account in
  App Review notes when sign-in gates anything, backend up during review. Look at:
  `readynative.config.ts` `app.name` still "ReadyNative", `com.acme.app` bundle id, empty `urls`,
  `+not-found` reachable from real navigation.
- **2.1(b) IAP completeness** - every product visible to the reviewer and working. Look at:
  products configured in RevenueCat / Adapty / App Store Connect match the ids the paywall
  reads (`src/lib/payments.ts`).
- **2.2 Beta** - betas belong on TestFlight only; nothing labelled beta in the submitted build.
- **2.3.1 Hidden features** - no dormant features; describe new functionality specifically in
  review notes. Look at: feature flags in `readynative.config.ts` `features` that hide screens.
- **2.3.2 IAP in metadata** - screenshots/description say when featured items cost extra.
- **2.3.3 Screenshots** - show the app in use, not a title, splash or login screen.
- **2.3.6 Age rating** - answer the questionnaire from actual content.
- **2.3.7 Name and keywords** - name ≤ 30 characters, no other apps' trademarks, no pricing in
  the name. Look at: `app.name` in `readynative.config.ts`.
- **2.3.8 Metadata for all audiences** - icon, screenshots, previews suitable for 4+.
- **2.3.12 What's New** - real release notes for features; "bug fixes" only for bug fixes.
- **2.4.1 iPad** - iPhone apps should run on iPad; `ios.supportsTablet` in `app.config.ts`
  means the iPad layout is reviewed and needs iPad screenshots.
- **2.4.2 Power** - no battery drain or background work beyond need. Look at: background
  location or fetch tasks.
- **2.5.1 Public APIs only** - deprecated frameworks phased out; matches the Expo SDK's
  supported iOS versions.
- **2.5.4 Background modes** - only for their stated purpose (audio, VoIP, location, task
  completion, local notifications). Look at: `ios.infoPlist.UIBackgroundModes` in
  `app.config.ts` - every entry must be justified by a feature.
- **2.5.13 Face ID** - account authentication with facial recognition must use
  `LocalAuthentication` (`expo-local-authentication`), with an alternative for under-13s.
- **2.5.14 Recording** - explicit consent and a visible indicator whenever the camera,
  microphone or screen is recorded.
- **2.5.18 Ads** - only in the main binary; age-appropriate; no behavioural targeting on
  sensitive data; interstitials clearly marked with a visible close.

## 3 Business

- **3.1.1 In-app purchase** - unlocking features, content, subscriptions or a full version
  inside the app must use IAP; no license keys, QR codes, crypto or own mechanisms. Look at:
  `.readynative.json` `payments`. `stripe` (Stripe Checkout) for **digital** content on iOS is a
  likely rejection; it is only fine for physical goods or services consumed outside the app
  (3.1.3(e)). RevenueCat / Adapty wrap StoreKit and are fine.
- **3.1.1 Restore** - purchased content and credits must be restorable; credits bought with IAP
  cannot expire. Look at: a Restore Purchases action in `src/screens/paywall/paywall-screen.tsx`
  and a `restorePurchases()` in `src/lib/payments.ts`.
- **3.1.1 Free trials (non-subscription)** - a time-based trial must be a Tier-0 non-consumable
  named "XX-day Trial", stating duration, what is lost at the end and the charge afterwards.
- **3.1.1(a) External purchase links** - only with the StoreKit External Purchase Link
  entitlement in the storefronts that allow it (US excepted); elsewhere no buttons, links or
  calls to action to buy outside the app. Look at: any `Linking.openURL` to a checkout or
  "cheaper on the web" copy in paywall / settings / onboarding.
- **3.1.2(a) Subscriptions** - ongoing value, ≥ 7 days, works on all the user's devices, no
  extra tasks to receive paid content, no removing features existing subscribers paid for, no
  bait-and-switch. Look at: the plan bullets on the paywall match what the entitlement unlocks.
- **3.1.2(b) Upgrades / downgrades** - users cannot end up subscribed to two variants of the
  same offer. Look at: subscription group configuration; paywall shows one active plan.
- **3.1.2(c) Subscription information** - before asking to subscribe, state clearly what the
  user gets for the price; Schedule 2 requires price, billing period, renewal until cancelled,
  and how to cancel. Look at: `paywall-screen.tsx` renders `priceString` **and** the period
  **and** a renewal line; Terms and Privacy links from `readynative.config.ts` `urls` are present
  and non-empty.
- **3.1.3(a) Reader apps** - previously purchased content (books, music, video, news) may be
  accessed without IAP; account-management links need the External Link Account entitlement.
- **3.1.3(b) Multiplatform** - content bought elsewhere may be used on iOS, as long as IAP is
  also offered where it applies.
- **3.1.3(c) Enterprise** - org sales only; consumer sales must use IAP.
- **3.1.3(d) Person-to-person** - real-time one-to-one services may bill outside IAP;
  one-to-many must use IAP.
- **3.1.3(e) Physical goods and services** - must use Apple Pay or card entry, **not** IAP.
- **3.1.3(f) Free stand-alone apps** - a free companion to a paid web tool is fine only with no
  in-app purchase flow or call to action.
- **3.1.5 Cryptocurrency** - wallets by organisations only; no on-device mining; no rewards for
  tasks.
- **3.2.1(vi)/(vii) Donations and gifts** - nonprofit fundraising needs Apple Pay and approval;
  person-to-person gifts skip IAP only when optional and 100% to the receiver.
- **3.2.2(x) Forced actions** - never gate functionality on rating, reviewing or downloading
  another app. Look at: `features.reviewPrompt` in `readynative.config.ts` only prompts, never
  blocks.

## 4 Design

- **4.1 Copycats** - no imitation of another app's icon, name or brand.
- **4.2 Minimum functionality** - more than a repackaged website; lasting utility. Look at:
  screens that are only a `WebView`.
- **4.2.3 Independence** - works without another app installed; discloses large first-launch
  downloads.
- **4.2.6 Templates** - template-generated apps are rejected unless submitted by the content
  owner under their own developer account. A ReadyNative app is fine when the buyer submits it as
  their own product with their own content, not as a reskin.
- **4.3 Spam** - one app, not one bundle id per city / team / variant; no near-duplicates.
- **4.5.4 Push notifications** - never required to function; no marketing pushes without
  explicit in-app opt-in and an in-app opt-out. Look at: `src/lib/push.ts` and the Settings
  toggle; onboarding must proceed when permission is denied.
- **4.8 Login services** - a third-party or social login (Google, Facebook, X, …) for the
  primary account requires an equivalent option that limits data to name and email, lets users
  hide their email, and does not collect interactions for ads without consent - in practice
  Sign in with Apple. Exempt: your own email/password system only, enterprise/education
  accounts, government IDs, clients for a specific third-party service. Look at:
  `src/screens/auth/sign-in-screen.tsx` - if `signInWithGoogle` is offered, `signInWithApple`
  must be too, on the same screen with equal prominence.
- **4.9 Apple Pay** - all material purchase information before the sale; recurring payments
  disclose term, services per period, charges and cancellation.
- **4.10 Built-in capabilities** - do not charge for push, camera, gyroscope, iCloud or other
  OS features as such.

## 5 Legal

- **5.1.1(i) Privacy policy** - a link in App Store Connect and inside the app, stating what is
  collected, how, why, that SDK partners protect it equally, retention/deletion and how to
  withdraw consent. Look at: `readynative.config.ts` `urls.privacy` non-empty and live; linked
  from Settings and the paywall and sign-in screens.
- **5.1.1(ii) Permission and purpose strings** - consent for any user or usage data; purpose
  strings clearly describe the use. Look at: `app.config.ts` `ios.infoPlist` has an
  `NS*UsageDescription` for every permission-bearing dependency (`expo-location`, `expo-camera`,
  `expo-image-picker` / media library, `expo-contacts`, `expo-notifications`,
  `expo-tracking-transparency`), and each string names the feature, not the permission.
- **5.1.1(iii) Data minimisation** - only what the feature needs; prefer the out-of-process
  picker (`expo-image-picker` with limited access) over full Photos or Contacts.
- **5.1.1(iv) Access** - respect denial; offer a manual alternative (type an address instead of
  location). Look at: screens that dead-end when a permission is denied.
- **5.1.1(v) Account sign-in and deletion** - no login when there are no account-based
  features; **if the app supports account creation it must offer account deletion in the app**;
  no personal information required unless core; social-network credentials revocable in-app.
  Look at: `.readynative.json` `auth` not `none` → a Delete account action in
  `src/screens/settings/settings-screen.tsx` (or an account screen) that calls a real
  `deleteAccount()` in `src/lib/auth.ts`. Per the account-deletion support page: easy to find
  (account settings), deletes the whole record and personal data (not deactivation),
  in-app even when sign-up is web-based, no support-call-only flow outside regulated
  industries (5.1.1(ix)), confirmation and re-authentication allowed, tell the user how long
  it takes, warn that an active subscription keeps billing and link to
  `https://apps.apple.com/account/subscriptions`, and **revoke Sign in with Apple tokens with
  the REST API** when the account used it. Effective since 2022-06-30.
- **5.1.1(vi)-(viii)** - no covert password or data harvesting; no hidden `SFSafariViewController`;
  no compiling profiles from other sources without consent.
- **5.1.1(ix) Regulated industries** - banking, health, gambling, cannabis, crypto exchanges:
  submitted by the legal entity, not an individual account.
- **5.1.1(x) Contact info** - name/email may be asked only if optional and nothing is gated on
  it.
- **5.1.2(i) Data use, sharing and tracking (ATT)** - no using, transmitting or sharing
  personal data without permission; disclose third-party sharing, including third-party AI;
  **explicit permission via App Tracking Transparency before tracking**; the app may not require
  push, location or tracking to use it. Tracking = linking app data with other companies' data
  for ads or measurement, or sharing with data brokers - including SDKs that do it for you;
  fingerprinting is prohibited outright. Look at: `.readynative.json` `analytics` (PostHog,
  Amplitude) and any ads SDK → `expo-tracking-transparency` in `plugins` with an
  `NSUserTrackingUsageDescription`, prompted before the SDK starts, and the SDK configured not
  to use IDFA when denied. Pure first-party product analytics without cross-app linking is not
  tracking, but still goes in App Privacy.
- **5.1.2(ii)-(iii)** - data collected for one purpose is not reused for another; no rebuilding
  user identity from "anonymised" data.
- **5.1.2(iv)-(v)** - no harvesting Contacts / Photos for databases or bulk messages; no
  "select all" invites. Look at: any `expo-contacts` use.
- **5.1.3 Health** - HealthKit and health data never for ads or data mining; no health data in
  iCloud; research needs consent and ethics approval.
- **5.1.4 Kids** - COPPA / GDPR-K; no third-party analytics or ads for child-directed apps;
  "for kids" wording only in the Kids category.
- **5.1.5 Location** - only when directly relevant; consent before collecting or transmitting;
  explain the purpose in-app. Look at: `expo-location` background mode justified;
  `NSLocationWhenInUseUsageDescription` states the feature.
- **5.2 Intellectual property** - no third-party trademarks, characters or media without
  rights; no Apple product imitations or Apple emoji in binaries; no downloading from YouTube,
  SoundCloud etc. Look at: `assets/brand/*`, any bundled fonts' licences.
- **5.3 Gambling and lotteries** - real-money gaming needs licences, geo-restriction and no IAP
  for credits.
- **5.6 Developer code of conduct** - honest metadata, no manipulated reviews, responsive
  support.

## App Privacy details (App Store Connect)

- Disclose every data type the app **or any SDK in it** collects (transmits off-device and
  keeps beyond the request): contact info, health, financial, location, sensitive info,
  contacts, user content, browsing history, identifiers, purchases, usage data, diagnostics,
  surroundings. Mark each as linked to the user or not, and used for tracking or not.
- Not disclosed: on-device-only processing, data de-identified before storage, auth tokens and
  IPs not retained, data discarded right after the request.
- Optional disclosure only when all four hold: not tracking, not advertising/marketing,
  infrequent and not primary functionality, explicitly entered by the user each time.
- Keep the answers current in App Store Connect whenever an SDK is added or removed - no build
  needed. The `doctor --store` Data safety draft lists the same SDKs; reuse it.

## What changed recently

The fetched guidelines page carries no "last updated" date. The account-deletion requirement
took effect 2022-06-30; ATT has been enforced since iOS 14.5. Nothing else on the fetched pages
was dated.
