# Agent briefing — read this first

You are working on **Kassa**, the team's entry for the 2026 Shenzhen International FinTech Competition (FinTechathon, WeBank FinTech College Students Challenge), International Track, **Topic C: Cross-border & Student Finance Assistant**. Theme: "AI as a Financial Participant". Judges are WeBank industry experts and university scholars (Chinese context). Scoring: task completion 40%, security & compliance 30%, innovation & interaction 30%. Submission deadline 2026-10-20 (feature freeze 2026-10-17).

## Product in one paragraph
A student finance assistant that can also pay. Hero: Dana, a Kazakh master's student in Budapest (home currency KZT; money arrives in KZT and USD; bills in HUF and EUR). Every purchase is logged and budgeted, foreign charges are reconciled to expose hidden card fees, and the agent plans and pays bills by the cheapest route. **The AI only drafts (`propose_order`); deterministic rules decide; money moves only with a passkey signature over the exact canonical order, or inside a passkey-signed mandate.** Pitch line: "The agent can prepare anything, but only your signature can move your money." A Shanghai region switch shows handoff mode (agent prepares, user pays in a simulated QR wallet).

## Repo map (bun workspaces + Turborepo, TypeScript strict)
- `apps/api` — Fastify 5 + Drizzle; PGlite file DB by default (`.data/kassa`), Postgres optional. Modules in `src/modules/`: rules, payments, rails, ledger, payees, mandates, screening, auth, privacy, agent, reader, ai (provider-agnostic Vercel AI SDK registry), fx, capture, budget, onboarding, demo, scheduler, obligations. Security plumbing in `src/http/`. Tests in `test/` (core, attacks, security, intel, sim). Scripts in `scripts/` incl. `sim/` (simulation CLI).
- `apps/mock-world` — Fastify mocks under `/mock`: Wise-shaped bank, shops/suppliers, invoices (PDF), inbox, QR wallet, POS, remittance. HMAC-signed webhooks.
- `apps/mobile` — Expo SDK 57 app from the ReadyNative Pro boilerplate; native-first (NativeTabs, @expo/ui, passkeys), i18next (en only). **Do not build or run it for tests.**
- `packages/shared` — zod contracts: CanonicalOrder + JCS hash, DTOs, reason codes, money utils (integer minor units, ISO 4217).
- `fixtures/` — seed data (`seed-data.ts`, SEED_NOW 2026-10-27T09:00Z), rails/fx rates, merchants, notifications, sanctions sample, invoices, agent recordings (replay).
- `docs/` — `spec/TECH_SPEC.md` (source of truth for how), `spec/Kassa — Build Plan.md` (what/why), `spec/PHASE2_PLAN.md` (current plan, known bugs, progress log, user requirements), `spec/PHASE1_COORDINATION.md` (contracts + contract changes), `DECISIONS.md` (every deviation, dated), `SECURITY.md`, `PRIVACY.md`, `COMPLIANCE.md`, `ARCHITECTURE.md`, `evidence/` (sim runbook + outputs).

## Non-negotiable rules
- Security invariants I1–I13 (TECH_SPEC §2) — each has tests; never weaken a test.
- Money = integer minor units + ISO 4217 code; time = `clock.now()` (demo clock), never `Date.now()` in api modules.
- Where the spec is silent, follow ISO/IEEE/RFC/W3C and cite in a comment; log deviations in `docs/DECISIONS.md`.
- No Docker (native bun). No real AI API calls in tests or sim (AGENT_MODE=REPLAY, mock model). Never read or edit `.env*` files directly — `bun run env:setup` manages them (add keys in `scripts/env-setup.ts`).
- Mock companies use plain descriptive generic names ("Pizza Supplier from EU", "Buy Everything Shop from China"); everything mocked is labelled "simulated"; no real brand logos.
- Don't git commit (the coordinator does). Stay inside the paths your brief names; other agents work in parallel.
- Cost: offload fully specified chunks (tests, fixtures, locale strings, mechanical edits) to Haiku via the Agent tool (`subagent_type: "general-purpose", model: "haiku", effort: "medium"`) with exact paths/signatures/assertions, then review.
- Finish with root `bun run typecheck && bun run lint && bun run test` green. If you start servers (`bun run sim up`), stop them (`bun run sim down`) and confirm `lsof -i :4000 -i :4001 -i :4099` is empty.

## Useful commands
`bun run env:setup` · `bun run db:migrate` · `bun run seed` · `bun run dev` (api :4000 + mock-world :4001) · `bun run sim <cmd>` (see `docs/evidence/sim/RUNBOOK.md`) · `bun run ledger:verify` · `bun run --cwd apps/api vitest run <file>`.

## Don't leave hung processes
A shell left waiting on stdin (e.g. `cat > file` without a heredoc) hung for ~5 h on 2026-10-11. Never run commands that read stdin interactively; give long commands a timeout; never `run_in_background` something you don't stop. Before reporting, check `ps -Ao pid,etime,command | grep -E "bun|node|vitest|cat"` for anything you started.
