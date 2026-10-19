# Evidence

`docs/evidence/` holds the execution evidence the brief asks for: sandbox operation logs, verification reports and on-chain transaction hashes. Most files are written by a command, so anyone can regenerate them.

| File | What it is | Written by |
| --- | --- | --- |
| [`attacks.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/attacks.json) | 16 attacks (49 cases) against Kassa: outcome, decision, reason codes and ledger entries per case | `bun run evidence:attacks` |
| [`tap-confirm-baseline.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/tap-confirm-baseline.json) | The same attacker intents against a chatbot whose payment tool needs one confirm tap | `bun run evidence:attacks` |
| [`naive-baseline.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/naive-baseline.json) | The same intents against an agent with no checks (upper bound) | `bun run evidence:attacks` |
| [Live agent run](./live-agent.md) (+ [`live-agent.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/live-agent.json)) | 7 turns on the judge build answered by the live model: tool calls, proposals, the rules' decisions, ledger entries, replies | `bun run evidence:live` |
| [`ledger-verify.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/ledger-verify.json) | Hash chain and checkpoint verification of the simulated story run (57 entries, 2 checkpoints, ok) | `bun run ledger:verify` |
| [`anchors.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/anchors.json) | The two checkpoints anchored on Sepolia, with transaction hashes and explorer links | `bun run ledger:anchor` |
| [`story.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/story.json) | An earlier run of the same business story (55 entries) | `bun run sim story` |
| [`invoice-eval.json`](https://github.com/himoji/kassa/blob/main/docs/evidence/invoice-eval.json) | The live Reader on 30 labelled invoices: exact-match rate per field, latency. Produced on `deepseek-v4.1-flash` on 2026-10-17; the current default has not been re-evaluated. Its six wrong-but-verified values (the student's own name as payee, an invoice number or a "no reference" note as the reference) all fail the stricter checks added on 2026-10-18 (`test/intel/reader-plausibility.test.ts`) | `bun run eval:invoices` |
| [`sim/`](./sim/SUMMARY.md) | Persona and attacker simulation reports and their findings; `sim/tuition-e2e.json` is the student tuition run (12 entries, verified) | `bun run sim` |

## How to check them

- Recount the attack results: [A prompt-injection attempt](../examples/prompt-injection.md).
- Re-verify the ledger and the anchors: [Verify the ledger and anchors](../examples/verify-ledger.md).
- See the live model at work: [An agent turn](../examples/agent-turn.md), or ask the [judge build](https://kassa-judge.vercel.app/) yourself.

## What is scripted and what is live

| Evidence | Model |
| --- | --- |
| Attack suite and baselines | Scripted planner and Reader that obey the attacker (deterministic, runs in CI) |
| Persona simulations | An LLM tester plays the user; Kassa's own model calls are replayed |
| Live agent run | The live planner on the judge build |
| Invoice evaluation | The live Reader |
| Demo videos (2026-10-12) | Recorded replays, not a live model |

Everything runs on sandbox and simulated rails; no real money moves and all companies are fictitious. Dates are on the demo clock (the story is set on 2026-10-27).
