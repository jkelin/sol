# Sol website

The `web` workspace is the Sunblock-styled public website and documentation application for Sol. It documents the compiler, reactivity, forms, cached queries and mutations, server RPC and HTTP declarations, routing, async composition, and transitions. It is built with Sol, Solkit multipage static rendering, Vite, Tailwind CSS v4, and a build-time Markdown compiler.

The production site is published at [soljs.dev](https://soljs.dev) through GitHub Pages.

## Commands

```bash
bun run dev:web
bun run build:web
bun run start:web
bun run test:web
bun run --cwd web test:e2e
```

The root `bun run verify` includes the website's Markdown/compiler tests. Root `bun run test:e2e` builds and tests both the existing example application and this website.

`bun run dev:web` includes Sol devtools by default: use the circular `S` launcher or
`globalThis.__sol` to inspect the component ownership tree, loaders and requests with authored
query/mutation locations, routing, and form validation.
Production builds omit devtools and prerender the landing page plus every canonical documentation route into `dist`; pass `{ devtools: false }` to `sol()` to opt out during development. Set `BASE_URL` to a root-relative deployment base such as `/sol/` when building for a project site.

## Source structure

- `src/main.tsx` imports the application styles and exports both the root component and generated static paths.
- `src/App.tsx` owns the shared header, responsive navigation, route outlet, pending state, and footer.
- `src/landing.sol.tsx` contains the landing page and its three compiled interactive examples.
- `src/code-samples.ts` is the single source for landing-page example text and build-time Shiki tokens.
- `src/docs.sol.tsx` contains the desktop/mobile documentation shell, route handles, navigation, and adjacent-page links.
- `src/urls.ts` prefixes literal internal links with Vite's deployment base and emits trailing-slash directory URLs for prerendered pages.
- `src/components/ui/` contains Sol-native, shadcn-inspired leaf components. Each component owns its typed variant recipe and runtime validation; the layer intentionally does not use React, Radix, or `components.json`.
- `../docs/*.md` contains every documentation page and validated live Sol fence; `../docs/SKILL.md` is the installable SolJS agent skill and is excluded from the website registry.
- `src/markdown/compile.ts` validates frontmatter and examples, parses Remark/GFM nodes, tokenizes source with Shiki, and generates Sol JSX.
- `src/markdown/vite.ts` compiles Markdown modules, pre-highlights landing examples with Shiki, generates the ordered virtual documentation registry, and invalidates it during development.
- `src/styles.css` contains Tailwind v4 tokens, global Sunblock surfaces, documentation typography, and motion classes.
- `DESIGN_SYSTEM.md` is the visual and interaction source of truth.
- `designs/` preserves the six original standalone HTML direction studies.

## Markdown contract

Each page begins with exactly these frontmatter fields:

```yaml
---
title: Reactivity
description: A concise page description.
section: Core
order: 4
---
```

The filename supplies the lowercase kebab-case slug. Slugs and order values must be unique. Raw HTML, images, reference-style links, malformed metadata, and unsupported URLs fail the build.

Live examples use a `sol` fence with `live`, `preview`, and optional `title` metadata:

````markdown
```sol live preview=Counter title="Reactive counter"
import { $component } from "sol";

const Counter = $component(function Counter() {
  let count = 0;
  return <button onClick={() => count++}>{count}</button>;
});
```
````

The named preview component must exist. Live fences may import only `sol` and `valibot`, may not use relative imports, and may not call `mount()`. The displayed source and preview are generated from the same fence.
