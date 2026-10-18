# Pitch (10 minutes)

The spoken script for the presentation deck ([Kassa — FinTechathon 2026](https://claude.ai/artifact/Sdktm1BZ9157k6Lj1qa4Y7)), one section per slide, with timings. The brief allows at most 10 minutes; the script runs about 9:30, which leaves room for one live click. The demo video ([DEMO_SCRIPT.md](DEMO_SCRIPT.md)) is a separate submission item; slide 7 shows a 60-second cut of it or the live judge build.

Two lines to repeat:

- Pitch line: "Kassa's agent pays your bills across borders on its own, inside the limits you signed."
- Safety line: "The agent can prepare anything, but only your signature, now or in a mandate signed earlier, can move your money."

Every figure below is in the repository. Do not round them up on stage.

## Elevator version (30 seconds)

International students live in two currencies: money arrives from home in one, bills are due abroad in another. Kassa is an AI agent that does that money work for them. It reads their bank statements, plans rent and tuition against a forecast, picks the cheapest route and pays. Inside a mandate the student signed with a passkey it pays on its own; anything else it prepares as an exact order for the student to sign. Code, not the model, decides which is which, so we recreated sixteen famous attacks on AI agents with money: a naive agent pays all sixteen, Kassa pays none.

## The script

| # | Slide | Time | Say |
| --- | --- | --- | --- |
| 1 | Kassa | 0:00–0:30 | "We built Kassa for Topic C, cross-border and student finance, under this year's theme: AI as a financial participant. Kassa is an AI agent that pays your bills across borders, inside the limits you signed. One sentence to remember: the agent can prepare anything, but only your signature can move your money." |
| 2 | The problem | 0:30–1:20 | "Meet Dana, a Kazakh master's student in Budapest. Her money arrives in tenge and dollars, her rent is in forints, her tuition in euros. Three things hurt her. Card fees she never sees: markups over the mid rate and the 'pay in your home currency?' trick. Money from home that is irregular: a big transfer one month is not a salary, and planning with the best month means a short rent. And scams that look like bills: 'your landlord's bank details changed' is aimed squarely at newcomers. An ordinary wallet solves none of the three." |
| 3 | AI as a financial participant | 1:20–2:10 | "So Kassa is not a wallet with a chatbot. It is an agent with a signed job description. One: the agent proposes. It reads balances, bills, statements and invoices and drafts an exact order, but it has no payment tool. Two: plain code decides: caps, verified payees, a 24-hour cooling period for any new payee, sanctions screening. Three: your passkey signs, either now, for this exact order, or earlier, in a mandate for rent, insurance or small purchases. Inside a mandate the agent pays with no prompt. That is what 'participant' means to us: real authority, bounded by code and by a signature." |
| 4 | What the agent does | 2:10–2:50 | "Day to day it does four jobs. It plans every bill against a 45-day forecast per currency and warns you the day a balance would fall below your reserve. It x-rays card fees and picks the cheapest way to fund each bill. It logs spending in every currency, from card taps, wallet notifications and an iPhone Shortcut. And it builds a credit record, which I'll come back to." |
| 5 | It knows your past | 2:50–3:30 | "On day one it asks for your bank statements, PDF, CSV, Excel, from every bank you use, in Kazakh, Russian or English. Plain code reads them, no model call: in our test, 1,501 rows from three real statements. It finds how regular your money from home really is, separates one-off payments and transfers between your own accounts, and drafts your caps and budgets. Account numbers and IDs never reach a model. You review the draft and sign it." |
| 6 | Credit building | 3:30–4:10 | "A new country means no credit history. Dana has paid rent on time for six months and cannot prove it. Kassa turns paid bills into a record she can share: she picks the period and what to include, Kassa signs it with Ed25519 and writes it to a tamper-evident ledger, and the landlord opens a public link that checks the signature. Only what she picked leaves." |
| 7 | The demo | 4:10–5:10 | Play the 60-second cut, or click through the judge build live: "Here Dana's parents send a million tenge. She forwards the tuition invoice; the Reader pulls out the payee, amount and reference, each one found in the document; the agent shows the cheapest route and an exact order; she approves with her passkey. Three days later is rent day: the agent pays the verified landlord on its own, inside the mandate she signed. Then the lookalike landlord email with a new IBAN arrives: the new payee sits in 24-hour cooling and is never paid on autopilot." |
| 8 | System architecture | 5:10–5:50 | "Under the hood: two AI calls, both fenced in. The planner reads and proposes; it sees placeholders, never real account numbers. The Reader turns untrusted documents into typed fields, with no tools and no memory, and every field must be found in the source. Everything that moves money is plain code: rules decide, payments checks the signature again on its own, and every action lands in a hash-chained, signed ledger. A lint rule forbids the agent module from even importing the payment code." |
| 9 | Core algorithms | 5:50–6:30 | "Three formulas the model never overrides. The cheapest route: fee plus amount times rate times markup, over every currency and rail, dropping any route that arrives late or overdraws. The coverage forecast: balance today plus incomes minus bills minus median daily burn, per currency. And a risk score, a weighted sum of seven signals; at 0.5 or above, Kassa asks. Then a fixed decision order, refusals first, so a mandate can never pay a cooling payee or an amount above a cap." |
| 10 | Permission tiers | 6:30–7:10 | "That gives four tiers. T0: read and advise, the agent alone. T1: automatic inside a mandate you signed. T2: anything else, you approve the exact order. T3: never, whoever asks: no approval, a payee in cooling, above a signed cap. Loosening any rule needs your passkey and waits 24 hours; tightening applies at once." |
| 11 | Attacks recreated | 7:10–7:50 | "Does it hold? We recreated sixteen attacks, including the famous ones: Freysa, Grok and Bankrbot, AIXBT, fake memories, the one-dollar Tahoe, 'move your money to a safe account'. In each, the model obeys the attacker; we assume the worst. A naive agent with the same intent pays sixteen of sixteen. Kassa pays zero of sixteen, 49 of 49 guarded cases blocked. The model can be fooled; your money cannot be moved by fooling it." |
| 12 | Controls and risks | 7:50–8:30 | "Security and compliance are written down, not claimed. Passkeys for every approval, a hash-chained ledger, sanctions screening with transliteration, redaction before any model, data export and erase, thirteen invariants each with a code path and a test, and a mapping to EU and Chinese rules. And the risks we name ourselves: sandbox rails only, self-assessed, no hardware key store yet." |
| 13 | Evidence | 8:30–9:10 | "Every claim leaves a log. The attack results against the naive baseline, a 55-entry ledger verified with signed checkpoints, persona simulations, and a live run of the Reader on 30 labelled invoices: 21 read perfectly, every field at 83 to 97 percent. A misread can delay a payment but cannot redirect it: money only goes to a payee that is verified and out of cooling. All of it is in the repository, and the evidence room replays the attacks in your browser." |
| 14 | Check it yourself | 9:10–9:30 | "You can check all of this without a passkey device: the judge build gives every reviewer a private, ready copy of Dana. The repository has 2,430 automated tests, deployment steps and the security self-assessment." |
| 15 | Where it stands | 9:30–10:00 | "Kassa is built, tested and ready to inspect. Next: a licensed e-money partner, so the sandbox rails become real ones. The agent can prepare anything. Only your signature can move your money. Thank you." |

## Questions to expect

| Question | Answer |
| --- | --- |
| Is any real money moved? | No. Sandbox and simulated rails, a mock bank, fictitious companies. In production the wallet sits with a licensed bank or e-money institution; Kassa is the agent and the rules on top. |
| What if the model is jailbroken? | We assume it is. The attack suite uses models that obey the attacker. The model has no payment tool; rules and payments are plain code that check a passkey signature over the exact order hash. |
| Why not let the user approve everything? | Then it is a form, not an agent. Mandates let the agent pay rent and insurance to verified payees with no prompt, and the risk score keeps prompts for the cases that need them. |
| Which model do you use? | Any provider through one interface; the deployment uses a small, cheap model (`PLANNER_MODEL`, `READER_MODEL`). Without a key the chat answers from recorded replays and labels them "Replay". |
| How accurate is the Reader? | 21 of 30 labelled invoices exact on every field; per field 83 % (reference) to 97 % (due date), median 16 s (`docs/evidence/invoice-eval.json`). A wrong account number cannot pay: the payee must already be verified and out of cooling. |
| Credit record: who trusts it? | Today it is a signed, verifiable statement of facts from the ledger, not a score. A landlord can check it was not edited. Bureau reporting needs a licensed partner. |
| What about China? | Region CN: Kassa prepares the payment and hands it to the user's QR wallet after checking the payee name; a separate PIPL cross-border consent is required before any model outside the server sees data (`docs/COMPLIANCE.md`). |
| Blockchain? | Signed ledger checkpoints can be anchored on a testnet (`bun run ledger:anchor`); it is implemented and tested, no anchor is published yet. |
| What is not done? | Real rails, an external pentest, a hardware key store, and some stores are in memory. All listed in `docs/SECURITY.md` §7. |

## Submission checklist (from the brief)

| Item | Where | State |
| --- | --- | --- |
| 01 Technical documentation | `docs/ARCHITECTURE.md`, `docs/SECURITY.md` | Done |
| 02 Presentation deck (10 min or less) | The deck linked above, with this script | Done |
| 03 Demo video (5 min or less, optional) | `docs/DEMO_SCRIPT.md`, `bun run demo:video` | To record and link in README |
| 04 Source code | This repository, README, deployment steps, `docs/TESTS.md` | Make the repository public |
| 05 Security self-assessment | `docs/SECURITY.md` §2 (tiers), §7 (known risks) | Done |
| 06 Execution evidence | `docs/evidence/` | Done; a live-agent transcript is still to add |

Deadline: 2026-10-20, 23:59 Beijing time (15:59 UTC).
