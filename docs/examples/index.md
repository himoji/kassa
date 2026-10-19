# Examples

Worked examples with real requests and real output. The local ones were captured on 2026-10-19 against a fresh stack (`bun run seed`, `AGENT_MODE=REPLAY`, `DEV_LOGIN=true`, `FX_OFFLINE=1`); the live ones come from the committed [live agent run](../evidence/live-agent.md) on the judge build. Ids, hashes and timestamps will differ on your machine.

| Example | Shows | Needs |
| --- | --- | --- |
| [Call the API](./api-basics.md) | Sign in as Dana, read balances, bills, caps and the ledger | Local stack |
| [An agent turn](./agent-turn.md) | One chat turn as a stream: tool calls, tool results, the rules' decision | Local stack (replay) or judge build (live) |
| [A prompt-injection attempt](./prompt-injection.md) | The "landlord changed bank account" scam against the live model, and the 16-attack suite | Nothing (committed evidence) |
| [Import a bank statement](./statement-import.md) | A Kaspi CSV in Kazakh read into money-from-home and spending history | Local stack |
| [Issue and verify a credit record](./credit-record.md) | Export a signed record, then check it offline | Local stack |
| [Verify the ledger and anchors](./verify-ledger.md) | Re-check the hash chain, checkpoints and Sepolia anchors | Nothing for `--no-db` |

All local examples start from the [Quickstart](../guide/quickstart.md) with one change: start the API with dev sign-in on, so `curl` can sign in without a passkey device.

```bash
DEV_LOGIN=true DEMO_ENABLED=true AGENT_MODE=REPLAY bun run dev
```
