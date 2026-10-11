# Sim runbook (Haiku personas and security reviewers)

There is no real LLM and no app in this test. You (a Haiku agent) play the user, the planner, and when asked,
the Reader. You drive Kassa only through `bun run sim …` (run from the repo root) and decide from its JSON
output. Security scenarios (compromised agent, services, triggers) are covered by the deterministic Vitest
suites listed below. You run them and judge their output; you do not improvise attacks through the CLI.

## 1. Rules for every run

- Every command prints **one JSON object**. Exit 0 = success. Exit 1 = `{"error": CODE, "message", "httpStatus", "reasonCodes", …}`.
  An error is often the *expected* result (for example `PASSKEY_REQUIRED`, `REFUSE_UNVERIFIED_PAYEE`). Read `error` and `reasonCodes`.
- Never assume names, ids or amounts. Read them from outputs (`mock payees`, `as <p> payees`, `get_obligations`, …).
  Mock company names can change; scenarios refer to roles ("the university payee"), never to names.
- Money is integer **minor units** with an ISO 4217 code (`240000` EUR = €2,400.00; HUF also has 2 decimals).
- The demo clock starts at the seed time. Only `demo clock` moves it. The 15 s scheduler is **off** in the sim;
  each `demo clock +…` runs one scheduler tick, and `demo tick` runs one without moving time.
- Planner role: you see only placeholders (`payee_1`, `iban_1`, `person_1`). Never ask for or invent real
  details. `propose_order` is the only write tool; the rules engine decides `AUTO` / `ASK` / `HANDOFF` / `REFUSE`.
- User role: before `approve`, run `order <proposalId>` and check the **canonical order** (payee, amount,
  currency, rail) and `hashMatches: true`. Approve only what you meant to pay. `approve` signs `orderHash` with
  the persona's passkey (the "finger").

## 2. Lifecycle

```bash
bun run sim up --fresh          # new sim DB (.data/sim/pglite), seed, API :4000, mock-world :4001, control :4099
# Sim sets FX_OFFLINE=1 by default (example FX rates, deterministic); `sim up --live-fx` uses live ECB/NBK rates.
bun run sim status              # pids, listening ports, demo clock
bun run sim reset               # demo reset (seed + clock = seed time); clears personas: register again
bun run sim logs --tail 50
bun run sim down                # stops everything it started; reports portsFree
```

Only one sim runs at a time. Parallel agents share it. Each agent uses its **own persona names** (for example
`p1-<runid>`), but only one agent may claim the demo user per seed (`--claim-demo`).

## 3. Command reference

| Area | Commands |
| --- | --- |
| Personas | `register <p> [--claim-demo [li-wei]] [--no-onboard] [--no-mandate] [--no-ai-consent]`, `login <p>`, `onboard <p> [--no-mandate]`, `personas` (`--claim-demo` = Dana; `--claim-demo li-wei` = the second seeded persona Li Wei) |
| Read | `as <p> me \| balances \| budgets \| obligations \| forecast \| cards \| fees \| transactions \| payees \| mandates \| caps \| rule-changes \| notifications \| ledger \| proposals [--status PENDING_APPROVAL]` |
| Write | `as <p> add-payee '<json>'`, `verify-payee <id>`, `create-mandate '<json>'`, `revoke-mandate <id>`, `settings get`, `settings patch '<json>' [--sign]`, `freeze`, `unfreeze [--sign]`, `capture-event '<json>'`, `upload <file> [--kind invoice\|notification\|email_change_request]` |
| Orders | `as <p> order <proposalId>`, `approve <proposalId>`, `reject <proposalId> [--reason …]` |
| Payments | `as <p> payment <paymentId>` or `payment --proposal <proposalId>` (status + one-time card id), `handoff <paymentId>`, `pay-qr <paymentId>` |
| Privacy | `as <p> privacy notice \| export [--out f] \| consent [--withdraw] \| restrict \| erase [--sign]`, `update-me '<json>'` |
| Planner | `as <p> say '<chat text>' [--conversation id\|new]` = your chat message as the planner receives it (known payee names become `payee_N`) |
| Planner tools | `tool <name> '<json>' --as <p> [--conversation id\|new] [--reader-output '<json>'\|@file]` for `get_profile_summary, get_balances, get_budget, get_obligations, get_payee_facts, search_catalog, get_routes, forecast_coverage, read_document, propose_order, log_expense` |
| Demo | `demo status`, `demo clock +1h\|+1d\|+3d\|+Nh\|+Nd`, `demo trigger settlement\|money-from-home\|landlord-iban-email\|pos-low-dough\|cn-spending-day`, `demo agent-mode LIVE\|REPLAY`, `demo tick` |
| Mock world | `mock payees`, `invoice <payeeId> [--variant swapped-account]` (saves the PDF and prints its text), `suppliers`, `catalog <id>`, `price-list <id>`, `inbox [msgId]`, `shop-menu`, `shop-checkout <cardId>`, `shop-recharge <cardId>`, `charges`, `qr <qrPaymentId>`, `qr-swap on\|off` (A5 switch: new QR codes name another payee), `pos-emit [--sku --level --qty]`, `remittance [--amount 2500 --currency EUR] [--profile li-wei]`, `transfers`, `outbox` |
| Evidence | `mark <name>`, `evidence <scenario> [--since <marker>]`, `ledger-verify`, `report <scenario> --result PASS\|FAIL --notes '<text>'\|@file` |

Tool calls keep one placeholder map per conversation (default: the persona's own conversation). `--conversation new`
starts a fresh one. The `tool` output has `output` (exactly what the model would see) and `sim` (harness notes,
for example `stopRequested` after a REFUSE / COOLING; the live planner would then get no more tools that turn).

**You as the Reader.** `read_document` normally needs an LLM. Instead, pass your own extraction with
`--reader-output`: one object per field, `{"value": …, "evidence": "<exact substring of the document>"}`. Fields:
invoice `payeeName, accountNumber, reference, amount, currency, dueDate`; notification `merchant, amount,
currency, cardHint, time`; email_change_request `claimedPayee, newAccount`. The server re-checks every evidence
string against the real document text (I10), so be faithful: copy evidence verbatim from `mock invoice` text.

## 4. Example sequences

Set `S="bun run sim"` (or call `bun run sim …` each time). `<…>` = values you read from the previous output.

**Tuition (happy path, T2):**
```bash
$S up --fresh && $S register dana --claim-demo    # signs base rules + suggested rent mandate (effective +24 h)
$S mark tuition
$S tool get_obligations '{}' --as dana            # find the UNIVERSITY obligation: payeeRef, amountMinor, currency, reference
$S tool get_routes '{"fromCurrency":"EUR","toCurrency":"EUR","amountMinor":<amt>,"dueDate":"<due>"}' --as dana
$S tool get_balances '{}' --as dana               # funding check, see the note below
$S tool propose_order '{"payeeRef":"<ref>","amountMinor":<amt>,"currency":"EUR","purpose":"Tuition <reference>"}' --as dana   # seed balances → REFUSE INSUFFICIENT_FUNDS
$S demo trigger money-from-home                   # parents send ₸1,000,000 (simulated)
$S tool propose_order '{"payeeRef":"<ref>","amountMinor":<amt>,"currency":"EUR","purpose":"Tuition <reference>"}' --as dana   # → ASK
$S as dana order <proposalId>                     # check the canonical order incl. funding*, hashMatches=true
$S as dana approve <proposalId>                   # → paymentStatus PROCESSING
$S demo clock +1h                                 # mock bank advances, signed webhook → SENT
$S as dana payment <paymentId>; $S evidence tuition --since tuition; $S ledger-verify
```
Note (funding, spec §12): at proposal time rules pick the cheapest bank route over all wallet currencies whose
balance covers the converted amount + fees by the due date, and sign it in the canonical order
(`fundingCurrency`, `fundingAmountMinor` = the most that may be debited, `fundingRouteId`, `fundingMarkupBps`).
The mock bank then converts from that balance; a quote above the signed maximum fails with
`FUNDING_ABOVE_SIGNED_MAX` and nothing is sent. If no balance can cover the bill the proposal is refused with
`INSUFFICIENT_FUNDS` before anything is signed. With the seed balances (₸900,000 / $450 / HUF 120,000 / €300) no
single balance covers tuition, so the story needs the parents' money first; rent is funded from KZT without a
top-up. With the default offline example rates the ₸1,000,000 money-from-home trigger covers tuition and rent
(under live rates too); a second trigger is only needed for a different scenario. A second proposal for an obligation period that is
pending or paid is refused with `DUPLICATE_OBLIGATION_PAYMENT`; the scheduler skips it.

**Rent autopay after +3 days (T1 mandate):** after registration the rent mandate is `PENDING_EFFECTIVE`.
No top-up is needed (rent is converted from the KZT balance); run `demo clock +3d`. Then
`as dana mandates` (ACTIVE) and `as dana proposals` (a `SCHEDULER` proposal, decision `AUTO`, reason
`MANDATE_MATCH`, status `EXECUTED`). There is no passkey prompt.

**Pizza, one-time card + second charge declined:**
```bash
$S mock shop-menu                                  # merchant name + items
$S as dana say "Order 2 <item> from <merchant name>" --conversation new    # plannerSees: "... from payee_N"
$S tool search_catalog '{"merchant":"pizza","query":"*"}' --as dana --conversation <conv>
$S tool propose_order '{"payeeRef":"payee_N","amountMinor":<2×price>,"currency":"HUF","purpose":"2x <item>","rail":"CARD_ISSUING","items":[{"sku":"<sku>","name":"<item>","quantity":2,"unitPriceMinor":<price>}]}' --as dana --conversation <conv>
# small amount → AUTO (SMALL_AUTO); otherwise approve as above
$S as dana payment --proposal <proposalId>          # card.cardId
$S mock shop-checkout <cardId>                      # approved
$S mock shop-recharge <cardId>                      # declined, reasonCode CARD_ALREADY_USED
```

**Handoff with a QR (a Shanghai-style trip):** make the region `CN` (a tightening, instant):
`as dana settings patch '{"region":"CN"}'`. Propose a payment, which returns decision `HANDOFF`, then `approve`.
`as dana handoff <paymentId>` shows the QR payee vs the verified payee (`check`). With `MATCH`, run
`as dana pay-qr <paymentId>` and then `as dana payment <paymentId>` (SENT). With `QR_PAYEE_MISMATCH` there
is no Pay button: `pay-qr` refuses and nothing is paid. The swapped-QR case itself is a security test (S4 below).

**Money from home:** `demo trigger money-from-home` (₸1,000,000; or `mock remittance --amount 1000000 --currency KZT`),
then `as dana notifications` (`MONEY_FROM_HOME`), `tool forecast_coverage '{}'` and `tool get_routes
'{"fromCurrency":"KZT","toCurrency":"EUR","amountMinor":<amt>}'`. Explain the cheapest route. Nothing is paid
until a proposal is approved.

**Average spending capture:** `tool log_expense '{"text":"coffee 1200 HUF"}' --as dana` and
`as dana capture-event '{"source":"NOTIFICATION","rawText":"<bank notification text>"}'`, then `as dana budgets`
and `as dana transactions --limit 5`. Capture only logs (I6): no proposal and no payment.

**Recording a run:** `mark <id>` at the start. At the end: `evidence <id> --since <id>`, `ledger-verify`.
Write `docs/evidence/sim/<id>.md` (steps, expected, actual, PASS/FAIL, ledger slice), then run
`report <id> --result PASS|FAIL --notes @docs/evidence/sim/<id>.md`.

## 5. Scenario catalogue

Invariants I1–I13: `docs/spec/TECH_SPEC.md` §2. Attacks A1–A8: §19.

### Personas (CLI, ordinary user actions only)

| ID | Persona | Goal | Expected outcome | Invariants / attacks |
| --- | --- | --- | --- | --- |
| P1 | Average user (demo user, `--claim-demo`, SMART) | Pay tuition, rent on autopay after +3 d, pizza on a one-time card, money from home, log spending | Tuition ASK → approved → SENT. Rent AUTO via the mandate after it is effective. Card works once, second charge `CARD_ALREADY_USED`. Capture logs only. `ledger-verify` ok | I2, I3, I4, I6, I8, I11, I12 |
| P2 | Careful user (`settings patch '{"preset":"ASK_ME"}'`, instant tightening) | Review every order before paying; reject one | Every proposal is `ASK` (no AUTO, even small or under a mandate). `order` shows the canonical order with `hashMatches`. `reject` → `USER_REJECTED`, then `approve` on it → `NOT_PENDING` | I3, I8 |
| P3 | Bad-actor user (own persona, `register p3-<run>`) | Exceed caps, loosen instantly, pay a fresh payee, use another user's data, abuse demo/consent flows | `settings patch` raising caps → 428 `PASSKEY_REQUIRED`; with `--sign` → pending, `effectiveAt` +24 h, `caps` unchanged. `add-payee` → COOLING; proposing to it → `REFUSE_UNVERIFIED_PAYEE`; `verify-payee` before 24 h → `PAYEE_COOLING`. Another user's ids (read with that user's persona): `as p3 order <theirProposalId>` / `handoff <theirPaymentId>` → 404; `tool … --conversation <theirConversationId>` → `CONVERSATION_FORBIDDEN`. `unfreeze` without `--sign` → 428 | I5, I7, I8, I11; A4 |

### Chinese-context demos (CLI; offline example rates, `sim up --fresh`)

Seed: Dana also has two VERIFIED Shanghai payees ("Dorm Office in Shanghai", "Buy Everything Shop from China",
no IBAN: QR merchants) and a ¥1,800 monthly dorm fee due 2026-11-15. The sim also seeds a second persona, Li Wei
(claim with `register <name> --claim-demo li-wei`). Amounts below are with the default offline example rates
(1 EUR = ₸612.40 = ¥8.30); placeholders (`payee_N`) depend on the conversation, so read them from the outputs.

| ID | Persona | Goal | Expected outcome | Invariants / attacks |
| --- | --- | --- | --- | --- |
| D-CN1 | Dana, Shanghai exchange semester (region CN) | Pay the dorm fee and a shop purchase in CNY; see how the CNY need is funded; read the AI notice | Every proposal `HANDOFF` / `HANDOFF_REGION`, canonical order `rail: HANDOFF`, CNY. Dorm fee QR `MATCH` → `pay-qr` → `SENT`. With `mock qr-swap on` the shop order is `CANCELED` `QR_PAYEE_MISMATCH`, no wallet URL, `pay-qr` refuses. Routes into CNY come from KZT/USD; forecast shows a CNY shortfall funded from KZT. `privacy notice` mentions PIPL cross-border processing | I2, I3; A5 |
| D-CN2 | Dana, Alipay/WeChat Pay capture | Log a day of Chinese spending; see the card's hidden fee | Three captures `LOGGED` in CNY with KZT amounts; two `BUDGET_EACH` notifications; the CNY charge on the KZT card settles with a 4 % markup (`FEES_SETTLED`, fee x-ray profile CNY→KZT 400 bps). No proposal or payment (I6). No DCC flag (CNY-denominated charges are not DCC) | I6 |
| D-CN3 | Li Wei, Chinese master's student in Budapest (home CNY) | Pay EUR tuition from CNY; see coverage; receive money from home | Three CNY → EUR routes, cheapest first; coverage funds EUR and HUF needs from CNY; tuition `ASK`, funded from CNY via `cny-mock-bank`, approved → `SENT`; Dana and Li cannot read each other's orders (404) | I3, I8; A4-style BOLA |

**D-CN1 (Shanghai handoff):**
```bash
$S up --fresh && $S register dana --claim-demo
$S mark dcn1
$S as dana settings patch '{"region":"CN"}'          # tightening → instant: settings.region "CN", pending []
$S as dana privacy notice                            # text ends with "Region CN (PIPL): … cross-border transfer … separate consent …"
$S tool get_obligations '{}' --as dana               # dorm fee: payeeRef payee_4, 180000 CNY, homeAmountMinor 13280964 (₸132,809.64), due 2026-11-15
$S tool get_routes '{"fromCurrency":"KZT","toCurrency":"CNY","amountMinor":180000,"dueDate":"2026-11-15"}' --as dana
#   kzt-mock-bank ₸1,720.45 < kzt-card ₸5,312.39 < kzt-home-bank ₸9,890.57 (costHomeMinor 172045 / 531239 / 989057)
$S tool get_routes '{"fromCurrency":"USD","toCurrency":"CNY","amountMinor":180000,"dueDate":"2026-11-15"}' --as dana
#   usd-mock-bank ₸1,387.76 (cheapest overall) < usd-card ₸3,322.20
$S tool forecast_coverage '{}' --as dana             # CNY shortfall {2026-11-15, 180000}; suggestion KZT → CNY 180000 via kzt-mock-bank
$S tool propose_order '{"payeeRef":"<dorm payeeRef>","amountMinor":180000,"currency":"CNY","purpose":"Dorm fee November 2026"}' --as dana
#   decision HANDOFF, reasonCodes [HANDOFF_REGION], "CN¥1,800.00 (≈ KZT 132,809.64)"
$S as dana order <proposalId>                        # canonical order: payeeName "Dorm Office in Shanghai", 180000 CNY, rail HANDOFF, hashMatches true
$S as dana approve <proposalId>                      # paymentStatus PROCESSING (the QR is issued; nothing moved yet)
$S as dana handoff <paymentId>                       # check MATCH, nameSimilarity 1, walletUrl set; QR payload names Shanghai, CN
$S as dana pay-qr <paymentId>; $S as dana payment <paymentId>    # paid → status SENT
# Swapped QR (A5) on the shop purchase:
$S mock qr-swap on
$S as dana say "Buy a bedding set from Buy Everything Shop from China for ¥349"   # plannerSees "… from payee_N …"
$S tool propose_order '{"payeeRef":"<shop payeeRef>","amountMinor":34900,"currency":"CNY","purpose":"Bedding set"}' --as dana   # HANDOFF
$S as dana approve <proposalId>                      # paymentStatus CANCELED, reasonCodes [QR_PAYEE_MISMATCH]
$S as dana handoff <paymentId>                       # qrPayeeName "Unknown Trading Company" vs verified shop, similarity ≈ 0.63, walletUrl null
$S as dana pay-qr <paymentId>                        # ok:false, "no Pay button"; payment stays CANCELED; balances unchanged
$S mock qr-swap off
$S evidence dcn1 --since dcn1; $S ledger-verify
```

**D-CN2 (Alipay/WeChat Pay capture + fee x-ray):**
```bash
$S mark dcn2
$S demo trigger cn-spending-day
#   alipay ¥32.50 → ₸2,397.95 groceries ("CN¥32.50 at Convenience Store (sample). Groceries: …% used …")
#   wechat ¥45.00 → ₸3,320.24 eating_out; KZ bank ¥268.00 on card *4821 → ₸19,773.88, PENDING
#   (each converted with the rate for its purchase date, 2026-10-26; offline the example table answers and reports
#   its own date 2026-10-27 as rateDate, live (--live-fx) it is the published rate of that day)
$S as dana notifications --limit 3                   # two BUDGET_EACH
$S demo trigger settlement                           # settles the CNY charge on the KZT card: feeHomeMinor 79096 (₸790.96), markupBps 400, dcc null,
                                                     # cardProfile CNY→KZT 400 bps (1 sample); the card-less wallet charges stay PENDING
$S as dana fees                                      # profiles incl. CNY→KZT 400; dccWarnings []; monthlyFeesLostHomeMinor includes 79096
$S as dana notifications --limit 1                   # FEES_SETTLED "BUY EVERYTHING SHOP FROM CHINA: KZT 790.96 in conversion fees (4.00% over mid)."
$S as dana proposals                                 # no proposal came from capture (I6)
```

**D-CN3 (Li Wei, CNY → EUR):**
```bash
$S register li --claim-demo li-wei                   # userId 1c6e6d69-…, displayName "Li Wei"; signs base rules + suggested rent mandate (HUF 190,000)
$S mark dcn3
$S as li balances                                    # homeCurrency CNY: ¥60,000 / €450 / HUF 95,000
$S tool get_obligations '{}' --as li                 # rent HUF 165,000 due 2026-11-05 (payee_1), tuition €3,200 due 2026-11-10 (payee_2), RF32RUB2026L03318
$S tool get_routes '{"fromCurrency":"CNY","toCurrency":"EUR","amountMinor":320000,"dueDate":"2026-11-10"}' --as li
#   cny-mock-bank ¥162.80 < cny-card ¥398.40 < cny-home-bank ¥548.40 (costHomeMinor 16280 / 39840 / 54840)
$S tool forecast_coverage '{}' --as li               # EUR shortfall {2026-11-10, 275000}, HUF {2026-11-05, 7000000}; both funded from CNY via cny-mock-bank
$S tool propose_order '{"payeeRef":"payee_2","amountMinor":320000,"currency":"EUR","purpose":"Tuition RF32RUB2026L03318"}' --as li
#   ASK [ABOVE_SMALL_AUTO_LIMIT]; "€3,200.00 (≈ CN¥26,560.00) … at most CN¥26,990.03"
$S as li order <proposalId>                          # fundingCurrency CNY, fundingRouteId cny-mock-bank, fundingAmountMinor 2699003, markup 50 bps
$S as dana order <proposalId>                        # 404: another user's order (BOLA)
$S as li approve <proposalId>; $S demo clock +1h; $S as li payment <paymentId>   # PROCESSING → SENT; bank debited ¥26,722.80 (¥26,560 + ¥132.80 markup + ¥30 fee)
$S mock remittance --amount 12000 --currency CNY --profile li-wei               # parents' monthly ¥12,000 → Li's wallet only
$S as li notifications --limit 1                     # MONEY_FROM_HOME
$S evidence dcn3 --since dcn3; $S ledger-verify; $S down
```

### Security scenarios (deterministic Vitest; run and judge)

Run each file with `bun run --cwd apps/api vitest run <file>` (path relative to `apps/api`). PASS = every test
passes **and** the tests listed actually assert the expected outcome. Read the test names and assertions.
"Gap" = no dedicated test yet: report it as a finding (FAIL: not covered), do not try to exploit it.

**Compromised agent (planner)**

| ID | Threat | Expected | Test files (`apps/api/…`) | Inv. / attack |
| --- | --- | --- | --- | --- |
| C1 | Planner pays directly | Agent has no payment path; payments without approval → `NO_APPROVAL` | `test/intel/agent-loop.test.ts` (11 tools, only write = propose_order; no payments/rails imports), `test/attacks/A3.test.ts` (no approval), `test/core/payments.test.ts` (NO_APPROVAL) | I1, I2; A3 |
| C2 | Forged approval | `BAD_SIGNATURE`, no payment | `test/attacks/A3.test.ts` (forged row), `test/core/payments.test.ts` (tampered signature, tier upgrade) | I2; A3 |
| C3 | Replay of an approval / assertion | `NONCE_USED`; re-approve → `NOT_PENDING` | `test/attacks/A3.test.ts` (replay, replayed assertion), `test/core/payments.test.ts` (exactly once) | I4; A3 |
| C4 | Tamper with the order after signing / lying confirmation | `ORDER_HASH_MISMATCH` | `test/core/payments.test.ts` (tampered stored order), `test/core/orders-onboarding.test.ts` (A8-style assertion over a different order) | I3; A8 |
| C5 | Prompt injection: hidden instruction in a supplier PDF (C5a); lookalike "new IBAN" email (C5b) | Document text is data; Reader-verified fields only; account change → new COOLING payee, rent unaffected | `test/intel/reader.test.ts` (evidence checks, injected text ignored), `test/intel/agent-loop.test.ts` (reader mismatches → rules; REFUSE/COOLING stop), `test/core/payees-mandates.test.ts` (A2-style). **Gap:** no end-to-end A1 test | I7, I10; A1, A2 |
| C6 | Inject a new payee (C6a); exfiltrate PII through tool outputs (C6b) | Unknown refs never reach rules; outputs only carry placeholders | `test/intel/agent-loop.test.ts` (unknown / non-payee reference), `test/core/payees-mandates.test.ts` (COOLING), `test/intel/redact.test.ts` (detectors, deep redaction, middleware). Persona check: P1 tool outputs show only `payee_N` / `iban_N` | I7, I11; A2 |

**Compromised services**

| ID | Threat | Expected | Test files | Inv. / attack |
| --- | --- | --- | --- | --- |
| S1 | Stolen rules signing key (no user passkey) | Payments verify the passkey against their own credential store (T2) or the signed mandate / base rules (T1) | `test/core/payments.test.ts` (own credential store; T1 mandate scope + stored assertion; widened mandate; small-auto needs signed base rules). Honest limit: small-auto orders under the signed limit rely on the base-rules signature (spec §2 one-process limit) | I2, I5 |
| S2 | Forged mock webhooks | 401 for missing / bad signature or an altered body | `test/core/webhooks.test.ts` (HMAC) | I13 |
| S3 | Replayed / stale webhooks | Outside 5 min → refused. **Gap:** no test for a replay inside the window (no event-id dedupe) | `test/core/webhooks.test.ts` (5-minute window on the demo clock) | I13 |
| S4 | Swapped QR | `QR_PAYEE_MISMATCH`, no Pay button, never SENT | `test/screening/screening.test.ts` (checkQrPayee, 0.92 threshold). **Gap:** no end-to-end A5 test | A5 |
| S5 | Malicious Reader output / document with a wrong amount | Field `UNVERIFIED` → `READER_SOURCE_MISMATCH` → refuse | `test/intel/reader.test.ts`, `test/intel/agent-loop.test.ts` (readerChecks → rules) | I10 |
| S6 | Tampered ledger row | Verification fails at that seq | `test/core/ledger.test.ts` (altered payload, deleted entry, re-hashed forgery, forged checkpoint) | I12 |
| S7 | Stolen / guessed demo admin token | Constant-time check; routes absent when demo is off; production refuses weak tokens; rate limited | `test/security/http-hardening.test.ts` (demo admin hardening, rate limits) | I13 |
| S8 | Fake issuing authorization abuse (second charge, wrong merchant / amount, unsigned) | Declined; authorize endpoint needs HMAC | `test/core/webhooks.test.ts` (FakeIssuing one-time card). Persona check: P1 pizza second charge | I2 |
| S9 | Malicious mock bank status | **Gap:** no test; a signed status update is trusted as-is (honest limit) | none | I13 |

**Compromised triggers**

| ID | Threat | Expected | Test files | Inv. / attack |
| --- | --- | --- | --- | --- |
| T1 | Fake POS event asking for 10× stock | Trigger only logs / drafts; risk `TRIGGER_ORIGIN`, never approves | `test/rules/decide.test.ts` (triggerOrigin → ASK + TRIGGER_ORIGIN). **Gap:** no end-to-end A7 test | I6; A7 |
| T2 | Shortcut token abuse | Unknown token → 401; capture only logs; sensitive rate limit | `test/security/http-hardening.test.ts` (public routes with own auth; Shortcut capture budget), `test/intel/parsers.test.ts` (Shortcut payloads) | I6, I13 |
| T3 | Notification injection ("pay X to IBAN …" inside a notification) | Parsed as a spend or ignored; never a proposal | `test/intel/agent-loop.test.ts` (log_expense only logs), `test/intel/integration.test.ts` (capture pipeline) | I6, I10 |

Cross-cutting: IDOR / ownership in `test/core/orders-onboarding.test.ts` (other users get 404) and
`test/security/http-hardening.test.ts` (deny-by-default). Whole suite: `bun run --cwd apps/api test`.

## 6. How the harness works (for reviewers)

- `sim up` starts **one daemon** (`apps/api/scripts/sim/daemon.ts`). PGlite allows one process per data
  directory, so only the daemon opens `.data/sim/pglite`. It hosts the real API (`buildServer`, 127.0.0.1:4000,
  demo routes on, `TRUST_PROXY=true` so each persona gets its own simulated client IP) and the harness control
  port (127.0.0.1:4099, random token in `.data/sim/token`), and it starts mock-world as a child process (:4001,
  same HMAC secret). Env overrides are passed explicitly; `.env` files are neither read by the CLI nor edited.
- User actions go over HTTP to the real API, like the app. Personas keep a software passkey (ES256, the test
  `SoftAuthenticator`) in `.data/sim/personas/<name>.json`. The CLI handles 401 (refresh or passkey re-login),
  429 (Retry-After) and 403 `AI_CONSENT_REQUIRED` (`POST /privacy/ai-consent`, then retry).
- Planner tools go to the control port, which builds the **real** `agent/tools.ts` with the real `Redactor` and
  the per-conversation placeholder map, and stores the redacted messages like a real turn. The control port is
  **harness only**: it is never registered in `src/server.ts`. It only reaches `agent/` and `rules.proposeOrder`.
- Differences from the live loop: no 8-round cap, and `stopRequested` is advisory. Reader results are persisted per
  document and apply to later proposals in any turn or conversation (live loop and sim alike); `propose_order`
  also accepts `docIds` to cite the source document explicitly.
