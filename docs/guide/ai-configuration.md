# AI configuration

Provider-agnostic (Vercel AI SDK). Models: the **planner** (chat agent, with tools), the **Reader** (extraction from invoices and statements) and, optionally, voice transcription for the voice Shortcut.

## Modes

| Mode | Setting | Needs |
| --- | --- | --- |
| Live (default) | `AGENT_MODE=LIVE`, `PLANNER_MODEL`, `READER_MODEL` | A key for the provider, e.g. `OPENROUTER_API_KEY`. No key or unreachable model: served from the matching recording, labelled **Replay** |
| Replay | `AGENT_MODE=REPLAY` | Nothing. Recorded tool calls from `fixtures/agent-recordings/` via the AI SDK mock model; every tool still runs for real |

`AI_REPLAY_FALLBACK=false` disables the fallback, so a failed model call shows its error.

::: warning Replays are hand-written
Files in `fixtures/agent-recordings/` say `"recordedWith": "hand-written"`. Running a scenario live with `RECORD=1` and a model key overwrites a file with a real capture, and `recordedWith` names the model.
:::

## Models

`provider:model` strings; providers `openrouter`, `openai`, `google`, `local`. Bare ids are OpenRouter ids.

```bash
PLANNER_MODEL=openrouter:deepseek/deepseek-v4.1-flash-1017
READER_MODEL=openrouter:deepseek/deepseek-v4.1-flash-1017
VOICE_MODEL=openrouter:qwen/qwen3.8-omni-flash      # speech to text for the voice Shortcut
OPENROUTER_API_KEY=...                               # or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
```

- `OPENROUTER_PROVIDER` (optional JSON) pins OpenRouter hosts, e.g. `{"order":["parasail/fp8","baseten"],"allow_fallbacks":true}`.
- **Local:** any OpenAI-compatible endpoint at `LOCAL_BASE_URL` (default `http://localhost:11434/v1`, Ollama). `LOCAL_API_KEY` optional; `LOCAL_VISION=true` if the model takes images.

## Structured output and retries

- Order of attempts: native structured output, then one forced call of a never-executed schema-carrier tool, then JSON text. Every answer is schema-validated (one retry). `AI_STRUCTURED_MODE=native|tool|json` sets the first mode.
- 429 and 5xx are retried `AI_MAX_RETRIES` times (default 5), exponential backoff with jitter, honouring `Retry-After`.

## Turn time budget

A turn answers within `AGENT_TURN_TIMEOUT_MS` (default 75 s). No tool round starts after about 41 s; a model call is cut after `AGENT_STEP_TIMEOUT_MS` (30 s) without an answer or `AGENT_CHUNK_TIMEOUT_MS` (20 s) of stream silence. A cut turn gets one text-only answer over the tool results, else a code-written summary (`apps/api/src/modules/agent/budget.ts`, `summary.ts`).

## Consent

Chat, document upload and onboarding need AI consent (`aiConsent` at registration, or `POST /api/privacy/ai-consent`); seeded users start without it. In region CN with a model outside Kassa's server, cross-border consent is also needed (`POST /api/privacy/pipl-consent`; else 403 `PIPL_CONSENT_REQUIRED`).

## What the model sees

Payees appear as placeholders (`payee_1`, `payee_2`, …) mapped back by the server; no real names or account numbers. Document text reaches the planner quoted, cut to 160 characters and flagged when it looks like instructions. See the [security self-assessment](../security/self-assessment.md) and [privacy notes](../security/privacy.md).
