# Kassa — Build Plan

Oct 10, 2026 · Kassa team

> The plan written before the build started. What changed during the build (for example an Expo app instead of a React PWA) is logged with dates in [DECISIONS.md](../DECISIONS.md); the README and ARCHITECTURE.md describe what was built.

Submission deadline: Oct 20, 2026, 17:59 Budapest (23:59 Beijing).

## What we build

Kassa is an AI agent wallet with a human in the loop, entered under **Topic C (Cross-border & Student Finance Assistant)**. You tell it once who you are, where your money comes from and what you must pay. After that you just say what you want: the agent finds the price and the cheapest route, checks your budget in every currency, prepares the payment, asks you when needed, and pays. It never pays outside the limits you signed with your fingerprint.

**Hero:** Dana, a Kazakh master's student in Budapest. Money arrives from her parents in KZT and from a USD scholarship. She pays rent in HUF, tuition in EUR, insurance and daily spending. The demo leads with what Topic C names: tuition, remittances, multi-currency and credit building. A pizza order is a 20-second "everyday purchase" moment.

**Same engine, two extras:** a Shanghai region switch shows handoff mode (the agent prepares everything, Dana pays in a simulated QR wallet). One slide shows a pizzeria restocking dough on autopilot.

**Pitch line:** "The agent can prepare anything, but only your signature can move your money."

## System parts

Nine parts. The rule that holds them together: **the AI can only draft; plain code decides; only signed approvals move money.** The companion explainer page animates how a request travels through them.

| Part | Job | Talks to | Built from / reused | Owner |
| --- | --- | --- | --- | --- |
| App (React PWA) | Chat, confirmation sheet, balances per currency, bills, settings presets, activity log, freeze | Agent, Rules service | New; passkeys via @simplewebauthn/browser | C |
| Agent service (LLM with tools) | Understands requests, plans, compares prices and routes, drafts orders | Rules service (drafts only), mock world (read), FX sources | New; LLM API tool use. Only write tool: `propose_order` | B |
| Reader (quarantined LLM call) | Turns untrusted input (invoices, menus, emails, price lists, screenshots) into typed fields | Agent only | New; no tools, schema-validated output | B |
| Rules service (plain code, no AI) | Hard rules, mandates, risk score, decides auto / ask / handoff / refuse; builds the canonical order; verifies passkeys; signs approvals | App, Agent, Payment service, Ledger | Policy logic ported from the Guardian prototype (caps, allowlist, pending with timelock, pause/revoke) | A |
| Payment service | Executes only signed approvals; re-checks the user signature for asked payments; own daily cap; single-use nonces | Rules service, rails, Ledger | New | A |
| Payment rails (adapters) | Stripe Issuing sandbox one-time cards; mock bank transfer (Wise-like); handoff (simulated QR wallet) | Payment service | Stripe test mode; mocks written by us | A |
| Ledger and audit log | Append-only, hash-chained record of every proposal, approval, refusal, payment; signed checkpoints; export | Everything writes; nothing edits | New; becomes the sandbox evidence | A |
| Scheduler and triggers | Due-date scanner for bills; webhooks (iOS Shortcut taps, mock POS) that can only log or create drafts | Agent, Rules service | New; authenticated webhooks | B |
| Mock world | Pizza shop, two food suppliers (one with a hidden instruction), landlord, university, insurer, QR wallet, POS, "parents" remittance | Agent, Payment rails | Built by us, clearly labelled "simulated", generic names and no real logos | C |

**Reused from the earlier prototype:** the spending-policy logic and the attack scenarios (injected and Morse-encoded instructions, plus the naive-planner harness for red-team tests). The Solidity contract is dropped, because blockchain is out of scope.

## Product rules

Users pick one of three presets; the individual switches sit under Advanced. The hard rules apply in every preset.

| Preset | Agent | Payments | Money | For |
| --- | --- | --- | --- | --- |
| Ask me | Acts only when asked | Always asks (passkey per payment) | Pay in place: nothing stored | Cautious users, first week |
| Smart (default) | Plans ahead: bills, conversions | Asks only when the risk score is high | Small capped top-up wallet | Most students |
| Autopilot | Plans and acts | Never asks inside a signed mandate | Capped wallet; businesses pay after delivery | Recurring bills, business restock |

**Money modes:**

- **Pay in place:** the Accept button funds exactly this payment by card (Google Pay or a test card in the demo). Nothing sits in a wallet.
- **Capped wallet:** a sub-account topped up from your own account. Withdrawals go only back to that source account. In production it is held by a licensed partner, never by us.
- **Handoff:** where regulation or the user requires it, the agent prepares everything and the user pays in their own payment app. Used for the Shanghai demo.

**Hard rules, every preset:**

1. Bills are paid only to verified payees. A new payee, or a changed account number for an existing one, is a new payee: passkey plus a 24-hour cooling period, and never usable on autopilot.
2. Per-payment, per-day and per-month caps, plus a protected reserve for rent and tuition.
3. Loosening any rule needs a passkey and takes effect after 24 hours. Tightening and freezing take effect instantly.
4. Triggers (taps, POS events, emails) can only log or create drafts. They can never approve or raise a tier.
5. Every payment produces a notification, and autopilot payments wait 30 minutes as "pending" with a Cancel button.

## Core algorithms

The tech doc must describe a "core algorithm". We document three, each with a formula, pseudocode and tests.

**1. Route and FX optimizer: how to pay a bill most cheaply and on time.** For a bill of amount A, due on date d, the agent considers every pair of funding currency and rail r (bank transfer, Wise-like transfer, card in the bill's currency, card in the local currency):

```latex
\text{Cost}_r = \text{fee}_r + A \cdot m_r + P(\text{arrive after } d \mid r) \cdot \text{penalty}
```

m is the rail's markup over the mid-market rate. Routes that arrive after the due date or break a cap are discarded; the cheapest remaining one is proposed, with the saving shown in the user's home currency. Mid-market rates for EUR, HUF, USD and CNY come from the ECB via the free Frankfurter API. **The ECB publishes no KZT rate**, so KZT comes from the National Bank of Kazakhstan's published rates or a free rates API, labelled as such.

**2. Cash-flow coverage forecast: will each bill be covered, in its own currency?** For each currency k, the projected balance on day t:

```latex
B_k(t) = B_k(0) + \sum_{\text{income}_k \le t} - \sum_{\text{bills}_k \le t} - \text{burn}_k \cdot t
```

The first day any B drops below the protected reserve is a shortfall. The agent then proposes the cheapest conversion from a currency with a surplus (using algorithm 1), or a message asking family to send money by a given date.

**3. Risk score: when to ask the human.** Plain code, never the AI's own confidence:

```latex
R = \sum_i w_i \, f_i
```

Features f: new merchant (0/1), price above the usual median, share of the category budget, quantity against history, unusual hour, triggered automatically rather than by the user, reader output that disagrees with the source. Hard rules run first. Then the preset sets the threshold: Ask me always asks; Smart asks when R is above 0.5; Autopilot asks only outside the signed mandate. The AI's own doubt can add a question, never remove one.

## Security design and compliance

The design assumes the agent will be fooled and our server may be hacked. Money still moves only with the user's signature on the exact payment, or inside a mandate the user signed.

**How one payment is approved:**

1. The agent can only call `propose_order`. It holds no payment tool, keys or network route to the payment service. Amounts and payees from the Reader are re-checked against the catalog or invoice source.
2. The rules service builds the **canonical order**: proposal ID, payee ID, a hash of the payee's account details, amount, currency, rail, mandate ID (or none), a single-use nonce, and an expiry time.
3. The passkey challenge is the SHA-256 hash of that canonical order. The confirmation sheet renders from the same object and shows the hash, so what you see is exactly what you sign.
4. The rules service verifies the passkey: challenge equals the order hash, correct origin and site, user-verified flag set (Face ID, fingerprint or PIN), signature counter increased.
5. The rules service signs an approval (Ed25519) over order hash, verdict and tier. Its key lives in an environment secret, never in the agent's environment.
6. The payment service checks independently: approval signature and expiry; for asked payments the user's passkey signature again; for autopilot the stored passkey-signed mandate; nonce unused; its own daily cap. So a hacked rules service alone still cannot pay.
7. For card payments, a one-time Stripe Issuing card is created with a spending limit equal to the amount. Stripe cannot lock a card to one merchant or a 15-minute life by itself, so our authorization webhook enforces it: verify Stripe's signature, then approve only if merchant, amount and currency match the approval and the card is unused and in time. A job cancels the card after use or expiry.
8. Every incoming webhook is authenticated: Stripe signatures, HMAC with timestamp and replay window for the mock POS and QR wallet, a per-device token for the iOS Shortcut.
9. The ledger is hash-chained, with a signed checkpoint of the latest hash. A script in the repo verifies the whole chain.

**Permission tiers** (each row links to code and a test in the security self-assessment):

| Tier | What happens | Enforced by |
| --- | --- | --- |
| T0 Read, log, advise | Balances, forecasts, expense logging, drafts | Agent has no write tools beyond drafts |
| T1 Auto inside a mandate | Rent and insurance to verified payees, small purchases under caps | Passkey-signed mandate checked by the payment service |
| T2 Ask | Anything above the risk threshold or outside a mandate | Passkey signature over the canonical order |
| T3 Never | New or changed payee without cooling period; over caps; loosening rules instantly; triggers approving anything | Rules service and payment service both refuse |

**Compliance mapping** (one slide and one doc section):

- The passkey signature over amount and payee mirrors **PSD2 strong customer authentication with dynamic linking** (EU RTS Article 5).
- Verified payees mirror the EU's **Verification of Payee** requirement under the Instant Payments Regulation, in force since October 2025.
- No custody in the MVP; the wallet would be held by a licensed bank or e-money institution, with its KYC and anti-money-laundering checks.
- Data protection: **GDPR** in the EU, **PIPL** and cross-border data rules for the Shanghai mode.
- The hash-chained ledger is the record-keeping and audit control.

**Known risks we state openly:** the user approves a bad purchase; the phone and biometrics are compromised together; a dishonest supplier or employee confirms a fake delivery; the AI misreads an amount (limited by source re-checks, caps and reconciliation); everything runs in sandboxes.

## Demo plan

Real payment software in test mode where it exists; small mock services we write where it doesn't. Everything mocked is labelled "simulated" on screen, uses generic names, and carries no real brand logos.

**What runs where:**

| Demo piece | Real or mock | How it works |
| --- | --- | --- |
| Card payments (pizza, insurance) | Real Stripe Issuing sandbox | Create a one-time virtual card per approved payment. The "shop checkout" calls Stripe's test helper that simulates an authorization with merchant data. Our webhook approves or declines it; the decline of a second use is visible in Stripe's test logs. |
| Pay in place | Real Stripe test mode | Accept button opens Stripe's payment form with a test card or Google Pay test. Apple Pay is skipped: it needs domain verification and a real device. |
| Bank transfers (rent, tuition, conversions) | Mock bank, Wise-like | Our own API: quote, recipient, transfer, then status steps (created, processing, sent) on a timer. Rates from Frankfurter plus a per-rail markup. Wise's real sandbox needs partner credentials, so it stays a "planned adapter". |
| Inbound remittance from parents | Mock | "Parents send ₸400,000": three quotes with different fees, the best day to convert. |
| QR wallet (Shanghai handoff) | Mock page | Supplier returns a "QR Wallet (simulated)" code with a payee name. Dana "pays" on a phone-sized page; the status webhook (HMAC-signed) confirms it. A swapped code with a different payee name triggers a warning. |
| Pizza shop | Mock API | Generic "Pizza Shop" menu and checkout that charges the one-time card. |
| Food suppliers and POS | Mock | Two suppliers; one price list hides an instruction to pay an extra invoice. The POS sends a signed "dough low" event (slide or clip only). |
| University, landlord, insurer | Mock payees | Tuition invoice PDF with a payment reference the Reader extracts. |
| Expense taps | Recorded clip | iOS Shortcut "Transaction" automation posts to our webhook. Live only if a teammate has an iPhone and a public URL. |

**Demo safety switches:**

- **Demo clock:** a visibly labelled control that moves time forward ("3 days later"), so rent autopay and the 24-hour rule delay can be shown live.
- **Demo mode:** replays recorded AI tool calls, so the live demo behaves the same every time. A Reset button restores seeded data.
- **Fallbacks:** if Stripe fails, a feature flag switches to our own card ledger; a local `docker compose` copy backs up the hosted site; the pre-recorded video is cued beat by beat; two registered passkeys (phone and laptop).

**Video storyline (5 minutes):**

| Time | Beat |
| --- | --- |
| 0:00–0:25 | Problem: Dana's money arrives in KZT and USD, while her bills are in HUF and EUR. Fees, deadlines, no credit history. |
| 0:25–0:55 | Onboarding by chat. Profile appears; Dana signs her base rules and the rent mandate with her fingerprint. |
| 0:55–1:50 | Main beat, tuition. Reader pulls amount and reference from the invoice; agent compares three routes and shows the saving; coverage forecast says "convert ₸400,000 now"; confirmation shows the exact order; fingerprint; transfer moves through its states; ledger entry. |
| 1:50–2:20 | Demo clock jumps 3 days: rent paid automatically under the mandate, with notification. |
| 2:20–2:50 | "Two pizzas": can-I-afford answer in tenge, fingerprint, one-time card paid; a second charge on the same card declined. |
| 2:50–3:50 | Attacks, each with its tier label: hidden instruction in a price list ignored; "landlord's new IBAN" email becomes a new payee with cooling period; direct call to the payment API rejected; loosening a limit held for 24 hours; swapped QR code caught. |
| 3:50–4:15 | Region switch to Shanghai: handoff with the simulated QR wallet. Credit-builder report if built. |
| 4:15–4:45 | Architecture in one picture: the AI never holds payment power; signatures checked at payment time; ledger check script runs. |
| 4:45–5:00 | Close: the Topic C pain points solved, compliance mapping, repo link. |

## Scope cut

Finished flows beat many half-built ones: task completion is 40% of the score. Anything not working by October 16 moves down a level.

**Must work by the October 17 freeze:**

- Chat onboarding into a profile (seeded data allowed), passkey registration, passkey-signed base rules and rent mandate.
- Rules service: tiers, caps, verified payees, reserve, risk score, with unit tests.
- Payment service: signed approvals, passkey re-check, single-use nonces, own daily cap.
- Three rails: Stripe Issuing one-time card with authorization webhook (or our fallback card ledger); mock bank transfer with route optimizer; handoff with the simulated QR wallet.
- Flows: tuition with route comparison and fingerprint; rent autopay under the mandate; one small purchase with a one-time card; balances per currency with the coverage forecast.
- Hash-chained ledger with export and checker script; freeze button.
- Five attacks that fail: price-list instruction, "new IBAN" email, direct payment API call, loosening a limit without passkey, swapped QR code.
- Demo mode, demo clock, reset.

**Only if everything above is green by October 16:**

- Credit-builder screen: on-time payment history as a signed, exportable record for a landlord or bank, plus tips.
- Shanghai region switch (30 seconds; worth it for a Shenzhen panel).
- Screenshot-to-expense through the Reader.
- Inbound remittance comparison.
- Voice input.

**Slide or recorded clip only:** pizzeria autopilot restock; iOS Shortcut tap capture; Apple Pay; Telegram notifications; production licensing model; Secure Payment Confirmation (the browser's trusted payment dialog) as the production path for confirmation-screen integrity; other planned payment adapters (US ACH, SEPA, Wise, China partner bank).

## Tests and evidence

The repo proves every claim with a test, and every test leaves a log the judges can open.

- **Unit tests** for each hard rule, the three algorithms (with fixed rates as inputs) and signature checks.
- **Attack suite:** the five MVP attacks plus a fake POS trigger (10× order) and a lying confirmation; each must be refused at the right tier.
- **End-to-end scenarios:** tuition, rent autopay, one-time-card purchase, handoff. Each run exports its ledger slice.
- **`TESTS.md`:** one row per test with ID, threat or flow, expected result, actual result, and log reference.
- **`evidence/` folder,** generated by one command (`make demo-evidence`): hash-chained ledger JSON with signed checkpoints, Stripe test-mode request and event IDs, mock-bank transfer logs, the chain checker's output.
- **CI** on GitHub running all tests on every push, with the badge in the README.
- **Security self-assessment:** the tier table with, for each tier, the code location and the test that enforces it, followed by the known-risk list.

## 10-day plan

Three people work in parallel from October 11. A rough video exists before the freeze, so the last three days are polish, not panic.

&#91;embedded content: 10-day build plan · 3 tracks, freeze Oct 17\]

**Daily goals:**

- **Oct 10 (tonight):** register (form plus passport bio pages), send the organiser email, create the repo and CI, try enabling Stripe Issuing in test mode. If it can't be enabled, use our own card ledger from day one.
- **Oct 11–12:** A builds the rules service and signature checks; B builds the agent tools and Reader; C builds app screens with seeded data. First end-to-end: tuition proposal, confirmation and fingerprint.
- **Oct 13–14:** A adds the payment service, one-time cards and ledger; B adds FX, the route optimizer and coverage forecast; C wires passkeys and the confirmation sheet.
- **Oct 15–16:** rent autopay, purchase flow, handoff mode, demo clock and demo mode; record the rough video; start the attack suite.
- **Oct 17:** feature freeze. Attack suite complete, `evidence/` generated, nice-to-haves only if green.
- **Oct 18–19:** final video, tech doc, security self-assessment, deck, README with deployment steps; full dry run of the 10-minute pitch.
- **Oct 20:** final check and submit by 12:00 Budapest (deadline 17:59).

## Submission checklist

Everything goes by email to wangyr@pbcsf.tsinghua.edu.cn. Resubmitting before the deadline is allowed; the latest version counts.

- [ ] Registration form plus every member's passport bio page (send tonight)
- [ ] Team check: all members enrolled outside Mainland China, Hong Kong, Macao and Chinese Taipei; at least 60% non-Chinese nationals
- [ ] 1 · Technical documentation: architecture, the three core algorithms, security design
- [ ] 2 · Deck for a presentation of at most 10 minutes, including the compliance slide
- [ ] 3 · Demo video, at most 5 minutes (treat as required: it is part of the execution evidence for Topic C)
- [ ] 4 · Source code: GitHub link, README, `docker compose up` deployment steps, hosted demo URL, test cases, CI badge
- [ ] 5 · Security self-assessment: tier table linked to code and tests, known-risk list
- [ ] 6 · Execution evidence: `evidence/` folder with ledger export, chain-check output, Stripe test IDs, mock-bank logs
- [ ] Licences: all open-source and data sources listed and properly licensed; no real brand logos in mocks
- [ ] At least one member able to travel to Shenzhen for November 20–23 if we reach the final

## Risks, open items, sources

| Risk | Fallback |
| --- | --- |
| Stripe Issuing test mode can't be enabled on our account | Our own one-time-card ledger with the same webhook logic, from day one |
| Wise sandbox needs partner credentials | Mock bank adapter; Wise shown as a planned adapter |
| No public KZT rate from the ECB | National Bank of Kazakhstan rates or a free rates API, labelled |
| AI answers vary in the live demo | Demo mode replaying recorded tool calls; reset button |
| Passkeys need HTTPS | Hosted URL with HTTPS; localhost for development |
| Scope creep | The scope cut above; anything not green by Oct 16 moves down a level |

**Open items:**

- Team size and skills: the tracks assume three people; with two, C's work splits between A and B and the deck starts on Oct 14.
- The organiser's answer on whether the demo video is required.
- Final product name.

**Sources:**

- Official competition brief (PDF) and the [call for applications](https://ird.oou.cmu.ac.th/category/upcoming/)
- [Stripe: testing Issuing](https://docs.stripe.com/issuing/testing)
- [Wise: sandbox and production environments](https://docs.wise.com/guides/developer/environments)
- [iOS 17 Shortcuts Transaction automation](https://matthewcassinelli.com/shortcuts-automations-ios-ipados-transaction-display-stage-manager/)
- [Google AP2 mandates explained](https://eco.com/support/en/articles/15192002)
- [World Bank Remittance Prices Worldwide](https://remittanceprices.worldbank.org)
- [Experian: foreign transaction fees](https://www.experian.com/blogs/ask-experian/what-is-a-foreign-transaction-fee/)
