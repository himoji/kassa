# Submission map

FinTechathon 2026, Topic C (Cross-border and Student Finance Assistant). Scoring: task completion 40%, security and compliance 30%, innovation and interaction 30%, up to 5 bonus points for on-chain work.

| # | Brief checklist item | Where |
| --- | --- | --- |
| 01 | **Technical documentation:** architecture, core algorithms, security design | [Architecture overview and algorithms](../architecture/overview.md); [Security self-assessment](../security/self-assessment.md); [Technical specification](../architecture/tech-spec.md); this site |
| 02 | **Presentation deck**, at most 10 minutes | [kassa-deck.pdf](https://github.com/himoji/kassa/blob/main/docs/submission/kassa-deck.pdf) (15 slides; [online version](https://claude.ai/artifact/Sdktm1BZ9157k6Lj1qa4Y7)); [pitch script](./pitch.md) |
| 03 | **Demo video**, optional, at most 5 minutes | [Demo videos](./demo-videos.md): `kassa-demo.mp4` (3:28), `kassa-eu.mp4` (1:20), `kassa-cn.mp4` (2:08); [demo script](./demo-script.md) |
| 04 | **Source code** with README, GitHub link, deployment instructions and test cases | https://github.com/himoji/kassa; [Quickstart](../guide/quickstart.md), [Deploy](../guide/deploy.md), [Test catalogue](../reference/tests.md) (2,692 tests) |
| 05 | **Security self-assessment:** permission tiers and known risks | [Self-assessment](../security/self-assessment.md): tiers T0 to T3 (§2), invariants I1 to I13, known risks (§7); [Privacy](../security/privacy.md), [Compliance](../security/compliance.md) |
| 06 | **Execution evidence:** sandbox logs and demo video (on-chain: transaction hashes) | [Evidence](../evidence/index.md): attack results, ledger verification, live agent run, persona simulations, Reader accuracy; Sepolia anchors with transaction hashes ([On-chain anchoring](../guide/on-chain-anchoring.md)) |

Short on time: [Check it in ten minutes](./walkthrough.md) walks through five checks on the judge build.

## Where each scoring criterion is easiest to see

| Criterion | Look at |
| --- | --- |
| Task completion | The [judge build](https://kassa-judge.vercel.app/), [An agent turn](../examples/agent-turn.md), [Statement import](../examples/statement-import.md), [Credit record](../examples/credit-record.md) |
| Security and compliance | [Self-assessment](../security/self-assessment.md), [A prompt-injection attempt](../examples/prompt-injection.md), [Verify the ledger](../examples/verify-ledger.md), [Compliance](../security/compliance.md) |
| Innovation and interaction | "AI proposes, code decides, passkey signs" with mandates for autopay ([Introduction](../guide/introduction.md)), the signed credit record, the [evidence room](https://kassa-sand.vercel.app/showcase) |
| On-chain bonus | Ledger checkpoints anchored on Sepolia ([On-chain anchoring](../guide/on-chain-anchoring.md)) |
