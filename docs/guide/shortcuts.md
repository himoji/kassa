# Payment taps → Kassa (iOS Shortcut, Android forwarder)

An iOS Shortcuts **Personal Automation** with the **Transaction** trigger sends each Apple Pay tap's merchant, amount and (optionally) location to Kassa, which logs it and replies with a notification:

> **Logged HUF 2,100.00 at Blue Bottle**
> Today 10:59 · Váci utca 10, Budapest · 2nd visit this month · paid via Square
> Probably Blue Bottle Coffee, a café
> Eating out 62% left this month (HUF 6,200.00), about HUF 295 a day
> Tip: About HUF 295 a day keeps eating out on track.

The lines: time, place, visits this month and processor prefix (`SQ *`, `SUMUP *`, `ZETTLE_*`...); a model's guess of the place (AI consent, hidden when unsure); the budget left, or for an unbudgeted category the month against a usual month and spending against income; known card markup or DCC warnings; "New card saved: Visa ••4821 (billed in HUF)" for an unknown `card` (billing currency assumed to be home currency; re-add it in Cards if wrong); and a tip (AI consent) that may only quote Kassa-computed numbers. `AI_PAYMENT_NOTES=false` turns guesses and tips off; they are skipped if the model exceeds `PAYMENT_NOTE_TIMEOUT_MS` (4 s default) or fails.

Capture **only logs**. It never approves, creates or blocks a payment (invariant I6).

## What you need

- iPhone with **iOS 17 or later**, a card in **Apple Wallet**.
- A Kassa server reachable over HTTPS: a deployed one, or `bun run phone` (tunnel).

## Fastest: add the ready-made Shortcut

If your build carries the iCloud link ([The ready-made Shortcuts](#the-ready-made-shortcuts)):

1. **Settings → Payment taps → Kassa** → **Create token** → **Add the “Log to Kassa” Shortcut** (copies your link and opens the Shortcut).
2. **Add Shortcut**, paste the link when asked.
3. **Automation** → **+** → **Transaction** → your Wallet cards → **Run Immediately** → **Next** → **Log to Kassa**. (No app can create this automation for you.)

Then pay once and use **Test it live**. Without the link the button is hidden: follow sections 1 to 3.

## 1. Create a device token in Kassa

1. **Settings → Payment taps → Kassa** → **Create token**.
2. **Copy "Bearer …" header value**. Shown **once** (only its SHA-256 hash is stored); if lost, revoke and create another.
3. Note the **Endpoint**: `https://<your-kassa-host>/api/capture/shortcut`.

## 2. Create the automation on the iPhone

1. **Shortcuts** → **Automation** → **+** → **Transaction**.
2. **Card**: the Wallet cards to report; categories and merchants **Any**.
3. **Run Immediately** (optionally turn off **Notify When Run**) → **Next** → **New Blank Automation**.

## 3. Add the actions

### Action 1: Get Contents of URL

**URL**: the endpoint. Under **›**: **Method** `POST`; **Headers** `Authorization` = `Bearer <token>`; **Request Body** `JSON` with three **Text** fields:

| Key | Value: tap the field, choose **Shortcut Input**, then tap it again and pick |
| --- | --- |
| `merchant` | **Merchant** |
| `amount` | **Amount** |
| `card` | **Card or Pass** (the label may differ by iOS version) |

**Optional** `date`: **Current Date**, **Date Format** **ISO 8601**, **Include Time** on. Otherwise Kassa uses the arrival time (the tap, with Run Immediately).

**Optional** location: add **Get Current Location** **before** this action, then **Text** fields from the **Current Location** variable:

| Key | Detail |
| --- | --- |
| `street` | **Street** |
| `city` | **City** |
| `country` | **Country** (or **ISO Country Code**) |
| `latitude` | **Latitude** (optional) |
| `longitude` | **Longitude** (optional) |

Run it once by hand and choose **Allow While Using App** (or **Settings → Privacy & Security → Location Services → Shortcuts**), or it stops here. Coordinates are rounded to about 100 m; street and coordinates are deleted after 90 days (`RETENTION_DAYS_CAPTURED_TEXT`).

### Action 2: Get Dictionary Value

**Get Value for** `nudge` **in** **Contents of URL**.

### Action 3: Show Notification

Body: **Dictionary Value**. For a bold first line, use `nudgeTitle` and `nudgeBody` (two **Get Dictionary Value** actions) as title and body. Tap **Done**.

## 4. Try it

Pay with Apple Pay: the notification appears, the spend is in **Activity**, and **Settings → Payment taps → Kassa** shows "Last tap received …".

## What Kassa accepts

`amount` as iOS shows it: `1 290 Ft`, `Ft 1,290`, `HUF 1,290.00`, `1.290 Ft`, `1 290,00 HUF`, `€4.50`, `4,50 €`, `₸2 500`, `2 500 тг`, `¥38.00`, `CN¥38.00`, `38.00 元`, `$4.50`, or a JSON number (home currency unless `"currency": "EUR"` is sent).

- Negative (`-€4.50`): a refund, not spending.
- Only KZT, HUF, EUR, USD, CNY. Others (`£4.50`) are **not logged**. `¥` is CNY; `"currency"` makes it explicit.
- Duplicates (same tap, or the same spend from a bank notification) merge: "Already logged".

### Response

| Field | Content |
| --- | --- |
| `nudge` | The whole notification in English, one line per part (title first) |
| `nudgeTitle` | The first line: amount and place |
| `nudgeBody` | The other lines |

| `status` | Meaning |
| --- | --- |
| `LOGGED` | A new spend |
| `MERGED` | A duplicate of a spend already logged |
| `IGNORED_INCOMING` | A refund |
| `UNPARSED` | Kassa could not read the payment |
| `TEST` | A test run: nothing logged (see below) |
| `INCOMPLETE` | A merchant without an amount: nothing logged (see below) |

### Test run and incomplete taps

No amount, never logged:

- `{"test": true}` (KassaLite's check): `TEST`, “Kassa is connected”; device not marked used.
- `merchant` also empty (run by hand): `TEST`, recorded (`lastUsedAt`, `lastCheck.kind = "TEST"`).
- merchant, no amount: `INCOMPLETE`, notification says to set Amount to Shortcut Input › Amount; `lastCheck.kind = "INCOMPLETE"`.

### The key in the URL

Instead of the header: `https://<host>/api/capture/shortcut?key=<token>` (one paste; the server log redacts `key`).

### The ready-made Shortcuts

Kassa (Settings → Payment taps) and KassaLite can open a published Shortcut: **Log to Kassa** (taps) and **Ask Kassa** (voice). They are not in the repository because a `.shortcut` file must be Apple-signed: someone publishes each once and its iCloud link goes into the bundle. Until then the buttons copy the link for a hand-built Shortcut.

| Shortcut | Bundle variable | Its import question takes |
| --- | --- | --- |
| Log to Kassa | `EXPO_PUBLIC_KASSALITE_SHORTCUT_URL` (used by both apps) | `https://<host>/api/capture/shortcut?key=<token>` |
| Ask Kassa | `EXPO_PUBLIC_KASSA_VOICE_SHORTCUT_URL` | `https://<host>/api/capture/voice?key=<token>` |

Publish **Log to Kassa**:

1. New shortcut named **Log to Kassa**.
2. Add the section 3 actions with **no header** (the URL carries the key). If Shortcut Input offers no Merchant, Amount and Card or Pass outside an automation, stop: that iOS version cannot run this route.
3. **ⓘ** → **Setup** → **Add Question** on the URL field: "Paste the link KassaLite copied". Check the URL field is empty in the shared copy; revoke your token if not.
4. **Share** → **Copy iCloud Link** (Mac, macOS 13+: **File → Share → Copy iCloud Link**). Links are public; a changed Shortcut needs a new link.
5. Set `EXPO_PUBLIC_KASSALITE_SHORTCUT_URL=https://www.icloud.com/shortcuts/<id>` in `apps/mobile/.env` (or the EAS environment) and ship with `bun run ota lite "…"`. Other values are ignored.
6. Test on a second iPhone first: set up from KassaLite, pay once, read the tap check. If Merchant or Amount is "empty", do not ship the link.

**Ask Kassa**: the same with the [Voice](#voice-hey-siri-ask-kassa) Shortcut, question "Paste the voice link Kassa copied", variable `EXPO_PUBLIC_KASSA_VOICE_SHORTCUT_URL`. No automation needed.

### Tap check (GET /api/devices)

Each request (Shortcut or KassaLite action, `X-Kassa-Client: log-payment-action`) records on its device `lastUsedAt` and `lastCheck`: time, kind (`TEST`, `PAYMENT`, `FORWARDED`, `INCOMPLETE`), which of `merchant`, `amount`, `card`, `place` arrived (presence only), `status` and transaction id. GET `/api/devices` returns the newest device's `lastCheck`.

### Live test (GET /api/devices `recentChecks`)

Each token keeps its newest 20 requests (`devices.recent_checks`), refused ones too: `REVOKED_KEY`, `BAD_BODY` (problem, no values), `FAILED`. Each records the caller's User-Agent product (`BackgroundShortcutRunner` for an automation; a browser or `curl` does not count). Only accepted requests move `lastUsedAt`. **Settings → Payment taps → Test it live** (web and KassaLite) shows them from Start and passes only on a logged Shortcut purchase you confirm (amount, notification). Unknown tokens cannot be shown.

### Errors

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 401 | `DEVICE_TOKEN_REQUIRED` | The `Authorization` header is missing |
| 401 | `DEVICE_TOKEN_INVALID` | The token is wrong or has been revoked |
| 400 | — | Malformed body, e.g. `amount` missing |
| 429 | — | Rate limit: the sensitive tier, 30 per minute per IP |

## Voice: “Hey Siri, Ask Kassa”

1. Shortcuts → **+** (a Shortcut, not an automation), named **Ask Kassa**.
2. **Record Audio**: Start **Immediately**, Finish **On Tap**.
3. **Base64 Encode** the Recorded Audio.
4. **Get Contents of URL**: `https://<your-kassa-host>/api/capture/voice?key=<token>` (Settings → Payment taps → **Copy voice link**, or KassaLite → Settings → **Ask Kassa by voice**). POST, JSON: `audio` = Base64 Encoded, `format` = `m4a`.
5. **Get Dictionary Value**: `reply`.
6. **Speak Text** (or **Show Result**).

Audio goes to `VOICE_MODEL` (default `openrouter:qwen/qwen3.8-omni-flash`) as an OpenRouter `input_audio` part (`m4a`, `aac`, `mp3`, `wav`, `aiff`, `ogg`, `flac`). If m4a is refused, add **Encode Media** (Audio Only, AIFF) and send `format` = `aiff`. Max 3 MB. `text` (from **Dictate Text**) skips the voice model. The transcript runs as a **read-only** agent turn (no `propose_order`, purchase-order draft or pickers; the token can only `log_expense`), needs AI consent, and always returns 200 `{ok, transcript, reply, conversationId}`.

## Limits

- **Wallet cards only**: not physical cards, typed card numbers or bank-app wallets.
- **The amount may be a pre-authorisation** (hotels, fuel, tips); a later statement line settles it (`/capture/settlement`).
- **Logs only, never blocks** (I6).
- **No retry when offline**: add the spend in the app, or let a notification or statement capture it.
- **DCC and fee warnings** use only known data (an earlier DCC settlement at the merchant, a home-currency charge right after foreign spending, the card's measured markup). The real fee is known at settlement.

## Online and in-app Apple Pay (iPhone)

Online and in-app Apple Pay trigger no automation. Forward the bank's payment **SMS** instead:

1. **Shortcuts** → **Automation** → **+** → **Message**; **Message Contains** a word in every payment SMS (or the bank as **Sender**); **Run Immediately**.
2. **Get Contents of URL**, same URL, method and header; JSON `text` = **Shortcut Input › Content**, `app` = **Shortcut Input › Sender**.
3. **Get Dictionary Value** (`nudge`) and **Show Notification**.

Kassa's parsers cover Kazakh banks, Alipay / UnionPay bank SMS, WeChat Pay, Revolut and Wise, plus the Reader with AI consent. Non-payments get `UNPARSED`; a tap plus SMS merges (`MERGED`).

## Android: Google Wallet, Samsung Wallet, Alipay, WeChat Pay

One notification-forwarding automation covers every wallet, same token and endpoint.

1. Install **MacroDroid** or **Tasker**.
2. Trigger **Notification received** for Google Wallet, Samsung Wallet, Alipay, WeChat and your bank's app; grant notification access.
3. **HTTP request**: `POST` the endpoint, `Authorization: Bearer <token>`, `application/json`:

   ```json
   {"app":"[notification_app_package]","title":"[notification_title]","text":"[notification]"}
   ```

   (Tasker: `%anapp`, `%antitle`, `%antext`.) Optional `"latitude"`, `"longitude"` (MacroDroid `[last_loc_lat]`, `[last_loc_long]`; Tasker `%LOCN`), `"city"`, `"country"`.
4. Optional: show `nudgeTitle` and `nudgeBody`.

Formats (`apps/api/src/modules/capture/parsers/wallet.ts`); other apps go to the SMS parsers:

| App | Example notification |
| --- | --- |
| Google Wallet | title `Cafe Frei`, text `€4.50 with Visa ••1234` (older: `Paid 1 290 Ft at Spar with Mastercard •••• 9876`) |
| Samsung Wallet | text `Payment of ₸2 500 at Magnum completed` |
| Alipay | `你在 便利店 消费 ¥32.50` |
| WeChat Pay | `支付成功 ¥45.00 收款方：面馆` |

## Revoking a token

**Settings → Payment taps → Kassa** → **Revoke**. Immediate (`401 DEVICE_TOKEN_INVALID`); no passkey, as it tightens (I8).

| Call (user session) | What it does |
| --- | --- |
| `POST /api/devices/shortcut` | Creates a token |
| `GET /api/devices` | Lists the active Shortcut devices and the time of the last Shortcut capture |
| `DELETE /api/devices/:id` | Revokes a token |
