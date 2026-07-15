---
title: Async Rendering and Context
description: Compose providers, async components, Await, Suspense, and error boundaries with explicit ownership.
section: Systems
order: 8
---

Create object context with `$context<T>()`. A provider receives its object through `data`; descendants call `use()` for a stable reactive proxy that follows provider replacement.

```sol live preview=ContextDemo title="A reactive context provider"
import { $component, $context } from "@soljs/sol";

const solarContext = $context<{ label: string; visits: number }>();

const ContextReader = $component(function ContextReader() {
  const context = solarContext.use();
  return <button class="border-[3px] border-ink bg-mint px-4 py-3 font-mono text-xs font-bold uppercase shadow-block-sm" onClick={() => context.visits++}>{context.label}: {context.visits}</button>;
});

const ContextDemo = $component(function ContextDemo() {
  const shared = { label: "Provider-backed", visits: 0 };
  return <solarContext.Provider data={shared}><ContextReader /></solarContext.Provider>;
});
```

`use()` throws without a matching provider; use `useOptional()` when absence is valid. Async components should read context before their first `await`.

## Suspense and Await

`Suspense` keeps its fallback visible until all async work owned by that boundary resolves. Nested boundaries account for their own work. `Await` renders a promise result through its function child.

Rejections are handled in this order:

1. The nearest `Await` error renderer.
2. The owning `Suspense` error renderer.
3. The nearest `ErrorBoundary`.

`ErrorBoundary` also catches synchronous descendant setup and render failures. It does not intercept errors thrown by event handlers.
