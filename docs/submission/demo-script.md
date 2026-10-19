# Demo script (five beats, target 5 minutes or less)

The committed video ([`docs/demo/kassa-demo.mp4`](https://github.com/himoji/kassa/blob/main/docs/demo/kassa-demo.mp4), 3:28; split as `kassa-eu.mp4`, 1:20, and `kassa-cn.mp4`, 2:08) is an earlier take (2026-10-12 recorder, replayed planner) with different scenes; see [Demo videos](./demo-videos.md). The five beats below are not in it.

Pitch line: "Kassa's agent pays your bills across borders on its own, inside the limits you signed with your passkey."
Safety line: "The agent can prepare anything, but only your signature, now or in a mandate signed earlier, can move your money."
Everything shown is simulated: sandbox money, mock bank, fictitious companies.

## The 5-minute video (five beats)

Before recording: `AGENT_MODE=LIVE` with a working key (a chat turn shows no "Replay" badge). Press "Reset demo" on `/mock/stage`.

| Time | Beat | Do | Viewer sees | Point |
| --- | --- | --- | --- | --- |
| 0:00–0:20 | Problem | Dana's home screen: money in KZT and USD, bills in HUF and EUR | Balances, bills, budgets across her currencies | Topic C: a student whose money lives in two countries |
| 0:20–1:20 | 1. The agent meets Dana (live AI) | "Try the demo" as Dana, give AI consent; paperclip → `fixtures/statements/kaspi-gold-kzt.csv` (KZT) and `fixtures/statements/hu-bank-huf.csv` (HUF), optionally `usd-account.ofx` (USD scholarship), "Use this history"; discuss what is missing; review the drafted caps and budgets, sign with the passkey; sign the offered rent mandate | Statements read in seconds: money from home per parent, spending per category, card fees, own transfers left out; draft prefilled; rent mandate signed | The AI learns her past from her banks and does the setup; the user signs the limits once |
| 1:20–2:20 | 2. Money from home pays tuition | `/mock/stage/home`: "Send money" (₸1,000,000 from parents). `/mock/stage/mail`: forward the tuition invoice. In chat: "pay my tuition". Approve with the passkey; on `/mock/stage/bank` press "Fast-forward +1 hour" | Remittance logged, cheapest route with FX cost, reader fields with evidence, exact order, passkey, SENT | Remittances and tuition; a large one-off payment needs the user's signature |
| 2:20–3:00 | 3. Rent day: the agent pays on its own | `/mock/stage/mail?v=average` "Jump to rent day (+3 days)" | Rent paid to the verified landlord with no prompt; the notice names the mandate | The agent acts as a financial participant inside a signed mandate |
| 3:00–3:50 | 4. Attacks fail | `/mock/stage/mail?v=bad`: forward the lookalike landlord email with a new IBAN and ask Kassa about it. `/mock/stage/supplier?v=bad`: "Show hidden text" | New payee in 24 h cooling, never paid on autopilot; hidden instruction treated as data. `docs/evidence/attacks.json`: of 16 attacks (including recreations of Freysa, Grok + Bankrbot and AIXBT, A10 to A17) Kassa refuses 7, stops 8 at a passkey prompt and pays 1 (a QR swapped inside the wallet after the check, detected only); if the fooled user approves every prompt, 5 pay the attacker, against 11 for a chatbot with a confirm tap | Fooling the model alone moves no money; what is left is the user's own approval |
| 3:50–4:40 | 5. Credit record | Credit record: last 6 months, bills paid on time and income, export; open the verify link as the landlord | Signed summary, PDF, public verify page that checks the signature and the ledger entry | Credit building for a student with no local credit history |
| 4:40–5:00 | Close | Run `bun run ledger:verify` (or show `docs/evidence/ledger-verify.json`) | Hash chain and checkpoint signatures verified | Every action is in a tamper-evident ledger |

Optional beat, linked accounts and the school portal (about 40 s, replaces part of beat 2): Recipients → University in Budapest → "Pay this invoice", From → Visa •4242 (seeded, linked), approve with the passkey. Receipt: "Delivered in 0.1 s" (simulated payout). Open the school portal from the recipient (the link signs Dana in; opened directly, e.g. `/mock/schools/budapest/portal?studentId=KZ26-0417`, it asks for student ID and date of birth: 2005-03-14): the invoice shows Paid and Kassa notifies "University in Budapest received your tuition". To show linking: Settings → Linked accounts → Link a bank → Kaspi with the code from the bank's note.

Expected result for beat 1 ([fixtures/statements/README.md](https://github.com/himoji/kassa/blob/main/fixtures/statements/README.md)): "Нұрлан С.: money came in 8 of 12 months (9 of 12 with the HUF file), ₸90,000–₸370,000, plan with the average", the scholarship regular, rent to Landlord in Budapest as a monthly bill, own transfers left out.

Optional: a real Apple Pay tap through KassaLite ([guide/kassalite.md](../guide/kassalite.md)), or the China QR handoff (scenes 3:30 to 4:30 below). If onboarding was already done on this database, press "Reset demo" first; to show the mandate without onboarding, sign it from the landlord's payee screen.

## Recording the video automatically

`DEMO_ADMIN_TOKEN=… bun run demo:video -- --app <web app URL> --api <API URL>/api` records the five beats as one take (`scripts/demo-video/record.ts`): reset, upload two fictitious statements (`scripts/demo-video/statements.ts`), onboarding chat, sign rules, rent mandate and backup codes with passkeys (Chromium's virtual authenticator), jump to rent day, attack evidence page, credit record, with captions. Output: `kassa-demo.mp4` (with ffmpeg on PATH), `kassa-demo.webm`, `chapters.txt`. Record with a model key: without one, beat 1 answers from the replay, which does not know the uploaded statements. Add the voiceover afterwards.

## Setup (before the pitch)

1. Stack running with `DEMO_ENABLED=true` on both services and the same `DEMO_ADMIN_TOKEN` and `MOCK_HMAC_SECRET` (`bun run env:setup`).
2. Phone signed in as Dana; a browser tab on `/mock/stage` (the director). A second screen can mirror the app.
3. "Reset demo" on `/mock/stage`. Set region CN in Settings only at the China QR scene (3:30).

## Extended scenes (live final and Q&A)

Too many for the 5-minute video.

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
| 3:30–4:10 | app (Settings: region CN; give the separate PIPL consent when asked) → `/mock/stage/wallet?v=average` | In Kassa pay the Dorm Office in Shanghai ¥1,800 (Dana's seeded dorm fee); approve; on the Super-App Wallet (simulated, 中文) screen press 确认付款 Pay | Handoff; payment SENT | Agent prepares, you pay (handoff) |
| 4:10–4:30 | `/mock/stage/wallet?v=bad` | Turn the swap attack on; in Kassa ask to buy a bedding set from Buy Everything Shop from China for ¥349 | REFUSED QR_PAYEE_MISMATCH before signing; the wallet screen shows the code would pay "Unknown Trading Company" | A5 |
| 4:30–4:45 | `/mock/stage/wallet?v=notify` | "发送到 Kassa Send to Kassa" | Chinese spending notices logged in CNY with ₸ equivalent | I6 |
| 4:45–5:00 | `/mock/stage/supplier?v=bad` | "Show hidden text" | (explain) The hidden instruction is data; planner cannot pay; unknown account refused | A1, I1, I10 |

## Connected world on real devices

Setup: `bun run phone` starts the one-origin proxy (`/api` → API :4000, `/mock` → mock-world :4001, else the web export) and a Cloudflare tunnel, and prints the env and start commands. Use a named tunnel (`CLOUDFLARED_TUNNEL` + `PHONE_HOST`): passkeys are bound to `RP_ID`, and a quick tunnel changes host on restart. `KASSA_APP_URL` must be the tunnel origin so till QR codes open `https://HOST/pay/<billId>`.

Devices (all on `https://HOST`):

- iPhone 1: Dana ("Try the demo") in Safari, plus the Apple Pay Shortcut from [guide/shortcuts.md](../guide/shortcuts.md).
- iPhone 2: the pizzeria owner (`pizzeria-bud`, or `pizzeria-sha` for Shanghai) in Safari, second tab on `/mock/shop/bud/till`.
- Mac: `/mock/shop/bud/kitchen`, `/mock/shop/sha/kitchen`, `/mock/supplier/c/portal` (Shanghai supplier; `a` is Budapest, `b`/`d` are the cooling attackers) and `/mock/stage`.
- Android emulator: Li Wei in Shanghai (`li-wei-cn`, region CN) in the browser.

Personas: chips above "Try the demo" on the welcome screen, or `/welcome?persona=<key>` with `dana`, `li-wei`, `li-wei-cn`, `pizzeria-bud`, `pizzeria-sha` (unknown keys fall back to Dana). The app sends `demoClaim: true` for Dana and `demoClaim: "<key>"` otherwise on `POST /api/auth/register/options`; non-Dana personas need a seed with personas (`bun run seed`, sim up, or demo reset). Business mode (beats 2 to 9) needs `EXPO_PUBLIC_SHOW_BUSINESS=true` or `/welcome?persona=pizzeria-bud`.

Beats:

1. Café tap: real Apple Pay tap on iPhone 1; the Shortcut sends it to Kassa, which logs it and may nudge.
2. Pizza order: "Order me 2 pizzas" in Dana's chat; approve; the shop charges the one-time card.
3. Kitchen: advance on `/mock/shop/bud/kitchen` (RECEIVED → ACCEPTED → COOKING → OUT_FOR_DELIVERY → DELIVERED).
4. Till QR pay: ring up a bill on `/mock/shop/bud/till`; scan with iPhone 1; approve; till turns PAID.
5. Shanghai shortage: `pizzeria-sha` Today/Stock shows boxes 400 short by end of tomorrow; ask the agent to order from the usual supplier; it drafts a PO (moves no money).
6. PO sign: the owner signs with the payments passkey (challenge = PO hash); sent to supplier C.
7. Supplier: on `/mock/supplier/c/portal` confirm, deliver, invoice.
8. QR payment: three-way match passes; approve the QR handoff; PO is PAID.
9. Swapped-bank invoice: supplier D invoices C's PO with its own account; refused (`INVOICE_ACCOUNT_MISMATCH`).

Headless: `bun run sim story` runs the same beats against a fresh sim (pizza, till, restock, attack, invoice, shortcut, ledger verify) and always stops it. It uses ports 4000/4001, so stop the device stack first.

## If something goes wrong

- "Reset demo" on `/mock/stage` restores the seed and the clock.
- "Kassa API refused the stage call": `DEMO_ENABLED` or `DEMO_ADMIN_TOKEN` differs between API and mock-world.
- "Waiting for Kassa" on the wallet: no QR code prepared yet; approve the handoff in the app first.
- Turn the swap attack off after 4:10–4:30 ("关闭攻击 Turn attack off").

## URLs

- `/mock/stage`: director (scenes, clock +1 hour / +3 days, reset).
- `/mock/stage/tap`: Tap to Pay terminals.
- `/mock/stage/wallet`: QR wallet, swap attack, spending notices.
- `/mock/stage/mail`: inbox (tuition invoice, lookalike landlord email).
- `/mock/stage/bank`: transfer status, forged message.
- `/mock/stage/home`: money from home.
- `/mock/stage/supplier`: price list with hidden text.

The stage exists only with `DEMO_ENABLED=true`. Its buttons call mock-world, which calls the Kassa API server-side; no secret reaches the browser.
