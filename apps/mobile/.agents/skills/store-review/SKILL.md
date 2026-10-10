---
name: store-review
description: Review an Expo app against App Store Review Guidelines and Google Play policies before submitting; cites the guideline for every finding
version: 1.0.0
---

# Store review

This skill is the judgement half of the pre-submission check. `bun run doctor --store` does the
mechanical half (permission strings, ATT, privacy URLs, restore purchases, account deletion
route, Android permissions, target SDK, a Data safety draft). You read what it found, then read
the screens it cannot judge - paywall copy, onboarding, sign-in, settings - against the two
reference checklists, and write the report.

Nothing here guarantees approval. Reviewers are people, the guidelines change, and both stores
reject for reasons no checklist predicts. The report says "likely rejection", never "will be
rejected", and "fine", never "approved".

## When to run

- Before every store submission, App Store and Play alike - including the first TestFlight /
  internal-testing build that will be promoted to review.
- After adding or changing auth (a social login, account creation), payments (a paywall, a
  product, a trial), or a permission (location, camera, photos, contacts, notifications,
  tracking).
- After changing `readynative.config.ts` `urls` or `app.config.ts` `ios.infoPlist` /
  `android.permissions`.

## Tier gate

Read `.readynative-tier.json` at the repo root first. If `tier` is `"starter"` (the command itself
prints "doctor --store is part of ReadyNative Pro" in that case), the check is part of Pro: say so in one
line and stop. Do not improvise the checks from memory in a Starter tree.

## Procedure

### a. Run the mechanical check

```bash
bun run doctor --store
```

Read every finding. Each has a severity (`✗` blocking, `!` warning, `i` info), an id, a platform,
a `guideline` citation (`App Store Review 5.1.1(v) · Play Account deletion`), a `file:line`, and
a `fix`. Blocking maps to **likely rejection**, warning to **fix before submit**, info to a note. Copy them into the report as-is - do not re-derive
them - and keep the Data safety draft table it prints for step e.

### b. Read the tree

In this order, and read them - do not grep for keywords and stop:

1. `readynative.config.ts` - `urls.privacy`, `urls.terms`, `urls.support`, `store.*`, `app.*`.
2. `app.config.ts` - `ios.infoPlist` (every `NS*UsageDescription`, `ITSAppUsesNonExemptEncryption`),
   `android.permissions`, `plugins` (permission-bearing modules and their purpose strings).
3. `.readynative.json` - which options were applied; it tells you which screens exist.
4. `src/app/**` - every route. Note which exist: `paywall/`, `(auth)/sign-in`, `(auth)/sign-up`,
   `onboarding/`, `(tabs)/settings`.
5. The screens behind them: `src/screens/paywall/paywall-screen.tsx`,
   `src/screens/auth/*.tsx`, `src/screens/onboarding/onboarding-screen.tsx`,
   `src/screens/settings/settings-screen.tsx`.
6. `src/lib/auth.ts`, `src/lib/payments.ts`, `src/lib/analytics.ts`, `src/lib/push.ts` - what the
   shims actually call, so you know which SDKs collect what.

### c. Walk the checklists

Open `references/apple-review.md` and `references/play-policy.md`. For every bullet decide one of:

- **likely rejection** - the guideline is clear and the tree violates it (no account deletion
  with account creation; a paywall that unlocks digital content through Stripe Checkout on iOS;
  a permission with no purpose string).
- **fix before submit** - not a rejection on its own, but reviewers flag it often or it makes
  the app look unfinished (placeholder `com.acme.app`, `urls.support: "mailto:"`, a "free"
  label on a paid plan, screenshots that show the login screen).
- **fine** - checked and compliant, or not applicable to this app (say which).

Every line carries the guideline id (`App Store Review 3.1.2(c)`, `Play Subscriptions`) and a `file:line`. Prefer
quoting the exact line over describing it.

### d. Optionally look at the screens

If the iOS Simulator tool is available, run the app and screenshot the paywall, the sign-in
screen, the first permission prompt and the settings screen. Judge the copy against the
references, in particular:

- price **and** billing period **and** renewal terms visible on the paywall itself, not behind
  a link (`3.1.2(c)`, Play Subscriptions);
- a Restore Purchases action that is visible without scrolling on a small device (`3.1.1`);
- no "Free" / "Free trial" wording on anything that charges (`3.1.2(a)`, Play Subscriptions
  naming), and trials say how long and what they become;
- the permission prompt's purpose string reads as a reason, not a restatement of the
  permission (`5.1.1(ii)`);
- push, location and tracking are not required to proceed (`5.1.2(i)`).

Skip this step rather than guess when the simulator is not available; say you skipped it.

### e. Write the report

Two parts, in this order.

**Findings** - one table, sorted likely rejection → fix before submit → fine:

| Severity | Guideline | Where | What | Fix |
| --- | --- | --- | --- | --- |
| likely rejection | App Store Review 5.1.1(v) · Play Account deletion | `src/screens/settings/settings-screen.tsx:88` | Sign-up exists (`(auth)/sign-up`) but no delete-account action in the app | Add a "Delete account" row that calls `auth.deleteAccount()` and revokes the Sign in with Apple token |
| fix before submit | App Store Review 3.1.2(c) | `src/screens/paywall/paywall-screen.tsx:191` | Shows `priceString` only; no period or renewal line | Render `subscriptionPeriod` next to the price and a one-line "renews automatically, cancel any time in Settings" |
| fine | Play Target API level | `app.config.ts` | Expo SDK targets API 36 | - |

Put every `doctor --store` finding in the table with its own row, then your own. Do not merge
two findings into one row.

**Metadata checklist** - the things no file in the tree can show, each with a yes / no / not yet:

- Screenshots per device class actually required by the App Store Connect / Play Console
  listing (iPhone, iPad if `supportsTablet`, 7" and 10" tablet on Play) that show the app in use,
  not the login or splash screen (`2.3.3`, Play Store listing).
- Age rating questionnaire answered from the app's real content (`2.3.6`, Play content rating).
- Export compliance: `ITSAppUsesNonExemptEncryption` set in `app.config.ts`, matching the
  App Store Connect answer.
- Demo / test account for reviewers in App Review notes when any screen sits behind sign-in
  (`2.1(a)`); the backend stays up during review.
- Data safety form answers drafted from the `doctor --store` table; every third-party SDK in
  `.readynative.json` accounted for (Play Data safety).
- App Privacy answers in App Store Connect match the same table (App Privacy details).
- Privacy policy URL live, public, not geofenced, reachable from inside the app
  (`5.1.1(i)`, Play User Data).
- Support URL live and answered by a person (`1.5`).
- Account deletion web link entered in the Data safety form when accounts exist
  (Play Account deletion).

Close with one sentence: this is a checklist review, not a promise of approval.

## Rules

- Cite the guideline id on every finding. A finding with no id is an opinion; leave it out or
  mark it "note".
- Show the exact line (`file:line` and the code) whenever the finding is about code.
- Report what `doctor --store` reported verbatim; your job is the parts it cannot see.
- Never claim approval is guaranteed or that a fix "will pass".
- Do not edit the app during the review. Fixing is a separate step the user asks for.
- If `.readynative-tier.json` says Starter, say the check is Pro and stop.
- The references carry `Last reviewed:` dates. If today is more than a quarter past that date,
  say so at the top of the report and tell the user to re-read the source URLs before trusting a
  borderline call.
