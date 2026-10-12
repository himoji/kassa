# Demo script (5 minutes)

Judges are WeBank industry experts. The pitch line is: "The agent can prepare anything, but only your signature can move your money."
Everything shown is simulated.

## Setup (before the pitch)

1. Stack running with `DEMO_ENABLED=true` on both services, and the same `DEMO_ADMIN_TOKEN` and `MOCK_HMAC_SECRET` (`bun run env:setup`).
2. Phone: Kassa app signed in as the demo user (Dana), and a browser tab on `/mock/stage` (the Demo Stage director). A second screen can mirror the app.
3. Press "Reset demo" on `/mock/stage`. Optional: in the app's Settings, set region CN only when you reach scene 2.

## Timeline

| Time | Screen (URL) | Do | Kassa shows | Point (invariant) |
| --- | --- | --- | --- | --- |
| 0:00–0:20 | app | Open Kassa home: budgets, bills, balances | Overview | "Assistant that can also pay" |
| 0:20–0:50 | `/mock/stage/tap?v=average` | Tap "Hold near reader" (Coffee Shop in Budapest, €4.20) | Purchase logged in EUR with ₸ equivalent; budget notice | Capture only logs (I6); device token (I13) |
| 0:50–1:20 | `/mock/stage/tap?v=bad` | "Accept KZT and tap" at Gift Shop in Budapest, then "Statement arrives (settle)" | Fee x-ray: DCC warning, about 6% over mid | Hidden FX cost exposed (fee x-ray) |
| 1:20–1:40 | app → `/mock/stage/tap?v=bad2` | Order 2 Margherita from Pizza Shop in Budapest in Kassa chat; paste the one-time card id; "Tap one-time card", then "Terminal charges again" | Approved once, then declined CARD_ALREADY_USED | One-time card for the exact order (I2, I4) |
| 1:40–2:00 | `/mock/stage/home?v=average` | "Send money" (₸1,000,000 from parents) | Money from home notice; routes and coverage update | Events never pay (I6) |
| 2:00–2:40 | app → `/mock/stage/mail?v=average` → `/mock/stage/bank?v=average` | Forward the tuition invoice; in Kassa ask to pay tuition; approve with passkey; watch Bank App steps (use "Fast-forward +1 hour") | Reader fields with evidence; order ASK; passkey sheet; SENT | Signature over the canonical order (I2, I3); untrusted documents through the Reader (I10) |
| 2:40–3:00 | `/mock/stage/bank?v=bad` | "Send forged message" | "Kassa rejected a forged bank message" (401) | Webhooks are authenticated (I13) |
| 3:00–3:30 | `/mock/stage/mail?v=bad` | Forward the lookalike landlord email (new IBAN); ask Kassa about it; then "Jump to rent day (+3 days)" | New payee in 24 h cooling; rent autopay pays the verified landlord | A payee change is a new payee (I7, A2) |
| 3:30–4:10 | app (Settings: region CN; give the separate PIPL consent when asked) → `/mock/stage/wallet?v=average` | In Kassa pay the Dorm Office in Shanghai ¥1,800; approve; on the Super-App Wallet (simulated, 中文) screen press 确认付款 Pay | Handoff; payment SENT | Agent prepares, you pay (handoff) |
| 4:10–4:30 | `/mock/stage/wallet?v=bad` | Turn the swap attack on; in Kassa ask to buy a bedding set from Buy Everything Shop from China for ¥349 | REFUSED QR_PAYEE_MISMATCH before signing; the wallet screen shows the code would pay "Unknown Trading Company" | A5 |
| 4:30–4:45 | `/mock/stage/wallet?v=notify` | "发送到 Kassa Send to Kassa" | Chinese spending notices logged in CNY with ₸ equivalent | I6 |
| 4:45–5:00 | `/mock/stage/supplier?v=bad` | "Show hidden text" | (explain) The hidden instruction is data; planner cannot pay; unknown account refused | A1, I1, I10 |

## Connected world on real devices

Setup: `bun run phone` starts the one-origin proxy (`/api` → API :4000, `/mock` → mock-world :4001, else the web export) and a Cloudflare tunnel, then prints the env block and start commands for the API, mock-world and the web export. Use a named tunnel (`CLOUDFLARED_TUNNEL` + `PHONE_HOST`): passkeys are bound to `RP_ID`, and a quick tunnel changes host on every restart. `KASSA_APP_URL` must be the tunnel origin so till QR codes open `https://HOST/pay/<billId>` (a signed-out scan returns to that bill after sign-in).

Devices (all on `https://HOST`):

- iPhone 1: Dana (the seeded hero, "Try the demo") in Safari, plus the real Apple Pay Shortcut automation from [SHORTCUT_SETUP.md](SHORTCUT_SETUP.md).
- iPhone 2: the pizzeria owner (persona `pizzeria-bud`, or `pizzeria-sha` for the Shanghai beats) in Safari, and a second tab on `/mock/shop/bud/till`.
- Mac: `/mock/shop/bud/kitchen`, `/mock/shop/sha/kitchen`, `/mock/supplier/c/portal` (Shanghai supplier; `a` is Budapest, `b`/`d` are the cooling attackers) and `/mock/stage`.
- Android emulator: Li Wei in Shanghai (persona `li-wei-cn`, region CN) in the browser.

Picking the persona: the welcome screen shows persona chips above "Try the demo" (Dana, Li Wei, Li Wei (Shanghai), Pizzeria owner Budapest, Pizzeria owner Shanghai; default Dana). A demo link can preselect one with `/welcome?persona=<key>`, key one of `dana`, `li-wei`, `li-wei-cn`, `pizzeria-bud`, `pizzeria-sha` (unknown keys fall back to Dana). The app sends `demoClaim: true` for Dana and `demoClaim: "<key>"` otherwise on `POST /api/auth/register/options`; non-Dana personas need a seed with personas (`bun run seed`, sim up, or demo reset).

Beats, in order:

1. Café tap: a real Apple Pay tap on iPhone 1; the Shortcut sends it to Kassa, which logs it and may reply with a nudge.
2. Pizza order: in Dana's Kassa chat "Order me 2 pizzas"; approve with the passkey; the shop charges the one-time card.
3. Kitchen: advance the order on `/mock/shop/bud/kitchen` (RECEIVED → ACCEPTED → COOKING → OUT_FOR_DELIVERY → DELIVERED).
4. Till QR pay: ring up a bill on `/mock/shop/bud/till`; scan its QR with iPhone 1; approve; the till turns PAID.
5. Shanghai shortage: the `pizzeria-sha` owner's Today/Stock shows boxes 400 short by the end of tomorrow; ask the agent to order boxes from the usual supplier; it drafts a PO (moves no money).
6. PO sign: the owner signs the PO with the payments passkey (challenge = the PO hash); it is sent to supplier C.
7. Supplier: on `/mock/supplier/c/portal` confirm, deliver, then invoice.
8. QR payment: the invoice passes the three-way match; approve the QR handoff payment; the PO is PAID.
9. Swapped-bank invoice: supplier D invoices C's PO with its own account; Kassa refuses it (`INVOICE_ACCOUNT_MISMATCH`).

Headless proof: `bun run sim story` runs the same beats against a fresh sim over the same HTTP surfaces (pizza, till, restock, attack, invoice, shortcut, ledger verify) and always stops the sim. It uses ports 4000/4001, so stop the device stack first.

## If something goes wrong

- "Reset demo" on `/mock/stage` restores the seed and the clock.
- A red "Kassa API refused the stage call" means `DEMO_ENABLED` or `DEMO_ADMIN_TOKEN` differs between the API and mock-world.
- "Waiting for Kassa" on the wallet means no QR code has been prepared yet. Approve the handoff in the app first.
- Turn the swap attack off after scene 2 ("关闭攻击 Turn attack off").

## URLs

- `/mock/stage`: director. Scenes, clock (+1 hour, +3 days) and reset.
- `/mock/stage/tap`: Tap to Pay terminals (coffee, currency trick, one-time card).
- `/mock/stage/wallet`: Super-App Wallet QR screen, swap attack, spending notices.
- `/mock/stage/mail`: inbox. Forward the tuition invoice or the lookalike landlord email.
- `/mock/stage/bank`: Bank App transfer status and the forged message.
- `/mock/stage/home`: money from home.
- `/mock/stage/supplier`: supplier price list with hidden text.

The stage exists only when `DEMO_ENABLED=true`. Its buttons call mock-world, which calls the Kassa API server-side. No secret reaches the browser.
