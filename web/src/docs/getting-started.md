---
title: Getting Started
description: Install Sol, connect the compiler, and mount a first reactive component.
section: Guide
order: 1
---

Sol is an experimental JSX framework whose compiler turns components into **static HTML templates** plus narrowly scoped DOM operations. Component setup runs once per mounted instance; reactive changes patch only the work that depends on them.

## Install the packages

Add the browser runtime, compiler, and Vite:

```sh
bun add sol
bun add --dev @sol/compiler vite
```

Enable the compiler before Vite transforms JSX:

```ts
import { sol } from "@sol/compiler/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [sol()] });
```

Set TypeScript's `jsxImportSource` to `sol`, then mount a compiled component into a real DOM element. Validate that mount boundary instead of assuming it exists.

## First light

This source is both the code-panel content and the component running beside it.

```sol live preview=FirstCounter title="Your first reactive component"
import { $component } from "sol";

const FirstCounter = $component(function FirstCounter() {
  let count = 0;
  const doubled = count * 2;

  return (
    <section class="border-[3px] border-ink bg-paper p-6 shadow-block-sm">
      <p class="font-mono text-xs font-bold uppercase text-cobalt">Reactive output</p>
      <output class="mt-4 block font-display text-6xl" aria-live="polite">{count}</output>
      <p class="mt-2 font-mono text-sm">Doubled: {doubled}</p>
      <button class="mt-6 border-[3px] border-ink bg-solar px-4 py-3 font-mono text-xs font-bold uppercase shadow-block-sm" onClick={() => count++}>Add one</button>
    </section>
  );
});
```

Writable declarations become signals and directly derived constants become computed values. Inside a compiled component, reads and assignments stay ordinary—there is no `.value` ceremony.

## Mount the application

```tsx
import { mount } from "sol";
import { App } from "./App.tsx";

const target = document.querySelector("#app");
if (!target) throw new Error("The #app mount target is missing");
mount(App, target);
```

Continue with the mental model before reaching for manual reactive primitives. Most application state belongs directly inside a compiled component.
