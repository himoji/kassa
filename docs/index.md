---
layout: home

hero:
  name: Kassa
  text: Cross-border bills, paid by an agent that cannot overspend
  tagline: The AI plans and pays rent, tuition and daily spending across currencies. Code decides what it may pay alone; the rest waits for your passkey.
  actions:
    - theme: brand
      text: Check it in ten minutes
      link: /submission/walkthrough
    - theme: alt
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: Try the judge build
      link: https://kassa-judge.vercel.app/
    - theme: alt
      text: Examples
      link: /examples/

features:
  - title: AI proposes, code decides, passkey signs
    details: One money tool, propose_order. Rules answer AUTO, ASK, HANDOFF or REFUSE; payments verifies an Ed25519 signature before anything moves.
    link: /architecture/overview
    linkText: Architecture
  - title: Built for international students
    details: Money from home in KZT and USD, bills in HUF and EUR. Cheapest route per bill, hidden card FX fees exposed.
    link: /guide/introduction
    linkText: What it does
  - title: Attacked on purpose
    details: 16 recreated attacks, model obeying the attacker. Kassa refuses 7, stops 8 at a passkey prompt, pays 1 (a QR swapped inside the wallet after the check).
    link: /examples/prompt-injection
    linkText: See an attempt
  - title: A ledger you can check
    details: Hash-chained JCS entries, Ed25519 checkpoints every 20 entries, anchored on Sepolia. One command re-verifies it.
    link: /examples/verify-ledger
    linkText: Verify it
  - title: A credit record that travels
    details: Bills paid on time become a signed summary a landlord can verify offline.
    link: /examples/credit-record
    linkText: Issue one
  - title: Everything in the repo
    details: Tiers T0 to T3, invariants I1 to I13, GDPR and China compliance, 2,692 tests, sandbox logs and a live-model run.
    link: /submission/
    linkText: Submission map
---

## Where to start

| You want to | Read |
| --- | --- |
| Understand the product | [Introduction](./guide/introduction.md), then the [demo videos](./submission/demo-videos.md) |
| Run it on your machine | [Quickstart](./guide/quickstart.md) |
| See real requests | [Examples](./examples/index.md) |
| Review the design | [Architecture overview](./architecture/overview.md) and the [security self-assessment](./security/self-assessment.md) |
| Check the claims | [Evidence](./evidence/index.md) and the [submission map](./submission/index.md) |

::: info Scope
Sandbox and simulated only: no real money, no real bank or Wise API, no custody, fictitious companies.
:::
