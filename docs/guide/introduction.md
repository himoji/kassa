# Introduction

Kassa is a finance agent for people whose money lives in one country and whose bills live in another, starting with international students. It was built for the 2026 Shenzhen International FinTech Competition (FinTechathon), International Track, **Topic C: Cross-border and Student Finance Assistant**, under the theme "AI as a Financial Participant".

## The problem

International students have money in one country and bills in another: card FX fees they never see, irregular money from home, and "your landlord's bank details changed" scams aimed at newcomers.

## What Kassa does about it

The agent does real financial work. It logs spending in every currency, exposes hidden card fees, plans bills against a forecast and pays by the cheapest route.

- **Inside a mandate** the user signed with a passkey (rent and insurance to verified payees, small purchases under a signed limit), it pays on its own, with no prompt at payment time.
- **Anything else** it prepares as an exact order that the user approves with a passkey.
- **Plain code, not the model, decides which case applies.** The agent cannot raise a limit, skip the 24-hour cooling period for a new payee, or pay above a signed cap.

> The agent can prepare anything, but only your signature, now or in a mandate signed earlier, can move your money.

## The hero user

Dana is a Kazakh master's student in Budapest. Her money arrives in KZT and USD; her bills are in HUF and EUR. Her seeded data also has a CNY dorm fee (Dorm Office in Shanghai, CNY 1,800) for an exchange semester, used by the China-region scenes in the [demo script](../submission/demo-script.md).

## Five features that answer Topic C

1. **An agent that acts within signed limits.** The planner reads balances, budgets, bills and documents and proposes orders through its one money tool, `propose_order`. The [rules engine](../architecture/overview.md) decides AUTO, ASK, HANDOFF or REFUSE. AI runs live by default; if the model cannot be reached, the turn falls back to a recorded replay labelled **Replay** in the chat ([AI configuration](./ai-configuration.md)).
2. **Money from home, learned from bank statements.** Upload PDF, CSV, Excel, OFX or JSON statements in Russian, Kazakh or English. Kassa finds money from home and how regular it really is, one-off payments, spending trends and transfers between your own accounts, and plans with averages instead of the best month. See [Import a bank statement](../examples/statement-import.md).
3. **Bills, tuition and autopay.** Rent, tuition and insurance are planned against the forecast. A tuition payee comes from the school directory: the student ID brings in the open invoice, and the school's portal confirms when the money arrives. In region CN, Kassa hands off to the user's QR wallet after checking the payee name.
4. **Every currency, with fees exposed and the cheapest route.** Card taps, wallet notifications and Shortcut events are captured and categorised; budgets have a pace forecast; each bill gets a ranked list of funding routes.
5. **Credit building.** Bills paid on time become an Ed25519-signed credit record with a public verify link and a PDF. See [Issue and verify a credit record](../examples/credit-record.md).

## How it covers the brief

| Pain point named in the brief | What Kassa does | Where |
| --- | --- | --- |
| Remittances | Money from home (KZT, USD) is logged as it arrives; each bill gets the cheapest funding route with the FX cost shown | [Route and FX optimizer](../architecture/overview.md) |
| Tuition payments | The agent reads the invoice, checks the payee and prepares the transfer; the student approves the exact order with a passkey | [An agent turn](../examples/agent-turn.md) |
| Credit building | A signed credit record a landlord or bank can verify | [Credit record example](../examples/credit-record.md) |
| Multi-currency management | Spending in every currency with a home-currency equivalent, budgets with a pace forecast, a fee x-ray for card FX markups | Capture, budget and fee x-ray modules |

## Around the core

- **Recipients by what you pay:** people, tuition, rent, bills and shops, each with its own details (student ID, customer number, landlord reference). Details can change without a new cooling period; where the money goes cannot.
- **Linked cards and banks** (Stripe test card, EU or Kazakh bank account), each confirmed with the passkey, and fast sends from them. See [Sandbox payments](./sandbox-payments.md).
- **Add money** through a stand-in for the phone's wallet sheet (test money only).
- **Send to another Kassa user** by Kassa ID, with the same 24-hour cooling.
- **KassaLite**, a free-Apple-ID iPhone build that sees real Apple Pay taps ([KassaLite](./kassalite.md), [Shortcuts](./shortcuts.md)).
- **Small business mode** (hidden by default; `EXPO_PUBLIC_SHOW_BUSINESS=true`): stock forecast, purchase orders signed with the passkey and a three-way invoice match.

## Scope

Everything runs in sandbox and simulated mode. There is no real money, no real bank or Wise API, and no custody; in production the wallet would be held by a licensed bank or e-money institution. All companies in the demo are fictitious. The statement importer reads real banks' file formats (for example Kaspi) and names them; Kassa is not affiliated with any of them.

Dates in the evidence (late October and November 2026) are on the **demo clock**: the seed data is a story set on 2026-10-27. The app runs on real time by default; Settings → Demo → **Demo time** turns the story clock on.
