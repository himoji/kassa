# Introduction

Kassa is a finance agent for international students, whose money lives in one country and bills in another. Built for the 2026 Shenzhen International FinTech Competition (FinTechathon), International Track, **Topic C: Cross-border and Student Finance Assistant**, theme "AI as a Financial Participant".

## The problem

Hidden card FX fees, irregular money from home, and "your landlord's bank details changed" scams aimed at newcomers.

## What Kassa does about it

The agent logs spending in every currency, exposes card fees, plans bills against a forecast and pays by the cheapest route. Inside a passkey-signed mandate (rent and insurance to verified payees, small purchases under a signed limit) it pays on its own; anything else it prepares as an exact order for passkey approval. **Plain code, not the model, decides which.** The agent cannot raise a limit, skip the 24-hour cooling period for a new payee, or pay above a signed cap.

> The agent can prepare anything, but only your signature, now or in a mandate signed earlier, can move your money.

## The hero user

Dana, a Kazakh master's student in Budapest: income in KZT and USD, bills in HUF and EUR, plus a CNY dorm fee (Dorm Office in Shanghai, CNY 1,800) for the China scenes in the [demo script](../submission/demo-script.md).

## Five features that answer Topic C

1. **An agent within signed limits.** One money tool, `propose_order`; the [rules engine](../architecture/overview.md) decides AUTO, ASK, HANDOFF or REFUSE. Live AI by default, falling back to a labelled **Replay** ([AI configuration](./ai-configuration.md)).
2. **Money from home, from bank statements** (PDF, CSV, Excel, OFX, JSON; Russian, Kazakh, English): regularity, one-offs, trends, own-account transfers; plans use averages. [Import a bank statement](../examples/statement-import.md).
3. **Bills, tuition and autopay.** Tuition payees from the school directory by student ID, with portal confirmation. In region CN, handoff to the user's QR wallet after a payee-name check.
4. **Every currency, fees exposed, cheapest route.** Taps, wallet notifications and Shortcut events captured; budgets with pace forecast; ranked funding routes per bill.
5. **Credit building.** An Ed25519-signed credit record with a public verify link and PDF. [Issue and verify a credit record](../examples/credit-record.md).

## How it covers the brief

| Pain point | What Kassa does | Where |
| --- | --- | --- |
| Remittances | Logs money from home (KZT, USD); cheapest funding route per bill, FX cost shown | [Route and FX optimizer](../architecture/overview.md) |
| Tuition payments | Reads the invoice, checks the payee, prepares the transfer; student approves with a passkey | [An agent turn](../examples/agent-turn.md) |
| Credit building | Signed credit record a landlord or bank can verify | [Credit record example](../examples/credit-record.md) |
| Multi-currency management | Home-currency equivalents, budgets with pace forecast, fee x-ray for card FX markups | Capture, budget and fee x-ray modules |

## Around the core

- Recipients by type, with details that can change without new cooling (the destination cannot).
- Linked cards and banks, confirmed with the passkey ([Sandbox payments](./sandbox-payments.md)); Add money (test only); Send to another user by Kassa ID (24-hour cooling).
- [KassaLite](./kassalite.md), a free-Apple-ID iPhone build that sees real Apple Pay taps ([Shortcuts](./shortcuts.md)).
- Small business mode (`EXPO_PUBLIC_SHOW_BUSINESS=true`): stock forecast, passkey-signed purchase orders, three-way invoice match.

## Scope

Sandbox and simulated only: no real money, bank or Wise API, no custody (in production a licensed bank or e-money institution would hold the wallet). Demo companies are fictitious; the statement importer reads real banks' formats (for example Kaspi) without affiliation.

Evidence dates (late October and November 2026) are on the **demo clock**, with the seed story set on 2026-10-27. Settings → Demo → **Demo time** turns it on; otherwise the app uses real time.
