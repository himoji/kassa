# Payment taps → Kassa (iOS Shortcut, Android forwarder)

Each Apple Pay tap on your iPhone can be logged in Kassa by itself. An iOS Shortcuts **Personal Automation** with the
**Transaction** trigger sends the merchant and amount to Kassa. Kassa logs the spend and replies with one line,
for example:

> Logged HUF 1,290.00 at Cafe Frei · Eating out 62% left this month

The Shortcut shows that line as a notification. When Kassa knows about a card markup or DCC (dynamic currency
conversion), it adds a warning to the line.

Capture **only logs**. It never approves, creates or blocks a payment (invariant I6).

## What you need

- An iPhone with **iOS 17 or later**. The Transaction trigger was added in iOS 17.
- A card in **Apple Wallet**.
- A Kassa server the iPhone can reach over HTTPS: a deployed server, or `bun run phone` (tunnel) for a demo.

## 1. Create a device token in Kassa

1. In the Kassa app, open **Settings → Payment taps → Kassa**.
2. Tap **Create token**.
3. Tap **Copy "Bearer …" header value**.
   - Kassa shows the token **once**. The server stores only its SHA-256 hash, so it cannot show the token again.
   - If you lose the token, revoke the old one and create a new one.
4. Note the **Endpoint** shown on the same screen. It looks like `https://<your-kassa-host>/api/capture/shortcut`.

## 2. Create the automation on the iPhone

1. Open **Shortcuts** → **Automation** tab → **+** (top right).
2. Choose **Transaction**.
3. Under **Card**, select the Wallet cards that should report to Kassa. Leave the categories and merchants as **Any**.
4. Choose **Run Immediately**.
   - Optional: turn off **Notify When Run**, so iOS does not show its own "running your automation" banner.
5. Tap **Next** → **New Blank Automation**.

## 3. Add the actions

Add the actions below in this order.

### Action 1: Get Contents of URL

1. Set **URL** to the endpoint from step 1.4.
2. Tap the **›** arrow to show more options:
   - **Method**: `POST`
   - **Headers**: add one header:
     - Key: `Authorization`
     - Value: `Bearer <token>` (paste the value you copied in step 1.3)
   - **Request Body**: `JSON`. Add three **Text** fields:

| Key | Value: tap the field, choose **Shortcut Input**, then tap it again and pick |
| --- | --- |
| `merchant` | **Merchant** |
| `amount` | **Amount** |
| `card` | **Card or Pass** (the label may differ by iOS version) |

**Optional** `date` field:
- Add a **Text** field `date` with the value **Current Date**.
- Tap the variable, set **Date Format** to **ISO 8601** and turn on **Include Time**.
- If the date is not ISO 8601 with a time zone, Kassa ignores it and uses the time the request arrives. With Run
  Immediately, that time is the moment of the tap.

### Action 2: Get Dictionary Value

1. Set it to **Get Value for** `nudge` **in** **Contents of URL**.

### Action 3: Show Notification

1. Set the body to **Dictionary Value**.

Tap **Done**.

## 4. Try it

1. Pay with Apple Pay. A coffee is enough.
2. A moment later the Kassa line appears as a notification.
3. The spend is in **Activity**.
4. In **Settings → Payment taps → Kassa**, the device list shows "Last tap received …".

## What Kassa accepts

`amount` is the amount iOS shows in your locale. Kassa reads all of these forms:

- `1 290 Ft`, `Ft 1,290`, `HUF 1,290.00`, `1.290 Ft`, `1 290,00 HUF`
- `€4.50`, `4,50 €`, `₸2 500`, `2 500 тг`, `¥38.00`, `CN¥38.00`, `38.00 元`, `$4.50`
- A plain JSON number. Kassa then uses your home currency, unless you also send `"currency": "EUR"`.

Other rules:

- A negative amount, such as `-€4.50`, is a refund. It is noted, not counted as spending.
- Kassa supports KZT, HUF, EUR, USD and CNY. An amount in any other currency, such as `£4.50`, is **not logged**: Kassa
  does not guess. The notification then says Kassa could not read the payment.
- `¥` is read as CNY. Add `"currency": "CNY"` (or another code) to the body to make the currency explicit.
- The same tap sent twice, or the same spend also captured from a bank notification, is merged into one entry. The
  second reply says "Already logged".

### Response

The response is the usual capture result plus `nudge`, a single English line. The app shows the localised version
of the same message.

`status` has one of four values:

| `status` | Meaning |
| --- | --- |
| `LOGGED` | A new spend |
| `MERGED` | A duplicate of a spend already logged |
| `IGNORED_INCOMING` | A refund |
| `UNPARSED` | Kassa could not read the payment |

### Errors

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 401 | `DEVICE_TOKEN_REQUIRED` | The `Authorization` header is missing |
| 401 | `DEVICE_TOKEN_INVALID` | The token is wrong or has been revoked |
| 400 | — | The body is malformed, for example `amount` is missing |
| 429 | — | Rate limit: the sensitive tier, 30 per minute per IP |

## Limits

- **Wallet cards only.** The trigger fires for Apple Pay with cards in Apple Wallet. It does not fire for a physical
  card, a card number typed on a website, or a bank app's own wallet.
- **The amount may be a pre-authorisation.** Some merchants authorise one amount and charge another, such as hotels,
  fuel or tips. Kassa logs the amount iOS reports. A later bank statement line settles it (`/capture/settlement`) and
  shows the real fee.
- **Logs only, never blocks.** iOS runs the automation after the payment. Kassa cannot stop or change it, and capture
  never creates a payment (I6).
- **No retry when offline.** If the iPhone has no connection at the moment of the tap, the request fails and Shortcuts
  does not send it again. Add the spend in the app, or let a bank notification or statement capture it.
- **DCC and fee warnings come from what Kassa already knows:**
  - DCC: a DCC flag from an earlier settlement at the same merchant, or a charge in your home currency right after
    spending in a foreign currency.
  - Fee: the card's measured markup for that currency pair.

  The real fee is known only when the charge settles.

## Online and in-app Apple Pay (iPhone)

The **Transaction** trigger only runs when you hold the iPhone to a payment terminal. Apple Pay in Safari or inside
an app goes through a different path (the merchant's payment sheet), and iOS runs no automation for it. No public iOS
API reports those payments to another app either, so the Shortcut above cannot catch them.

What does arrive for almost every card payment, online or not, is the bank's **SMS**. A second automation forwards
those to the same endpoint:

1. **Shortcuts** → **Automation** → **+** → **Message**. Under **Message Contains**, enter a word every payment SMS
   from your bank has (or choose the bank as **Sender**). Choose **Run Immediately**.
2. Add **Get Contents of URL** with the same URL, method and `Authorization` header. **Request Body**: JSON with
   `text` = **Shortcut Input › Content** and `app` = **Shortcut Input › Sender**.
3. Add **Get Dictionary Value** (`nudge`) and **Show Notification**, as above.

Kassa runs the text through its notification parsers (Kazakh banks, Alipay / UnionPay bank SMS, WeChat Pay, Revolut,
Wise) and, with your AI consent, the Reader. A text that is not a payment is answered with `UNPARSED` and not logged.
A tap in a shop that also sends an SMS is merged into one entry (`MERGED`).

## Android: Google Wallet, Samsung Wallet, Alipay, WeChat Pay

Android lets an app with notification access read other apps' notifications, so one automation covers every wallet,
in shops and online. Use the same token and endpoint.

1. Install an automation app, for example **MacroDroid** or **Tasker**.
2. New macro → trigger **Notification received** → apps: Google Wallet, Samsung Wallet, Alipay, WeChat, your bank's
   app. Grant notification access when Android asks.
3. Action **HTTP request**: `POST` the endpoint, header `Authorization: Bearer <token>`, content type
   `application/json`, body:

   ```json
   {"app":"[notification_app_package]","title":"[notification_title]","text":"[notification]"}
   ```

   (MacroDroid magic text; in Tasker use `%anapp`, `%antitle`, `%antext`.)
4. Optional: save the response and show its `nudge` as a notification.

Formats Kassa reads (`apps/api/src/modules/capture/parsers/wallet.ts`):

| App | Example notification |
| --- | --- |
| Google Wallet | title `Cafe Frei`, text `€4.50 with Visa ••1234` (older: `Paid 1 290 Ft at Spar with Mastercard •••• 9876`) |
| Samsung Wallet | text `Payment of ₸2 500 at Magnum completed` |
| Alipay | `你在 便利店 消费 ¥32.50` |
| WeChat Pay | `支付成功 ¥45.00 收款方：面馆` |

Any other app's text goes to the same parsers as a bank SMS (above).

## Revoking a token

Open **Settings → Payment taps → Kassa** and tap **Revoke** next to the device. The change is immediate: the next request
with that token gets `401 DEVICE_TOKEN_INVALID`. Revoking is a tightening, so it needs no passkey (I8).

The API calls behind the screen need a user session:

| Call | What it does |
| --- | --- |
| `POST /api/devices/shortcut` | Creates a token |
| `GET /api/devices` | Lists the active Shortcut devices and the time of the last Shortcut capture |
| `DELETE /api/devices/:id` | Revokes a token |
