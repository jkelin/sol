---
title: Mental Model and Compilation
description: Follow authored JSX through static templates, dependency discovery, and exact DOM patches.
section: Core
order: 2
---

Sol separates **setup** from **updates**. The component function is setup: it declares state, derived values, helpers, and a JSX template. The compiler converts that template into browser instructions before the application runs.

## The three-block assembly

1. **Authoring:** write declarations, expressions, event handlers, and JSX.
2. **Compilation:** identify writable state, infer direct derived dependencies, and produce a static template.
3. **Runtime:** clone the template once and schedule only effects that read changed signals.

```tsx
const Counter = $component(function Counter() {
  let count = 0; // signal
  const doubled = count * 2; // computed

  return <button onClick={() => count++}>{doubled}</button>;
});
```

The runtime does not repeatedly call `Counter`. It keeps the mounted DOM and updates the text operation that reads `doubled`.

## Dependency inference

Derived inference follows direct reads in the initializer. If an initializer only calls a helper that closes over reactive state, make the dependency explicit:

```tsx
const summary = $computed(() => formatSummary());
```

Interprocedural dependency analysis is intentionally outside the first version. The explicit override makes uncommon indirection visible instead of guessing.

## Ownership and disposal

Conditional branches, keyed rows, async work, and route pages own their reactive effects. Removing a block disposes the effects created for that block. Leave transitions can delay DOM removal without letting the retiring component continue to update.

> Think in mounted blocks, not rerendered component trees. Setup creates the block; dependencies keep its precise operations current.
