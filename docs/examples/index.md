# Examples

Real requests and output. Local ones captured on 2026-10-19 on a fresh stack (`bun run seed`, `AGENT_MODE=REPLAY`, `DEV_LOGIN=true`, `FX_OFFLINE=1`); live ones from the committed [live agent run](../evidence/live-agent.md) on the judge build. Ids, hashes and timestamps will differ.

| Example | Shows | Needs |
| --- | --- | --- |
| [Call the API](./api-basics.md) | Sign in as Dana; balances, bills, caps, ledger | Local stack |
| [An agent turn](./agent-turn.md) | One streamed turn: tool calls, results, the rules' decision | Local stack (replay) or judge build (live) |
| [A prompt-injection attempt](./prompt-injection.md) | "Landlord changed bank account" scam vs the live model; the 16-attack suite | Nothing (committed evidence) |
| [Import a bank statement](./statement-import.md) | Kazakh Kaspi CSV into money-from-home and spending history | Local stack |
| [Issue and verify a credit record](./credit-record.md) | Export a signed record, check it offline | Local stack |
| [Verify the ledger and anchors](./verify-ledger.md) | Hash chain, checkpoints, Sepolia anchors | Nothing for `--no-db` |

Local examples start from the [Quickstart](../guide/quickstart.md), with dev sign-in on so `curl` needs no passkey device:

```bash
DEV_LOGIN=true DEMO_ENABLED=true AGENT_MODE=REPLAY bun run dev
```
