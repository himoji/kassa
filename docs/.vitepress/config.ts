import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// Kassa documentation site. `bun run docs:dev` from the repo root; pages are the Markdown files in docs/.
// DOCS_BASE serves the site under a sub-path (for example /docs/ on the Vercel deployment).
const repo = "https://github.com/himoji/kassa";

export default withMermaid(
  defineConfig({
  title: "Kassa",
  description: "An AI agent that pays your bills across borders, inside the limits you signed.",
  lang: "en-GB",
  base: process.env.DOCS_BASE ?? "/",
  cleanUrls: true,
  srcExclude: ["README.md", "node_modules/**"],
  lastUpdated: false,
  // Evidence reports quote local URLs (localhost:4000 and so on) that only exist on a running stack.
  ignoreDeadLinks: [/^https?:\/\/localhost/, /^https?:\/\/127\.0\.0\.1/],
  // Raw HTML in Markdown is shown as text: the docs quote tags and placeholders like <seq> in prose.
  markdown: { html: false },
  head: [["meta", { name: "theme-color", content: "#0f766e" }]],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/introduction" },
      { text: "Examples", link: "/examples/" },
      { text: "Architecture", link: "/architecture/overview" },
      { text: "Security", link: "/security/self-assessment" },
      { text: "Reference", link: "/reference/commands" },
      { text: "Evidence", link: "/evidence/" },
      {
        text: "Live",
        items: [
          { text: "Judge build", link: "https://kassa-judge.vercel.app/" },
          { text: "Public demo", link: "https://kassa-sand.vercel.app/" },
          { text: "Evidence room", link: "https://kassa-sand.vercel.app/showcase" },
        ],
      },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Check it in ten minutes", link: "/submission/walkthrough" },
          { text: "Introduction", link: "/guide/introduction" },
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Run locally", link: "/guide/run-locally" },
          { text: "AI configuration", link: "/guide/ai-configuration" },
          { text: "Simulation", link: "/guide/simulation" },
          { text: "Deploy", link: "/guide/deploy" },
          { text: "On-chain anchoring", link: "/guide/on-chain-anchoring" },
          { text: "Sandbox payments", link: "/guide/sandbox-payments" },
        ],
      },
      {
        text: "Beyond Topic C",
        collapsed: true,
        items: [
          { text: "KassaLite (iPhone)", link: "/guide/kassalite" },
          { text: "iPhone Shortcuts", link: "/guide/shortcuts" },
          { text: "Over-the-air updates", link: "/guide/ota-updates" },
        ],
      },
      {
        text: "Examples",
        items: [
          { text: "Overview", link: "/examples/" },
          { text: "Call the API", link: "/examples/api-basics" },
          { text: "An agent turn", link: "/examples/agent-turn" },
          { text: "A prompt-injection attempt", link: "/examples/prompt-injection" },
          { text: "Import a bank statement", link: "/examples/statement-import" },
          { text: "Issue and verify a credit record", link: "/examples/credit-record" },
          { text: "Verify the ledger and anchors", link: "/examples/verify-ledger" },
        ],
      },
      {
        text: "Architecture",
        items: [
          { text: "Overview and algorithms", link: "/architecture/overview" },
          { text: "Technical specification", link: "/architecture/tech-spec" },
          { text: "Statement import design", link: "/architecture/statement-import" },
          { text: "Decision log", link: "/architecture/decisions" },
        ],
      },
      {
        text: "Security and compliance",
        items: [
          { text: "Security self-assessment", link: "/security/self-assessment" },
          { text: "Privacy (GDPR)", link: "/security/privacy" },
          { text: "Compliance mapping", link: "/security/compliance" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Commands", link: "/reference/commands" },
          { text: "Environment variables", link: "/reference/environment" },
          { text: "HTTP API", link: "/reference/http-api" },
          { text: "Test catalogue", link: "/reference/tests" },
          { text: "Repository layout and licences", link: "/reference/repository" },
        ],
      },
      {
        text: "Evidence",
        collapsed: true,
        items: [
          { text: "What is in docs/evidence", link: "/evidence/" },
          { text: "Live agent run", link: "/evidence/live-agent" },
          { text: "Simulation summary", link: "/evidence/sim/SUMMARY" },
          { text: "Simulation runbook", link: "/evidence/sim/RUNBOOK" },
          { text: "P1: average user", link: "/evidence/sim/p1/REPORT" },
          { text: "P2: careful user", link: "/evidence/sim/p2/REPORT" },
          { text: "P3: bad actor", link: "/evidence/sim/p3/REPORT" },
          { text: "China scenarios", link: "/evidence/sim/cn/REPORT" },
          { text: "Security scenarios", link: "/evidence/sim/security/REPORT" },
        ],
      },
      {
        text: "Submission",
        collapsed: true,
        items: [
          { text: "Check it in ten minutes", link: "/submission/walkthrough" },
          { text: "Checklist map", link: "/submission/" },
          { text: "Demo videos", link: "/submission/demo-videos" },
          { text: "Pitch script", link: "/submission/pitch" },
          { text: "Demo script", link: "/submission/demo-script" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    footer: {
      message: "Sandbox and simulated mode only: no real money moves. MIT licence.",
      copyright: "Kassa team, FinTechathon 2026 (Topic C)",
    },
  },
  })
);
