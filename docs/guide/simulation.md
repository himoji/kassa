# Simulation

Runs the real API and mock world through the app's HTTP routes, with the planner seeing only placeholders. It produced the persona and attacker reports in [Evidence](../evidence/index.md).

```bash
bun run sim up --fresh   # new sim database (.data/sim/pglite), seed, API :4000, mock world :4001, control :4099
bun run sim status
bun run sim story        # the scripted business story; writes the ledger used by docs/evidence/ledger-verify.json
bun run sim down         # stops everything it started and reports the ports
```

Don't run `bun run dev` at the same time (both use ports 4000 and 4001). The [runbook](../evidence/sim/RUNBOOK.md) lists every command, persona and security scenario with its test files.

## What the reports show

An LLM tester played both user and planner through the API while Kassa's own model calls were replayed, so these runs test the guards, not the live planner. For that, see the [live agent run](../evidence/live-agent.md).

| Report | Persona |
| --- | --- |
| [p1](../evidence/sim/p1/REPORT.md) | Average user |
| [p2](../evidence/sim/p2/REPORT.md) | Careful user |
| [p3](../evidence/sim/p3/REPORT.md) | Bad actor |
| [cn](../evidence/sim/cn/REPORT.md) | Chinese-context demos and a compromised planner |
| [security](../evidence/sim/security/REPORT.md) | Scenario review |

[SUMMARY.md](../evidence/sim/SUMMARY.md) has results and fix status of every finding.
