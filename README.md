# Kassa

**An AI agent that pays your bills across borders, inside the limits you signed.**

Source code: https://github.com/himoji/kassa

> - **Problem.** International students have money in one country and bills in another: card FX fees they never see, irregular money from home, and "your landlord's bank details changed" scams aimed at newcomers.
> - **What is new.** The agent pays on its own, but only inside mandates the user signed with a passkey (rent and insurance to verified payees, small purchases under a signed limit); anything else it prepares as an exact order for the user to sign. Plain code, not the model, decides which case applies. Bills paid on time become an Ed25519-signed credit record a landlord or bank can verify.
> - **Why not Wise or Revolut plus a chatbot.** Those apps move money when you tap. Kassa's agent plans and pays bills across currencies without a tap, yet it cannot exceed what you signed, and the repository shows it. In 16 recreated attacks where the model obeys the attacker (A1 to A8 and A10 to A17), Kassa refused 7 outright, stopped 8 at a passkey prompt on the exact order, and paid 1: a QR code swapped inside the user's wallet after Kassa's check, which Kassa detects but cannot stop. If the fooled user approves every prompt, the attacker's account is paid in 5 of 16 with Kassa (in 4 of them only after the user has also added the attacker as a payee and the 24-hour cooling has passed) and in 11 of 16 with a chatbot whose payment tool needs only a confirm tap. A9 has no baseline counterpart; see "Tests and checks".
> - **Check it in a few minutes.** [Judge build](https://kassa-judge.vercel.app/) (no passkey device needed) · [demo video](docs/demo/kassa-demo.mp4) (3:28, see [Demo videos](docs/submission/demo-videos.md)) · [evidence room](https://kassa-sand.vercel.app/showcase) · [deck (PDF)](docs/submission/kassa-deck.pdf) · [security self-assessment](docs/security/self-assessment.md) · [documentation](docs/README.md). If `vercel.app` does not open from your network, the videos and the evidence files ([docs/evidence/](docs/evidence/)) are in this repository.

Kassa is a finance agent for people whose money lives in one country and whose bills live in another, starting with international students. It was built for the 2026 Shenzhen International FinTech Competition (FinTechathon), International Track, **Topic C** (Cross-border and Student Finance Assistant), under the theme "AI as a Financial Participant".

> **Scope.** Everything runs in sandbox and simulated mode: no real money, no real bank or Wise API, no custody. All companies in the demo are fictitious.

## Documentation

The full documentation is a [VitePress](https://vitepress.dev) site built from [`docs/`](docs/README.md). Read it on GitHub, or run it locally with `bun run docs:dev`.

| Section | Start with |
| --- | --- |
| Guide | [Introduction](docs/guide/introduction.md) · [Quickstart](docs/guide/quickstart.md) · [Run locally](docs/guide/run-locally.md) · [AI configuration](docs/guide/ai-configuration.md) · [Deploy](docs/guide/deploy.md) · [On-chain anchoring](docs/guide/on-chain-anchoring.md) |
| Examples (real requests and output) | [Call the API](docs/examples/api-basics.md) · [An agent turn](docs/examples/agent-turn.md) · [A prompt-injection attempt](docs/examples/prompt-injection.md) · [Statement import](docs/examples/statement-import.md) · [Credit record](docs/examples/credit-record.md) · [Verify the ledger](docs/examples/verify-ledger.md) |
| Architecture | [Overview and algorithms](docs/architecture/overview.md) · [Technical specification](docs/architecture/tech-spec.md) · [Decision log](docs/architecture/decisions.md) |
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

For live AI, put `OPENROUTER_API_KEY` (or another provider's key) in the root `.env`. Without one, chat answers come from recorded replays labelled **Replay** ([AI configuration](docs/guide/ai-configuration.md)). Deployment to Vercel or Docker: [Deploy](docs/guide/deploy.md).

## Submission map

| Brief checklist item     | In this repository                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Technical documentation  | [docs/architecture/overview.md](docs/architecture/overview.md) (architecture, core algorithms), [docs/security/self-assessment.md](docs/security/self-assessment.md) (security design) |
| Source code              | https://github.com/himoji/kassa: README, deployment ([docs/guide/deploy.md](docs/guide/deploy.md)), tests ([docs/reference/tests.md](docs/reference/tests.md))                                  |
| Security self-assessment | [docs/security/self-assessment.md](docs/security/self-assessment.md): permission tiers T0 to T3 (§2), known risks (§7)                                               |
| Execution evidence       | Sandbox logs and reports in [docs/evidence/](docs/evidence/index.md): attack results, ledger verification, story run, persona simulations, live Reader accuracy on 30 labelled invoices (`invoice-eval.json`, run on `deepseek-v4.1-flash`, the earlier default; the current default `deepseek-v4.1-flash-1017` has not been re-evaluated), a live-agent run on the judge build (`live-agent.md`: 7 live turns, the planner's tool calls and proposals, the rules' decisions, 0 of 3 attacks paid an account the attack introduced; `bun run evidence:live`); signed ledger checkpoints anchored on Sepolia ([`anchors.json`](docs/evidence/anchors.json): [seq 20](https://sepolia.etherscan.io/tx/0x83b2b7b9adaec23116b02ee00663d5437d8e5220977a0a70716ef364a36fba13), [seq 40](https://sepolia.etherscan.io/tx/0xd889b2467b7d646b0c30d89c033da8193e3bb0d3ca378214a75610ab39848b2d); check them with `bun run ledger:anchor:verify --no-db`, see [On-chain anchoring](docs/guide/on-chain-anchoring.md)); the attack results as a page at `/evidence` in the web app (no sign-in) |
| Presentation deck        | [docs/submission/kassa-deck.pdf](docs/submission/kassa-deck.pdf) (15 slides, about 10 minutes; [online version](https://claude.ai/artifact/Sdktm1BZ9157k6Lj1qa4Y7)); spoken script, timings and expected questions in [docs/submission/pitch.md](docs/submission/pitch.md)                          |
| Demo video               | [docs/demo/kassa-demo.mp4](docs/demo/kassa-demo.mp4) (3:28; EU and China parts also as [kassa-eu.mp4](docs/demo/kassa-eu.mp4) and [kassa-cn.mp4](docs/demo/kassa-cn.mp4)), see [Demo videos](docs/submission/demo-videos.md); script in [docs/submission/demo-script.md](docs/submission/demo-script.md) |

Dates in the evidence (late October and November 2026) are on the **demo clock**: the seed data is a story set on 2026-10-27 and the demo moves its clock forward (rent day, payouts). The app itself runs on real time by default; the Stage's **Demo time** switch turns the story clock on ([decision log](docs/architecture/decisions.md), 2026-10-16).

## Tests and checks

```bash
bun run typecheck      # tsc in every workspace
bun run lint           # ESLint, including the I1 and I2 import fences around the agent and payments
bun run test           # Vitest (api, mock-world, shared) and Jest (mobile)
bun run ledger:verify  # recomputes the hash chain and checkpoint signatures; exits 1 on any mismatch
bun run ledger:anchor:verify --no-db   # checks the Sepolia anchors against docs/evidence/anchors.json
```

Latest run (2026-10-19): API 1,279 tests in 159 files, mock world 394, shared 61, mobile Jest 946 in 91 suites; 2,680 in all. What each suite asserts: [Test catalogue](docs/reference/tests.md). The attack suite (`bun run evidence:attacks`) gives, over 16 attacks with a model that obeys the attacker: **7 refused, 8 asked, 1 paid** ([details](docs/examples/prompt-injection.md)). `.github/workflows/ci.yml` defines the same checks for GitHub Actions. Actions is paused on this repository because of the account's Actions billing, so the two red runs from 2026-10-13 are billing stops, not test failures; until it is back on, the totals above are from a local `bun run test`.

## Licence

Kassa's own code is MIT (`LICENSE`). `apps/mobile` is based on ReadyNative Pro under its own licence, published here with the licensor's permission as part of this entry. Details: [Repository layout and licences](docs/reference/repository.md).
