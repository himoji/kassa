---
layout: home

hero:
  name: Kassa
  text: Cross-border bills, paid by an agent that cannot overspend
  tagline: The AI plans and pays rent, tuition and everyday spending across currencies. Plain code decides what it may pay on its own; anything else waits for your passkey.
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
    details: The planner has one money tool, propose_order. The rules engine answers AUTO, ASK, HANDOFF or REFUSE; payments verifies an Ed25519 signature before anything moves.
    link: /architecture/overview
    linkText: Architecture
  - title: Built for international students
    details: Money from home in KZT and USD, bills in HUF and EUR. Cheapest funding route per bill, hidden card FX fees exposed, tuition paid against the school's invoice.
    link: /guide/introduction
    linkText: What it does
  - title: Attacked on purpose
    details: 16 recreated attacks where the model obeys the attacker. Kassa refuses 7, stops 8 at a passkey prompt on the exact order and pays 1 (a QR swapped inside the wallet after the check).
    link: /examples/prompt-injection
    linkText: See an attempt
  - title: A ledger you can check
    details: Hash-chained, JCS-canonical entries with Ed25519 checkpoints every 20 entries, anchored on Sepolia. One command re-verifies everything.
    link: /examples/verify-ledger
    linkText: Verify it
  - title: A credit record that travels
    details: Bills paid on time become a signed summary a landlord or bank can verify offline against the issuer's public keys.
    link: /examples/credit-record
    linkText: Issue one
  - title: Everything in the repo
    details: Self-assessment with tiers T0 to T3 and invariants I1 to I13, GDPR and China compliance mapping, 2,692 tests, sandbox logs and a live-model run.
    link: /submission/
    linkText: Submission map
---

## Where to start

| You want to | Read |
| --- | --- |
| Understand the product in five minutes | [Introduction](./guide/introduction.md), then the [demo videos](./submission/demo-videos.md) |
| Run it on your machine | [Quickstart](./guide/quickstart.md) |
| See real requests and responses | [Examples](./examples/index.md) |
| Review the design | [Architecture overview](./architecture/overview.md) and the [security self-assessment](./security/self-assessment.md) |
| Check the claims | [Evidence](./evidence/index.md) and the [submission map](./submission/index.md) |

::: info Scope
Everything runs in sandbox and simulated mode. No real money moves, there is no real bank or Wise API and no custody. All companies in the demo are fictitious.
:::
