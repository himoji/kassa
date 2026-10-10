# Google Play Developer Program Policies - checklist for a ReadyNative app

Last reviewed: 2026-09-15

Source: https://support.google.com/googleplay/android-developer/answer/9859455 (policy center)
Also read:
- Data safety: https://support.google.com/googleplay/android-developer/answer/10787469
- User Data: https://support.google.com/googleplay/android-developer/answer/10144311
- Permissions: https://support.google.com/googleplay/android-developer/answer/9888170
- Account deletion: https://support.google.com/googleplay/android-developer/answer/13327111
- Subscriptions: https://support.google.com/googleplay/android-developer/answer/140504
- Payments / Play billing: https://support.google.com/googleplay/android-developer/answer/10281818
- Target API level: https://support.google.com/googleplay/android-developer/answer/11926878
- Families: https://support.google.com/googleplay/android-developer/answer/9893335
- Store listing / metadata: https://support.google.com/googleplay/android-developer/answer/9898842
- Restricted content: https://support.google.com/googleplay/android-developer/answer/9878810
- Ads: https://support.google.com/googleplay/android-developer/answer/9857753

Distilled on the date shown. Play policies have no numbered sections; cite them by name
(`Play User Data`, `Play Subscriptions`). The policy-center overview page (9859455) rendered
only its "prepare your app for review" content when fetched, so the group list below comes
from its sidebar and the individual policy pages; the Restricted content page rendered only
policy names for several items (child endangerment, financial services, gambling, illegal
activities, health, blockchain, AI-generated content) - those bullets are titles, not
distilled rules.

## Restricted content

- **Inappropriate content** - no sexual content, hate speech, gratuitous violence, violent
  extremism, exploitation of sensitive events, bullying, dangerous products (weapons,
  explosives), facilitation of marijuana, tobacco or alcohol sales. Look at: seeded content,
  onboarding imagery, example screens shipped by mistake.
- **Child endangerment**, **Financial services** (personal loans must disclose terms),
  **Real-money gambling**, **Illegal activities**, **Health content and services**,
  **Blockchain-based content**, **AI-generated content**, **Age-restricted content** - policy
  titles only from the fetched page; read the policy if the app is in one of these areas.
- **User-generated content** - apps hosting UGC need in-app reporting, blocking, moderation and
  terms. Look at: any screen posting content to your backend.

## Privacy and security

### User Data

- **Privacy policy** - comprehensive, on a public non-geofenced URL that names the app or
  developer, linked in Play Console **and inside the app**; covers access, collection, use,
  sharing, retention and contact details. Look at: `readynative.config.ts` `urls.privacy` and the
  Settings row that opens it.
- **Prominent disclosure and consent** - when collection of personal or sensitive data would
  not be expected (background location, contacts, device identifiers, data sold or shared),
  show an in-app disclosure during normal use - not only in the policy - that says what is
  collected and why, then get affirmative consent (a tap or checkbox; navigating away is not
  consent; no auto-dismiss) **before** the runtime permission prompt. Look at: onboarding /
  first-run screens before `requestForegroundPermissionsAsync` etc.
- **Handling** - limit to what users expect; request runtime permissions before access; HTTPS
  or better in transit; no selling personal or sensitive data. Look at: `EXPO_PUBLIC_*` URLs
  are https; tokens in `expo-secure-store`.
- **SDKs** - you are responsible for every SDK's behaviour and must be able to show compliance
  on request. Look at: `.readynative.json` `analytics`, `crash`, `push`, `payments`, `auth`.
- **Identifiers** - do not link the Android advertising ID to persistent device identifiers
  (IMEI, SIM serial) or to personal data without consent; respect the user's ad-id reset and
  opt-out. Look at: `AD_ID` permission in `android.permissions` only when an ads/analytics SDK
  needs it.
- **Health data** - personal and sensitive; same disclosure rules.

### Data safety form

- Required for every app (grace ended 2022-07-20). Declare per data type whether it is
  **collected** (transmitted off-device) and **shared** (to a third party other than a service
  provider acting for you), whether it is required or optional, and the purpose (app
  functionality, analytics, developer communications, advertising, fraud/security,
  personalisation, account management).
- On-device-only processing and ephemeral in-memory processing need not be declared.
- **Third-party SDKs count** - declare what PostHog / Amplitude / Sentry / RevenueCat / Adapty /
  Supabase / Clerk / Expo notifications collect. Start from the table `bun run doctor --store`
  prints and check each vendor's disclosure page it links.
- Security: state whether data is encrypted in transit, and whether users can request deletion
  (badge allowed if you provide a mechanism or auto-delete within 90 days).
- Inaccurate answers lead to blocked updates or removal; only the developer is responsible.
- Data types (13): location, personal info, financial info, health and fitness, messages,
  photos/videos, files and docs, calendar, contacts, app activity, web browsing, app info and
  performance (crash logs, diagnostics), device or other IDs.

### Permissions and sensitive APIs

- **Only what the core features need**, requested in context, not up front. Look at:
  `android.permissions` in `app.config.ts` - every entry maps to a dependency and a feature;
  remove leftovers.
- **Location** - coarse before fine, foreground before background; background location needs
  a declaration form and a feature users see; never location for ads only. From 2027-01-27 the
  location button becomes the recommended minimum scope and a Contacts permission policy
  applies.
- **Photos / videos** - on Android 13+ use the system photo picker (`expo-image-picker` does)
  instead of `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` unless broad access is core.
- **All files access** (`MANAGE_EXTERNAL_STORAGE`), **Package visibility**
  (`QUERY_ALL_PACKAGES`), **SMS / Call log**, **Accessibility**, **VPN** - restricted; need the
  Permissions Declaration Form and a use case that qualifies. Look at: none of these appear in
  `android.permissions` unless the app is that kind of app.
- **Body sensors** - from Android 16 use the granular `health.READ_*` permissions.

### Account deletion

- Any app that lets users **create an account** (in-app or by sending them to a web flow) must
  offer an in-app path to delete the account and its data, prominent and easy to find (account
  settings), and enter a **web link** for deletion requests in the Data safety form that works
  without reinstalling the app. Deadline passed 2024-05-31; non-compliant apps face removal.
- Deletes everything the Data safety form says is collected; retention for security, fraud or
  legal reasons must be disclosed in the privacy policy.
- Look at: `.readynative.json` `auth` not `none` → Delete account in
  `src/screens/settings/settings-screen.tsx` calling `deleteAccount()` in `src/lib/auth.ts`,
  plus a live deletion-request page at your `urls.website`.

## Monetization

### Payments / Play billing

- **Google Play's billing system is required** for in-app purchases of digital goods and
  services: subscriptions, unlocked functionality, ad-free versions, virtual items, cloud
  storage. Look at: `.readynative.json` `payments`: `revenuecat` / `adapty` wrap Play Billing and
  are fine; `stripe` for **digital** unlocks on Android is a likely rejection.
- **Not required** for physical goods, services consumed outside the app (rides, gym
  memberships, groceries), gift cards, 1:1 live services (tutoring, coaching), regulated
  clinical services, and peer-to-peer tips where 100% reaches the creator.
- **No steering** - inside the app you may not lead users to another payment method (links,
  buttons, "cheaper on our site") unless a regional alternative-billing program applies (EEA,
  India, South Korea, US under court order). Look at: `Linking.openURL` to checkout pages in
  paywall / settings / onboarding.

### Subscriptions

- Before purchase, show **price, billing period, renewal terms, trial or intro-offer terms and
  when they end, and how to cancel** - on the purchase screen itself; users must not take an
  extra action to see them. Look at: `src/screens/paywall/paywall-screen.tsx` renders period
  and renewal copy next to `priceString`.
- Names and benefits must be accurate: a paid plan may not be called "Free trial"; benefits
  list real features, not the discount.
- Clear UI to pick a plan; users can manage and cancel online at any time (Play handles
  cancellation; the app links to it).
- Restore: previously bought entitlements are honoured on reinstall; keep the Restore action.

### Ads

- No ads that mimic system UI or notifications; full-screen interstitials must be closeable
  after 15 seconds and never appear unexpectedly mid-task; no forcing an ad click or personal
  data before use; no "made for ads" apps. Ads match the content rating; location for ads
  needs disclosure; respect the advertising-ID opt-out.

## Store listing

- **Title** ≤ 30 characters; no emoji, repeated symbols or ALL CAPS (unless the brand); no
  "#1", "best", "free", prices or "Editor's choice" in title, icon or developer name; no fake
  notification dots on the icon. Look at: `readynative.config.ts` `app.name`.
- **Description and screenshots** reflect the real app experience; no unattributed
  testimonials, keyword stuffing, or claims like "best game ever"; suitable for a general
  audience. Screenshots for phone plus 7" and 10" tablets when the app is offered on tablets.
- **Content rating** questionnaire answered from actual content; ads and UGC declared.
- **App content** declarations in Play Console (privacy policy, ads, target audience,
  data safety, news apps, government apps, financial features) all completed before review.

## Families

- Declare the **target audience** honestly in Play Console; Google verifies against the app's
  content and imagery.
- Apps targeting children: only Families self-certified ads SDKs, no personalised ads, no
  transmitting AAID / IMEI / persistent identifiers, no precise location, only child-approved
  APIs and SDKs, COPPA / GDPR-K compliance; mixed-audience apps use a neutral age screen before
  anything not child-safe. Look at: PostHog / Amplitude / Sentry are not child-approved by
  default - gate them behind the age screen or drop them for a child-directed app.
- Teacher Approved is opt-in and not guaranteed.

## Target API level

- New apps and updates must target **Android 16 (API 36)** or higher (deadline 2026-08-31;
  extension available to 2026-11-01). Apps targeting API 34 or lower are hidden from new users
  on devices newer than their target. Wear OS, TV, Automotive and XR have their own, usually
  one-lower, thresholds.
- Look at: the Expo SDK's `targetSdkVersion` (`expo-build-properties` in `app.config.ts`
  `plugins` if overridden). `doctor --store` reports the value the SDK compiles with.

## What changed recently

Dated items on the fetched pages: target API 36 required from 2026-08-31 (extension to
2026-11-01); location-button minimum scope and the Contacts permission policy effective
2027-01-27; Body sensors migration from Android 16; account-deletion enforcement since
2024-05-31; Data safety grace ended 2022-07-20. The other pages state no dates.
