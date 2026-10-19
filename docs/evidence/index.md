# Evidence

Sandbox operation logs, verification reports and on-chain transaction hashes. Most files are written by the listed command and can be regenerated.

| File | What it is | Written by |
| --- | --- | --- |
| [`attacks.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/attacks.json) | 16 attacks (49 cases) against Kassa: outcome, decision, reason codes and ledger entries per case | `bun run evidence:attacks` |
| [`tap-confirm-baseline.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/tap-confirm-baseline.json) | Same intents against a chatbot whose payment tool needs one confirm tap | `bun run evidence:attacks` |
| [`naive-baseline.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/naive-baseline.json) | Same intents against an agent with no checks (upper bound) | `bun run evidence:attacks` |
| [Live agent run](./live-agent.md) (+ [`live-agent.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/live-agent.json)) | 7 turns on the judge build answered by the live model: tool calls, proposals, the rules' decisions, ledger entries, replies | `bun run evidence:live` |
| [`ledger-verify.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/ledger-verify.json) | Hash chain and checkpoint check of the simulated story run (57 entries, 2 checkpoints, ok) | `bun run ledger:verify` |
| [`anchors.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/anchors.json) | Two checkpoints anchored on Sepolia, with transaction hashes and explorer links | `bun run ledger:anchor` |
| [`story.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/story.json) | An earlier run of the same business story (55 entries) | `bun run sim story` |
| [`invoice-eval.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/invoice-eval.json) | Live Reader on 30 labelled invoices: exact-match rate per field, latency. Run on `deepseek-v4.1-flash`; current default not re-evaluated. Its six wrong-but-verified values (own name as payee, an invoice number or "no reference" as the reference) all fail the stricter checks added 2026-10-18 (`test/intel/reader-plausibility.test.ts`) | `bun run eval:invoices` |
| [`sim/`](./sim/SUMMARY.md) | Persona and attacker simulation reports; `sim/tuition-e2e.json` is the student tuition run (12 entries, verified) | `bun run sim` |

## How to check them

- Attack results: [A prompt-injection attempt](../examples/prompt-injection.md).
- Ledger and anchors: [Verify the ledger and anchors](../examples/verify-ledger.md).
- Live model: [An agent turn](../examples/agent-turn.md), or the [judge build](https://kassa-judge.vercel.app/).

## What is scripted and what is live

| Evidence | Model |
| --- | --- |
| Attack suite and baselines | Scripted planner and Reader that obey the attacker (deterministic, CI) |
| Persona simulations | An LLM tester plays the user; Kassa's own model calls are replayed |
| Live agent run | The live planner on the judge build |
| Invoice evaluation | The live Reader |
| Demo videos (2026-10-12) | Recorded replays, not a live model |

Sandbox and simulated rails only; no real money, fictitious companies. Dates are on the demo clock (story set on 2026-10-27).
