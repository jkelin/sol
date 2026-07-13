# frontend-framework

An experimental JSX framework that compiles components into static HTML templates and fine-grained DOM operations. Component setup runs once per mounted instance; reactive changes patch only the DOM that depends on them.

## Run the demo

```bash
bun install
bun run dev
```

The Tailwind-powered notebook app demonstrates compiler-managed state, keyed lists, bindings, compile-time routes, path parameters, browser history, and shared blog entries.

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

## Routing

Routes are discovered automatically below the Vite project root. Define each route as an exported top-level constant in a `*.route.js`, `.jsx`, `.ts`, or `.tsx` file:

```tsx
import { $component, $route } from "frontend-framework";

const BlogDetail = $component(function BlogDetail() {
  return <article>Blog entry</article>;
});

export const blogDetailRoute = $route({ path: "/blog/:id" }, BlogDetail);
```

Paths are exact and case-sensitive. A segment beginning with `:` captures one required path parameter. Static routes take precedence over parameter routes, so `/blog/new` is matched before `/blog/:id`.

Each compiled route is a typed handle. Parameter names are inferred from its literal path, navigation fills and URL-encodes those parameters, and active-state getters remain reactive inside compiled components:

```tsx
const id = blogDetailRoute.params.id; // string
blogDetailRoute.navigate({ id: 42 });

blogDetailRoute.isActive; // exact route match
blogDetailRoute.isActivePrefix; // true anywhere below /blog
```

Reading `params` from an inactive route throws instead of returning stale values. `navigate()` validates missing, unknown, and non-string/number parameters at runtime as well as through TypeScript.

Place the route outlet in a compiled application shell and inspect the active location through the reactive `router` object:

```tsx
import { $component, Route, router } from "frontend-framework";

const App = $component(function App() {
  return (
    <main>
      <p>Current path: {router.pathname}</p>
      <p>Entry: {router.params.id}</p>
      <button onClick={() => router.navigate("/")}>Home</button>
      <Route />
    </main>
  );
});
```

The global `router` remains available for destinations that are not represented by a route handle. It exposes `pathname`, `search`, `hash`, `searchParams`, untyped matched `params`, the matched route config, and `navigate(path, { replace? })`. Same-origin root-relative anchors are handled through browser history while external, downloaded, targeted, and modified-click links retain their native behavior.

The demo uses Tailwind CSS v4 through `@tailwindcss/vite`; its CSS entry imports `tailwindcss` and defines the paper-ledger design tokens with `@theme`.

## Verification

```bash
bun run typecheck
bun run test
bun run build
bun run test:e2e
```
