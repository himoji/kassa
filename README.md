# Kassa

**An AI agent that pays your bills across borders, inside the limits you signed.**

## FinTechathon 2026 submission (Topic C)

### 01 · [Technical documentation: architecture, algorithms, security design](docs/architecture/overview.md)

### 02 · [Presentation deck (PDF)](docs/submission/kassa-deck.pdf)

### 03 · [Demo video (3:28)](docs/demo/kassa-demo.mp4)

### 04 · [Source code: deploy guide](docs/guide/deploy.md) · [test cases](docs/reference/tests.md)

### 05 · [Security self-assessment: permission tiers and known risks](docs/security/self-assessment.md)

### 06 · [Execution evidence: sandbox logs and on-chain transaction hashes](docs/evidence/index.md)

### Try it: [judge build (no passkey device needed)](https://kassa-judge.vercel.app/) · [evidence room](https://kassa-sand.vercel.app/showcase)

---

Source: https://github.com/himoji/kassa · Topic C (Cross-border and Student Finance Assistant), FinTechathon 2026 International Track.

- **Problem.** International students earn in one country and pay bills in another: hidden card FX fees, irregular money from home, and "your landlord's bank details changed" scams.
- **What is new.** The agent pays on its own only inside mandates the user signed with a passkey (rent and insurance to verified payees, small purchases under a signed limit). Anything else becomes an exact order for the user to sign. Plain code, not the model, decides which. Bills paid on time become an Ed25519-signed credit record a landlord or bank can verify.
- **Why not Wise or Revolut plus a chatbot.** In 16 recreated attacks where the model obeys the attacker (A1 to A8, A10 to A17), Kassa refused 7, stopped 8 at a passkey prompt on the exact order, and paid 1 (a QR code swapped inside the user's wallet after Kassa's check, detected but not stoppable). If the user approves every prompt, the attacker is paid in 5 of 16 with Kassa (4 of them only after the user added the attacker as a payee and the 24-hour cooling passed) against 11 of 16 for a chatbot with a confirm-tap payment tool.
- **Check it in ten minutes.** [Five checks, step by step](docs/submission/walkthrough.md) · [judge build](https://kassa-judge.vercel.app/) (no passkey device needed) · [demo video](docs/demo/kassa-demo.mp4) ([Demo videos](docs/submission/demo-videos.md)) · [evidence room](https://kassa-sand.vercel.app/showcase) · [deck (PDF)](docs/submission/kassa-deck.pdf) · [security self-assessment](docs/security/self-assessment.md) · [docs](docs/README.md). If `vercel.app` is blocked, the videos and [evidence files](docs/evidence/) are in this repo.

> **Scope.** Sandbox and simulated mode only: no real money, bank or Wise API, no custody. All companies in the demo are fictitious.
>
> **Focus.** The submission is the student story: tuition, rent, money from home, scams and a credit record. The pizza and Shanghai shops, the supplier order (hidden by default) and the KassaLite iPhone wallet are side flows on the same rules and ledger, not needed to judge Topic C.

## Documentation

A [VitePress](https://vitepress.dev) site built from [`docs/`](docs/README.md); `bun run docs:dev` runs it locally.

| Section | Start with |
| --- | --- |
| Guide | [Introduction](docs/guide/introduction.md) · [Quickstart](docs/guide/quickstart.md) · [Run locally](docs/guide/run-locally.md) · [AI configuration](docs/guide/ai-configuration.md) · [Deploy](docs/guide/deploy.md) · [On-chain anchoring](docs/guide/on-chain-anchoring.md) |
| Examples (real requests and output) | [Call the API](docs/examples/api-basics.md) · [An agent turn](docs/examples/agent-turn.md) · [A prompt-injection attempt](docs/examples/prompt-injection.md) · [Statement import](docs/examples/statement-import.md) · [Credit record](docs/examples/credit-record.md) · [Verify the ledger](docs/examples/verify-ledger.md) |
| Architecture | [Overview and algorithms](docs/architecture/overview.md) · [Decision log](docs/architecture/decisions.md) |
| Security and compliance | [Self-assessment](docs/security/self-assessment.md) · [Privacy](docs/security/privacy.md) · [Compliance](docs/security/compliance.md) |
| Reference | [Commands](docs/reference/commands.md) · [Environment](docs/reference/environment.md) · [HTTP API](docs/reference/http-api.md) · [Tests](docs/reference/tests.md) · [Layout and licences](docs/reference/repository.md) |
| Evidence and submission | [Evidence](docs/evidence/index.md) · [Submission map](docs/submission/index.md) · [Demo videos](docs/submission/demo-videos.md) · [Pitch](docs/submission/pitch.md) |

## Quickstart

Needs Bun 1.4 and, for the app, Node.js 22.18 or later.

```bash
bun install
bun run env:setup                  # gitignored .env files with generated dev keys; prints no secrets
bun run db:migrate && bun run seed # file-backed PGlite in .data/, seeds Dana
bun run dev                        # API on http://localhost:4000, mock world on http://localhost:4001
cd apps/mobile && bun run web      # second terminal: the app on http://localhost:8081
```

For live AI, put `OPENROUTER_API_KEY` (or another provider's key) in the root `.env`; without one, chat uses recorded replays labelled **Replay** ([AI configuration](docs/guide/ai-configuration.md)). Vercel or Docker: [Deploy](docs/guide/deploy.md).

## Submission map

| Brief checklist item     | In this repository                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Technical documentation  | [Architecture and algorithms](docs/architecture/overview.md), [security design](docs/security/self-assessment.md) |
| Source code              | This repo; [deploy](docs/guide/deploy.md), [tests](docs/reference/tests.md) |
| Security self-assessment | [self-assessment.md](docs/security/self-assessment.md): tiers T0 to T3 (§2), known risks (§7) |
| Execution evidence       | Sandbox logs and reports in [docs/evidence/](docs/evidence/index.md): attack results, ledger verification, story run, persona simulations, live Reader accuracy on 30 labelled invoices (`invoice-eval.json`, run on `deepseek-v4.1-flash`, the earlier default; the current default `deepseek-v4.1-flash-1017` has not been re-evaluated), a live-agent run on the judge build (`live-agent.md`: 7 live turns, the planner's tool calls and proposals, the rules' decisions, 0 of 3 attacks paid an account the attack introduced; `bun run evidence:live`); signed ledger checkpoints anchored on Sepolia ([`anchors.json`](docs/evidence/anchors.json): [seq 20](https://sepolia.etherscan.io/tx/0x83b2b7b9adaec23116b02ee00663d5437d8e5220977a0a70716ef364a36fba13), [seq 40](https://sepolia.etherscan.io/tx/0xd889b2467b7d646b0c30d89c033da8193e3bb0d3ca378214a75610ab39848b2d); check them with `bun run ledger:anchor:verify --no-db`, see [On-chain anchoring](docs/guide/on-chain-anchoring.md)); the attack results as a page at `/evidence` in the web app (no sign-in) |
| Presentation deck        | [kassa-deck.pdf](docs/submission/kassa-deck.pdf) (15 slides, ~10 min; [online](https://claude.ai/artifact/Sdktm1BZ9157k6Lj1qa4Y7)); script and Q&A in [pitch.md](docs/submission/pitch.md) |
| Demo video               | [kassa-demo.mp4](docs/demo/kassa-demo.mp4) (3:28; also [EU](docs/demo/kassa-eu.mp4) and [China](docs/demo/kassa-cn.mp4) parts), [Demo videos](docs/submission/demo-videos.md), [script](docs/submission/demo-script.md) |

Evidence dates (late October and November 2026) are on the **demo clock**, a story starting 2026-10-27. The app runs on real time unless the Stage's **Demo time** switch is on ([decision log](docs/architecture/decisions.md), 2026-10-16).

## Tests and checks

```bash
bun run typecheck      # tsc in every workspace
bun run lint           # ESLint, including the I1 and I2 import fences around the agent and payments
bun run test           # Vitest (api, mock-world, shared) and Jest (mobile)
bun run ledger:verify  # recomputes the hash chain and checkpoint signatures; exits 1 on any mismatch
bun run ledger:anchor:verify --no-db   # checks the Sepolia anchors against docs/evidence/anchors.json
```

Latest run (2026-10-19): API 1,286 tests in 160 files, mock world 394, shared 61, mobile Jest 951 in 92 suites; 2,692 in all. What each suite asserts: [Test catalogue](docs/reference/tests.md). The attack suite (`bun run evidence:attacks`) gives, over 16 attacks with a model that obeys the attacker: **7 refused, 8 asked, 1 paid** ([details](docs/examples/prompt-injection.md)). `.github/workflows/ci.yml` defines the same checks for GitHub Actions. Actions is paused on this repository because of the account's Actions billing, so the two red runs from 2026-10-13 are billing stops, not test failures; until it is back on, the totals above are from a local `bun run test`.

## Licence

Kassa's code is MIT (`LICENSE`). `apps/mobile` is based on ReadyNative Pro under its own licence, published with the licensor's permission ([details](docs/reference/repository.md)).
