# Solix website

The `web` workspace is the Sunblock-styled public website and documentation application for Solix. It is built with Solix, Vite, Tailwind CSS v4, and a build-time Markdown compiler.

## Commands

```bash
bun run dev:web
bun run build:web
bun run test:web
bun run --cwd web test:e2e
```

The root `bun run verify` includes the website's Markdown/compiler tests. Root `bun run test:e2e` builds and tests both the existing example application and this website.

## Source structure

- `src/App.tsx` owns the shared header, responsive navigation, route outlet, pending state, and footer.
- `src/landing.route.tsx` contains the landing page and its three compiled interactive examples.
- `src/code-samples.ts` is the single source for landing-page example text and build-time Shiki tokens.
- `src/docs.route.tsx` contains the desktop/mobile documentation shell, route handles, navigation, and adjacent-page links.
- `src/components/ui/` contains Solix-native, shadcn-inspired leaf components and variant recipes. They intentionally do not use React, Radix, or `components.json`.
- `src/docs/*.md` contains every documentation page and validated live Solix fences.
- `src/markdown/compile.ts` validates frontmatter and examples, parses Remark/GFM nodes, tokenizes source with Shiki, and generates Solix JSX.
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

Live examples use a `solix` fence with `live`, `preview`, and optional `title` metadata:

````markdown
```solix live preview=Counter title="Reactive counter"
import { $component } from "solix";

const Counter = $component(function Counter() {
  let count = 0;
  return <button onClick={() => count++}>{count}</button>;
});
```
````

The named preview component must exist. Live fences may import only `solix` and `valibot`, may not use relative imports, and may not call `mount()`. The displayed source and preview are generated from the same fence.
