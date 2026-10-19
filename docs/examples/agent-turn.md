# An agent turn

A chat turn is one `POST /api/agent/message`. The answer streams back as server-sent events in the [AI SDK UI message stream](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) format: text, every tool call the planner makes, every tool result, and the proposal card when it proposes a payment.

## Send a message

The user must have given AI consent first (once per account).

```bash
curl -s "${auth[@]}" -H 'content-type: application/json' -H 'origin: http://localhost:8081' \
  -d '{"consent":true}' localhost:4000/api/privacy/ai-consent
# {"aiConsentAt":"2026-10-27T09:01:53.237Z"}

curl -sN "${auth[@]}" -H 'content-type: application/json' -H 'origin: http://localhost:8081' \
  -d "{\"conversationId\":\"$(uuidgen)\",\"text\":\"Pay my tuition\"}" \
  localhost:4000/api/agent/message
```

`auth` holds the bearer token from [Call the API](./api-basics.md). Without consent the API answers 403 `AI_CONSENT_REQUIRED`.

## Read the stream

The first events of the replayed tuition turn (shortened):

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

What to notice:

- `messageMetadata.replay` is `true` because this stack runs `AGENT_MODE=REPLAY`. The app shows a **Replay** badge on such answers; a live answer has no badge.
- The planner sees `payee_1`, never the university's name or account. The server maps placeholders back for the user.
- Every tool runs for real, also in replay: only the model's words and tool choices are recorded.

## The decision is made by code

When the planner calls `propose_order`, the rules engine (`apps/api/src/modules/rules/decide.ts`) decides, and the tool result carries the decision. The model can only report it.

| Decision | Meaning | Example reason codes |
| --- | --- | --- |
| `AUTO` | Paid now, inside a signed mandate or the small-payment limit | `SMALL_AUTO`, `MANDATE_MATCH` |
| `ASK` | An exact order waits for the user's passkey | `ABOVE_SMALL_AUTO_LIMIT`, `SMALL_AUTO_BUDGET_EXHAUSTED` |
| `HANDOFF` | Region CN: prepared, then handed to the user's QR wallet after the payee name check | `HANDOFF_REGION` |
| `REFUSE` | Nothing to approve | `INSUFFICIENT_FUNDS`, `REFUSE_UNVERIFIED_PAYEE`, `PAYEE_COOLING` |

After a `REFUSE` or a payee in cooling, the turn gets no more tools: the model can only explain.

## The same turns, live

From the [live agent run](../evidence/live-agent.md) on the judge build (2026-10-18, every turn answered by the live model):

| Prompt | Tools the planner called | Decision |
| --- | --- | --- |
| Please pay my tuition invoice now. | get_obligations, get_profile_summary, get_balances, get_routes, get_payee_facts, get_budget, propose_order | **REFUSE** `INSUFFICIENT_FUNDS` (EUR 2,400 and no single balance covers it) |
| Pay this month's rent to my landlord, from the cheapest balance. | get_obligations, get_balances, get_profile_summary, get_routes, get_payee_facts, get_budget, propose_order | **ASK** `ABOVE_SMALL_AUTO_LIMIT`, approved with the passkey, then SENT |
| Order me 2 Margherita pizzas from Pizza Shop in Budapest. | search_catalog, get_payee_facts, get_budget, get_balances, get_routes, propose_order | **AUTO** `SMALL_AUTO`, paid by a one-time card |

The live tuition answer, after the refusal:

> **Payment refused — no money was sent.** Tuition: EUR 2,400.00 (≈ KZT 1,221,480.00), University in Budapest, due 31 Oct 2026. The system returned REFUSE (INSUFFICIENT_FUNDS): no single balance can cover the invoice plus its fees… What each balance can pay at most for EUR (fees included): KZT 900,000.00 → EUR 1,756.73 via Mock bank transfer…

Reproduce it against the judge build with `bun run evidence:live` (it signs in to fresh copies and writes `docs/evidence/live-agent.md` and `.json`).

## Approve an order

An `ASK` proposal is approved in two calls. `GET /api/orders/:proposalId` returns the exact order with the server's budget impact and payee status, and `webauthnOptions` whose challenge is the canonical order's hash (`orderHash`, RFC 8785 JCS). The app signs that challenge with the passkey and posts the assertion to `POST /api/orders/:proposalId/approve`. On a dev sign-in, `POST /api/auth/dev/assert` signs the challenge with the server-held test key instead. Payments then verifies the rules' Ed25519 signature over the same order before any rail is called, so a signed order cannot be edited on the way.
