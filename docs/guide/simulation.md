# Simulation

The simulation runs the real API and mock world, drives them through the same HTTP routes the app uses, and gives the planner only placeholders. It is how the persona and attacker reports in [Evidence](../evidence/index.md) were produced.

```bash
bun run sim up --fresh   # new sim database (.data/sim/pglite), seed, API :4000, mock world :4001, control :4099
bun run sim status
bun run sim story        # the scripted business story; writes the ledger used by docs/evidence/ledger-verify.json
bun run sim down         # stops everything it started and reports the ports
```

Do not run `bun run dev` at the same time: both use ports 4000 and 4001.

The [runbook](../evidence/sim/RUNBOOK.md) lists every command, the personas (average user, careful user, bad actor) and the security scenarios with the test files that cover them.

## What the reports show

In the persona and attacker runs an LLM tester played both the user and the planner through the API, while Kassa's own model calls were replayed. These runs therefore test the product's guards, not its live planner. For the live planner, see the [live agent run](../evidence/live-agent.md).

| Report | Persona |
| --- | --- |
| [p1](../evidence/sim/p1/REPORT.md) | Average user |
| [p2](../evidence/sim/p2/REPORT.md) | Careful user |
| [p3](../evidence/sim/p3/REPORT.md) | Bad actor |
| [cn](../evidence/sim/cn/REPORT.md) | Chinese-context demos and a compromised planner |
| [security](../evidence/sim/security/REPORT.md) | Scenario review |

[SUMMARY.md](../evidence/sim/SUMMARY.md) has the results and the fix status of every finding.
