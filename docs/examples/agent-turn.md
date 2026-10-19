# An agent turn

One `POST /api/agent/message` per turn. The reply streams as server-sent events in the [AI SDK UI message stream](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) format: text, tool calls, tool results and any proposal card.

## Send a message

AI consent is needed once per account; without it the API answers 403 `AI_CONSENT_REQUIRED`. `auth` is from [Call the API](./api-basics.md).

```bash
curl -s "${auth[@]}" -H 'content-type: application/json' -H 'origin: http://localhost:8081' \
  -d '{"consent":true}' localhost:4000/api/privacy/ai-consent
# {"aiConsentAt":"2026-10-27T09:01:53.237Z"}

curl -sN "${auth[@]}" -H 'content-type: application/json' -H 'origin: http://localhost:8081' \
  -d "{\"conversationId\":\"$(uuidgen)\",\"text\":\"Pay my tuition\"}" \
  localhost:4000/api/agent/message
```

## Read the stream

Replayed tuition turn (shortened):

```text
data: {"type":"start","messageMetadata":{"replay":true},"messageId":"0TRpB4WWko1NC6Xf"}
data: {"type":"start-step"}
data: {"type":"text-delta","id":"t0","delta":"Let me check your upcoming bills."}
data: {"type":"tool-input-available","toolCallId":"replay-0-0","toolName":"get_obligations","input":{"withinDays":30}}
data: {"type":"tool-output-available","toolCallId":"replay-0-0","output":{"homeCurrency":"KZT","obligations":[
        {"payeeRef":"payee_1","payeeKind":"UNIVERSITY","payeeStatus":"VERIFIED","amount":"EUR 2,400.00",
         "homeAmount":"KZT 1,221,061.15","dueDate":"2026-10-31","reference":"RF39RUB2026F04217",
         "category":"tuition","coverage":"CONVERTIBLE", …}, …]}}
data: {"type":"finish-step"}
…
data: {"type":"finish","messageMetadata":{"replay":true}}
data: [DONE]
```

- `replay: true` comes from `AGENT_MODE=REPLAY`; the app shows a **Replay** badge. Live answers have none.
- The planner sees `payee_1`, never the payee's name or account. The server maps placeholders back.
- Tools run for real in replay too; only the model's words and tool choices are recorded.

## The decision is made by code

On `propose_order`, the rules engine (`apps/api/src/modules/rules/decide.ts`) decides and the tool result carries the decision. The model can only report it.

| Decision | Meaning | Example reason codes |
| --- | --- | --- |
| `AUTO` | Paid now, inside a signed mandate or the small-payment limit | `SMALL_AUTO`, `MANDATE_MATCH` |
| `ASK` | Exact order waits for the passkey | `ABOVE_SMALL_AUTO_LIMIT`, `SMALL_AUTO_BUDGET_EXHAUSTED` |
| `HANDOFF` | Region CN: handed to the user's QR wallet after the payee name check | `HANDOFF_REGION` |
| `REFUSE` | Nothing to approve | `INSUFFICIENT_FUNDS`, `REFUSE_UNVERIFIED_PAYEE`, `PAYEE_COOLING` |

After a `REFUSE` or a cooling payee, the turn gets no more tools.

## The same turns, live

From the [live agent run](../evidence/live-agent.md) on the judge build (2026-10-19, every turn answered by the live model):

| Prompt | Tools the planner called | Decision |
| --- | --- | --- |
| Please pay my tuition invoice now. | get_obligations, get_balances, get_routes, get_budget, propose_order | **ASK** `ABOVE_SMALL_AUTO_LIMIT`, approved with the passkey, then SENT |
| Pay this month's rent to my landlord, from the cheapest balance. | get_obligations, get_budget, get_balances, get_routes, propose_order | **REFUSE** `DUPLICATE_OBLIGATION_PAYMENT`: the rent mandate had already paid this period when the copy signed in |
| Order me 2 Margherita pizzas from Pizza Shop in Budapest. | search_catalog, get_budget, get_routes, get_fx_rate, propose_order | **ASK** `FIRST_PAYMENT_TO_PAYEE`, approved with the passkey, paid by a one-time card |

The live tuition answer:

> I've prepared the tuition payment — it needs your passkey. **Tuition: EUR 2,400.00 (≈ KZT 1,221,480.00)**, due 31 Oct, to your university (University in Budapest). Cheapest route is the Wise-like bank transfer, arriving 20 Oct: cost **KZT 7,708.14** incl. the KZT 990.00 fee, **KZT 41,151.06** cheaper than paying by card… It's above your auto-pay limit, so it waits for your passkey rather than being paid automatically.

In the rent turn the model proposed a second payment for an already paid period and `DUPLICATE_OBLIGATION_PAYMENT` refused it. Its reply text was raw tool-call markup, recorded as is.

Reproduce: `bun run evidence:live` (signs in to fresh copies, writes `docs/evidence/live-agent.md` and `.json`).

## Approve an order

1. `GET /api/orders/:proposalId` returns the exact order, budget impact, payee status and `webauthnOptions`; the challenge is the canonical order's hash (`orderHash`, RFC 8785 JCS).
2. The app signs it with the passkey and posts the assertion to `POST /api/orders/:proposalId/approve`. On a dev sign-in, `POST /api/auth/dev/assert` signs with the server-held test key.

Payments verifies the rules' Ed25519 signature over the same order before any rail is called, so a signed order cannot be edited on the way.
