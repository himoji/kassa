# Environment variables

`bun run env:setup` writes a working local `.env`; `.env.example` lists the variables with comments. The API validates its environment at start-up (`apps/api/src/env.ts`) and refuses to start in production without real keys.

::: danger Never commit keys
`.env*` files are gitignored except `.env.example`, which holds no secrets. On Vercel, the values live in the project's environment variables.
:::

## Origins and passkeys

| Variable | Meaning |
| --- | --- |
| `PUBLIC_ORIGIN` | The web app's origin; the WebAuthn origin |
| `RP_ID`, `RP_NAME` | WebAuthn relying party |
| `EXTRA_ORIGINS` | Comma-separated extra WebAuthn origins |
| `PHONE_HOST` | Named-tunnel hostname for phone testing |
| `TRUST_PROXY` | Unset: socket address; `true` behind a proxy that overwrites `X-Forwarded-For`; or an IP/CIDR list |
| `HOST`, `PORT` | Where the API listens |

## Keys

| Variable | Used for |
| --- | --- |
| `SESSION_SECRET` | Session tokens |
| `RULES_SIGNING_KEY`, `RULES_PUBLIC_KEY` | Ed25519: rules sign approved orders; payments verifies with the public key only |
| `LEDGER_CHECKPOINT_KEY`, `LEDGER_CHECKPOINT_PUBLIC_KEY` | Ed25519 ledger checkpoints and head anchor |
| `CREDIT_RECORD_KEY` | Ed25519 credit records (v3) |
| `ACCOUNT_ENC_KEY` | AES-256-GCM for payee account details |
| `USER_KEK`, `USER_KEK_PREVIOUS` | Key-encryption key for per-user data keys (erasure is crypto-shredding); the previous one only during rotation |
| `MOCK_HMAC_SECRET` | HMAC on mock-world webhooks |

## AI

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_MODE` | `LIVE` | `LIVE` or `REPLAY` |
| `PLANNER_MODEL`, `READER_MODEL`, `VOICE_MODEL` | see [AI configuration](../guide/ai-configuration.md) | `provider:model` |
| `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | | Provider keys |
| `OPENROUTER_PROVIDER` | | JSON host routing for OpenRouter |
| `LOCAL_BASE_URL`, `LOCAL_API_KEY`, `LOCAL_VISION` | `http://localhost:11434/v1` | OpenAI-compatible local model |
| `AI_MAX_RETRIES` | 5 | Retries on 429 and 5xx |
| `AI_STRUCTURED_MODE` | auto | `native`, `tool` or `json` |
| `AI_REPLAY_FALLBACK` | `true` | Serve the labelled recording when the live model fails |
| `AGENT_TURN_TIMEOUT_MS`, `AGENT_STEP_TIMEOUT_MS`, `AGENT_CHUNK_TIMEOUT_MS` | 75 000 / 30 000 / 20 000 | Turn time budget |
| `RECORD` | | `1` records live runs to `fixtures/agent-recordings/` |

## Money and limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAYMENTS_DAILY_CAP_HOME_MINOR` | 200000000 | Daily cap in minor units of `PAYMENTS_DAILY_CAP_CURRENCY` (₸2,000,000), converted to each user's home currency and rounded down |
| `PAYMENTS_DAILY_CAP_CURRENCY` | `KZT` | Reference currency of the cap |
| `SMALL_AUTO_DAILY_MAX_COUNT` | 3 | Small payments without a mandate per UTC day; then ASK `SMALL_AUTO_BUDGET_EXHAUSTED` |
| `SMALL_AUTO_DAILY_AMOUNT_MULTIPLE` | 3 | Daily small-payment total = this × the signed small-payment limit |
| `KYC_THRESHOLD_MINOR`, `KYC_THRESHOLD_CURRENCY` | EUR 1,000 | Above this, an identity check is required |
| `FX_OFFLINE` | | `1` uses `fixtures/fx-rates.json` (no network) |

## Rails (all sandbox)

| Variable | Meaning |
| --- | --- |
| `ISSUING_PROVIDER` | `stripe` (test mode) or `fake` one-time cards |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ISSUING_CURRENCY` | Stripe test-mode keys only (`sk_test_`) |
| `WISE_SANDBOX_TOKEN`, `WISE_PROFILE_ID`, `WISE_API_URL` | Optional Wise sandbox payouts; live hosts are refused ([Sandbox payments](../guide/sandbox-payments.md)) |
| `MOCK_WORLD_URL`, `MOCK_PUBLIC_URL` | The mock world, internal and public |

## Demo, judge build and scheduler

| Variable | Meaning |
| --- | --- |
| `DEMO_ENABLED` | Registers the demo routes and loads demo data into an empty database |
| `DEMO_ADMIN_TOKEN` | Guards the admin demo routes (reset, clock, triggers) |
| `DEV_LOGIN` | Dev sign-in with a server-held test passkey; never in production |
| `JUDGE_MODE` | Judge build: per-sign-in persona copies, approvals by the copy's test passkey |
| `RATE_LIMIT_JUDGE_COPIES_PER_HOUR` | New persona copies per IP per hour on the judge build |
| `SCHEDULER_ENABLED` | The 15 s scheduler (mandated payments, purges, anchoring) |
| `ANCHOR_PRIVATE_KEY`, `ANCHOR_CHAIN`, `ANCHOR_RPC_URL`, `ANCHOR_EXPLORER_URL`, `ANCHOR_INTERVAL_MINUTES` | [On-chain anchoring](../guide/on-chain-anchoring.md) |

## Rate limits and retention

| Variable | Default |
| --- | --- |
| `RATE_LIMIT_GLOBAL_PER_MIN` | 600 per IP |
| `RATE_LIMIT_AUTH_PER_MIN` | 20 (auth, refresh, public verify) |
| `RATE_LIMIT_SENSITIVE_PER_MIN` | 30 (approvals, capture, privacy, unfreeze) |
| `RETENTION_DAYS_NOTIFICATIONS` | 90 (0 keeps) |
| `RETENTION_DAYS_PLACEHOLDER_MAPS` | 30 (agent conversations and placeholder maps) |
| `RETENTION_DAYS_DOCUMENTS` | 30 (uploaded invoices and screenshots) |
| `RETENTION_DAYS_CAPTURED_TEXT` | 90 (raw merchant text of captured purchases) |
