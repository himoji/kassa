# Kassa documentation

These Markdown files are also a documentation site built with [VitePress](https://vitepress.dev). From the repository root:

```bash
bun run docs:dev     # live preview on http://localhost:5173
bun run docs:build   # static site in docs/.vitepress/dist
```

The site's home page is [index.md](index.md). Main sections:

| Section | Folder | Start with |
| --- | --- | --- |
| Guide | [guide/](guide/) | [introduction.md](guide/introduction.md), [quickstart.md](guide/quickstart.md) |
| Examples | [examples/](examples/) | [index.md](examples/index.md) |
| Architecture | [architecture/](architecture/) | [overview.md](architecture/overview.md) |
| Security and compliance | [security/](security/) | [self-assessment.md](security/self-assessment.md) |
| Reference | [reference/](reference/) | [commands.md](reference/commands.md), [http-api.md](reference/http-api.md) |
| Evidence (logs and reports) | [evidence/](evidence/) | [index.md](evidence/index.md) |
| Submission | [submission/](submission/) | [index.md](submission/index.md) |

`evidence/` and `demo/` also hold the raw files that scripts write and tests read (`attacks.json`, `ledger-verify.json`, the MP4s); keep their paths stable.
