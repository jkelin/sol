# frontend-framework

An experimental JSX framework that compiles components into static HTML templates and fine-grained DOM operations. Component setup runs once per mounted instance; signals patch only the DOM that depends on them.

## Run the demo

```bash
bun install
bun run dev
```

The notebook-style to-do app demonstrates deep reactive proxies, computed state, child props, keyed lists, conditional regions, events, and two-way form bindings.

## Authoring model

```tsx
import { mount, signal } from "frontend-framework";

function Counter() {
  const count = signal(0);
  return <button onClick={() => count.value++}>{count.value}</button>;
}

mount(Counter, document.querySelector("#app")!);
```

Use `bind:value={reference}` for text-like fields and `bind:checked={object.done}` for checkbox/radio state. Object and array signal values are deep proxies, so nested assignments and mutating array methods are reactive.

Enable compilation in Vite:

```ts
import { defineConfig } from "vite";
import { frontendFramework } from "frontend-framework/vite";

export default defineConfig({ plugins: [frontendFramework()] });
```

## Verification

```bash
bun run typecheck
bun run test
bun run build
bun run test:e2e
```
