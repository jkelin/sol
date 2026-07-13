# frontend-framework

An experimental JSX framework that compiles components into static HTML templates and fine-grained DOM operations. Component setup runs once per mounted instance; reactive changes patch only the DOM that depends on them.

## Run the demo

```bash
bun install
bun run dev
```

The notebook-style to-do app demonstrates compiler-managed component state, derived values, deep proxies, child props, keyed lists, conditionals, editable rows, class composition, and two-way bindings.

`bun run build` (or `bun run build:demo`) creates an unminified production demo in `dist/`. Use `bun run build:demo:inspect` to create the same readable output in `out/demo-inspect/` without replacing the normal build.

## Authoring model

```tsx
import { $component, mount } from "frontend-framework";

const Counter = $component(function Counter() {
  let count = 0;
  const doubled = count * 2;

  return (
    <button classNames={["counter", { "counter--active": count > 0 }]} onClick={() => count++}>
      {count} / {doubled}
    </button>
  );
});

mount(Counter, document.querySelector("#app")!);
```

Direct component-body data variables are reactive automatically. Writable declarations become signals, derived `const` declarations become computed values, and component code uses normal reads and assignments without `.value`.

Derived inference follows direct reads in the initializer. When a helper function closes over reactive state and the initializer only calls that helper, use an explicit `$computed(() => helper())` override; interprocedural dependency analysis is intentionally outside v1.

Use `$bind={state}` on inputs, textareas, and selects. The compiler binds `checked` for static checkbox/radio inputs and `value` for other supported controls. Signal arrays and plain-object values are deep proxies, so nested assignments and mutating array methods are reactive. Dates, collections, and class instances retain their original identity.

`class`, `className`, and `classNames` are equivalent on DOM elements. Dynamic values accept strings, numbers, nested arrays, and object maps. For manual state outside compiled components, use `$signal()` and `$computed()` with their `.value` APIs.

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
