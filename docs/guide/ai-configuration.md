# AI configuration

Kassa is provider-agnostic (Vercel AI SDK). Two roles use a model: the **planner** (the chat agent, with tools) and the **Reader** (structured extraction from invoices and statements). A third, optional model transcribes the voice Shortcut.

## Modes

| Mode | Setting | Needs |
| --- | --- | --- |
| Live (default) | `AGENT_MODE=LIVE`, `PLANNER_MODEL`, `READER_MODEL` | One key for the chosen provider, for example `OPENROUTER_API_KEY`. Without a key, or if the model is unreachable, the turn is served from the matching recording and labelled **Replay** |
| Replay | `AGENT_MODE=REPLAY` | Nothing. Recorded tool calls from `fixtures/agent-recordings/` are served through the AI SDK mock model; every tool still runs for real |

`AI_REPLAY_FALLBACK=false` turns the live-mode fallback off, so a failed model call shows its error instead.

::: warning Replays are hand-written
The files in `fixtures/agent-recordings/` say `"recordedWith": "hand-written"`. Running a scenario live with `RECORD=1` and a model key overwrites a file with a real capture, and `recordedWith` then names the model.
:::

## Models

Models are `provider:model` strings. Providers: `openrouter`, `openai`, `google`, `local`. Bare ids are treated as OpenRouter model ids.

```bash
PLANNER_MODEL=openrouter:deepseek/deepseek-v4.1-flash-1017
READER_MODEL=openrouter:deepseek/deepseek-v4.1-flash-1017
VOICE_MODEL=openrouter:qwen/qwen3.8-omni-flash      # speech to text for the voice Shortcut
OPENROUTER_API_KEY=...                               # or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
```

- `OPENROUTER_PROVIDER` (optional JSON) pins which OpenRouter hosts serve the planner and Reader, for example `{"order":["parasail/fp8","baseten"],"allow_fallbacks":true}`.
- **Local:** `local` is any OpenAI-compatible endpoint at `LOCAL_BASE_URL` (default `http://localhost:11434/v1`, Ollama). `LOCAL_API_KEY` is optional; set `LOCAL_VISION=true` if the model accepts images.

## Structured output and retries

- Structured output works with any model: native structured output first; if the provider rejects it, one forced call of a schema-carrier tool that never executes; if tools are rejected too, JSON text. Every answer is validated with the same schema (one retry). `AI_STRUCTURED_MODE=native|tool|json` sets the first mode to try.
- 429 and 5xx answers are retried `AI_MAX_RETRIES` times (default 5) with exponential backoff and jitter, honouring `Retry-After`.

## Turn time budget

A chat turn answers within `AGENT_TURN_TIMEOUT_MS` (default 75 s). No tool round starts after about 41 s; a model call is cut when it shows no answer within `AGENT_STEP_TIMEOUT_MS` (30 s) or its stream is silent for `AGENT_CHUNK_TIMEOUT_MS` (20 s). A cut turn gets one text-only answer over the tool results, and if that fails a code-written summary (`apps/api/src/modules/agent/budget.ts`, `summary.ts`).

## Consent

Chat, document upload and onboarding need the user's AI consent (`aiConsent` at registration, or `POST /api/privacy/ai-consent`). Seeded users have no consent until they give it. In region CN, with a model outside Kassa's server, a separate cross-border consent is needed (`POST /api/privacy/pipl-consent`; without it the API answers 403 `PIPL_CONSENT_REQUIRED`).

## What the model sees

The planner never sees real names or account numbers: payees appear as placeholders (`payee_1`, `payee_2`, …) that the server maps back. Text read from documents reaches the planner quoted, cut to 160 characters and flagged when it looks like instructions. Details are in the [security self-assessment](../security/self-assessment.md) and [privacy notes](../security/privacy.md).
