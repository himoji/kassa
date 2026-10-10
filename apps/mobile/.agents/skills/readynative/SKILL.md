---
name: readynative
description: ReadyNative app: read docs/ARCHITECTURE.md first, then work through the @/lib shims, the generated files setup owns, and `bun run gen:graph` after every structural change.
version: 1.0.0
---

# Working in a ReadyNative app

This repo was generated from the ReadyNative template. It is a plain Expo app - Expo Router,
TypeScript, `src/` - plus three things that are not obvious from the file tree: a generated
graph of itself, a set of shims every screen imports through, and a handful of files that a
generator owns and you must not hand-edit.

## 1. Read the graph before you read the code

`docs/ARCHITECTURE.md` is the map: a mermaid flowchart plus one table per kind of node
(module, service, provider, route, screen, feature, hook, store, lib, env, script, custom).
`docs/graph.json` is the same thing machine-readable - grep it instead of walking the tree:

```bash
# which lib does this route pull in?
node -e 'const g=require("./docs/graph.json");console.log(g.edges.filter(e=>e.from==="route:/"))'
```

Node ids are `kind:name` (`route:/entry/[id]`, `lib:api/client`, `env:EXPO_PUBLIC_API_URL`,
`module:auth/supabase`). Edge kinds: `imports`, `provides` (module → provider), `reads`
(→ an env key), `renders` (route → screen, provider → nested provider), `configures`
(module → service or app plugin), `custom`.

Nothing in it is hand-written, so it cannot lie for long - but it can go stale. Regenerate it
after adding or removing a route, a screen, a `@/lib` shim, a provider, a store, a hook or an
env key:

```bash
bun run gen:graph          # rewrites docs/graph.json + docs/ARCHITECTURE.md
bun run gen:graph --check  # exits 1 when they are stale (CI and the pre-commit hook)
```

## 2. Add your own nodes

The generator only knows about files. When you add something it cannot see - a background
job, a webhook, an external service - say so where you wrote it:

```ts
// @graph node=job:digest kind=feature label="Nightly digest" edges=lib:api/client,env:EXPO_PUBLIC_API_URL
```

One annotation per line, in any `src/**` file; `label` is quoted, `edges` is a comma-separated
list of node ids the new node points at. For anything with no natural home in `src/`, add it to
`docs/graph.extra.json`, which is merged verbatim:

```json
{
  "nodes": [{ "id": "service:stripe", "kind": "service", "label": "Stripe" }],
  "edges": [{ "from": "service:stripe", "to": "env:EXPO_PUBLIC_API_URL", "kind": "reads" }]
}
```

Edges pointing at a node that does not exist are reported as warnings, not errors.

## 3. The shim contract

Every capability the app has is reached through `@/lib/<category>` - `@/lib/auth`,
`@/lib/payments`, `@/lib/analytics`, `@/lib/push`, `@/lib/crash`, `@/lib/storage`. The shim
exists whether or not a provider was selected: when the category is `none`, the shim is a
no-op with the same signature. That is the rule that keeps screens portable, so:

- import `@/lib/auth`, never `@supabase/supabase-js` or another vendor SDK, from a screen;
- to swap a provider, rewrite the shim - not its call sites;
- UI comes from `@/ui` (`Screen`, `Box`, `Text`, `Button`, `Row`, `List`, …);
  prefer it over raw `react-native` views.

Screen bodies live in `src/screens`; `src/app` is routing only (every file there is a route,
`_layout.tsx` files are navigators). Keep non-route code out of `src/app`.

## 4. Generated files - do not hand-edit

| File | Owner |
| --- | --- |
| `src/providers.tsx` | `setup` (module `providers[]`, sorted by order) |
| `src/lib/env.ts`, `.env.example` | `setup` (module `env[]`) |
| `.readynative.json` | `setup` - the record of what was applied |
| `src/theme/*` generated stylesheet | `bun run gen:theme` |
| `public/.well-known/*` | `bun run gen:links` |
| `docs/graph.json`, `docs/ARCHITECTURE.md` | `bun run gen:graph` |

To add an env key, add it to `src/lib/env.ts` **and** `.env.example`, then re-run
`bun run gen:graph`; `bun run doctor` is what tells a human the key is missing.

## 5. Commands

```bash
bun run setup        # one-way, already ran: it picked the stack and removed itself
bun run doctor       # env keys, config placeholders, EAS login, SDK versions
bun run gen:graph    # the graph (this skill)
bun run gen:theme    # design tokens → the theme stylesheet
bun run gen:links    # links config → public/.well-known/*
bun run gen:assets   # assets/brand/icon.png → icons and splash
bun run typecheck && bun run lint && bun run test
```

Use whichever package manager's lockfile is in the repo (`bun.lock` → bun, `package-lock.json`
→ npm, …); the scripts themselves run under plain node, so all of them work.

Install packages with `npx expo install <package>`, never a bare `npm install` - it resolves
the version that matches this SDK. A library with native code needs a development build
(`npx expo run:ios`), not Expo Go.
