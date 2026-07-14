# Solix

An experimental JSX framework that compiles components into static HTML templates and fine-grained DOM operations. Component setup runs once per mounted instance; reactive changes patch only the DOM that depends on them.

## Install

```bash
bun add solix
bun add solkit
bun add --dev @solix/compiler vite
```

Configure the compiler through the Vite plugin shown below, then set TypeScript's `jsxImportSource` to `solix`.

## Run the example

```bash
bun install
bun run dev
```

The Tailwind-powered notebook example demonstrates compiler-managed state, keyed lists, bindings, cached queries, mutations, compile-time routes, path parameters, browser history, and shared blog entries.

`bun run build` (or `bun run build:example`) creates an unminified full-stack production example in
`example/dist/`: browser assets live in `client/`, and the bundled SSR handler plus Bun launcher live
in `server/`. Use `bun run build:example:inspect` for a client-only readable build in
`example/out/inspect/`.

## Run the website

```bash
bun run dev:web
bun run build:web
bun run test:web
```

`web/` is the Sunblock-styled landing page and documentation workspace. Its docs are authored in Markdown, while validated `solix live` fences compile into interactive Code/Preview/Both examples during the Vite build. See `web/README.md` for the authoring contract and `web/DESIGN_SYSTEM.md` for the visual system.

The original six standalone Tailwind Play CDN studies remain in `web/designs/` for comparison. They cover the solar-manifesto, Helios-lab, eclipse-console, sunblock-kit, cyanotype-solar, and atomic-sun directions.

## Authoring model

```tsx
import { $component, mount } from "solix";

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

## Refs and portals

Intrinsic elements accept callback refs and mutable object refs. `createRef<T>()` returns a typed, non-reactive `{ current: T | null }` object; refs attach after DOM insertion and clear during disposal.

```tsx
import { $component, createRef, GlobalPortal, Portal } from "solix";

const Overlay = $component(function Overlay() {
  const target = createRef<HTMLDivElement>();
  let open = false;
  return (
    <main>
      <button onClick={() => (open = true)}>Open</button>
      <div ref={target} />
      {open && (
        <Portal target={target.current!}>
          <p>Targeted content</p>
        </Portal>
      )}
      {open && (
        <GlobalPortal>
          <button onClick={() => (open = false)}>Close overlay</button>
        </GlobalPortal>
      )}
    </main>
  );
});
```

`Portal` accepts a reactive DOM `Element` target and moves the same owned block when that target changes. `GlobalPortal` mounts its JSX, text, or primitive children directly under `document.body` without a wrapper. Portal children preserve component context, async/error ownership, events, refs, cleanup, and transitions.
SSR omits portal children because their targets are browser-owned. During hydration, refs attach to claimed elements first and portal children then mount as fresh browser DOM without replacing the claimed server tree.

## Form validation

`$form()` owns a form's values, validation errors, and submission state. It accepts a callable parser or a schema with `parse()` or `parseAsync()`, so Valibot and Zod can share the same controller API.

```tsx
import { $component, $form } from "solix";
import * as v from "valibot";

const TodoSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1, "Enter a title.")),
});

const TodoForm = $component(function TodoForm() {
  function save(values: v.InferOutput<typeof TodoSchema>) {
    console.log(values);
    form.reset();
  }

  const form = $form(
    {
      schema: v.parser(TodoSchema),
      defaultValues: { title: "" },
      validationStrategy: "onSubmit",
    },
    save,
  );

  return (
    <form $form={form}>
      <input name="title" $bind={form.values.title} aria-invalid={Boolean(form.errors.title)} />
      {form.errors.title?.[0]}
      <button disabled={form.isSubmitting}>Save</button>
    </form>
  );
});
```

The `$form` property connects the controller to the form's submit, input, and focus-out events. The default `onSubmit` strategy validates on submit and clears a field error when that named field emits `input`. Use `onBlur` or `onInput` to validate the complete schema from the corresponding event. Field issues are grouped into message arrays by dotted path; pathless issues are available through `form.formErrors`. Successful submissions receive only parsed output and do not reset automatically.

Zod schemas can be passed directly as `schema`. `$form()` prefers `parseAsync()` when both methods exist, making async refinements work without a separate controller API.

`class`, `className`, and `classNames` are equivalent on DOM elements. Dynamic values accept strings, numbers, nested arrays, and object maps. For manual state outside compiled components, use `$signal()` and `$computed()` with their `.value` APIs.

## Queries and mutations

`$query()` caches an asynchronous function by a JSON key and exposes reactive request state. It runs once when its component mounts unless `enabled` is false or the cache is still fresh. `$mutation()` wraps imperative asynchronous work without running it automatically.

```tsx
import { $component, $mutation, $query, Suspense } from "solix";

const Posts = $component(function Posts() {
  const posts = $query(
    {
      queryKey: ["posts"],
      query: (page: number) => fetch(`/posts?page=${page}`).then((response) => response.json()),
      staleTime: 10_000,
      cacheTime: 5 * 60_000,
      pollingInterval: 30_000,
      suspense: { initial: true, refetch: false },
    },
    1,
  );
  const createPost = $mutation({
    mutation: (title: string) =>
      fetch("/posts", { method: "POST", body: JSON.stringify({ title }) }),
  });

  async function addPost() {
    await createPost.mutate({}, "A compiled query");
    await posts.refetch({ suspense: false }, 1);
  }

  return (
    <section>
      <button onClick={() => void posts.refetch({}, 2)} disabled={posts.isFetching}>
        Page 2
      </button>
      <button onClick={addPost} disabled={createPost.isMutating}>
        Add post
      </button>
      {(posts.data ?? []).map((post) => (
        <p key={post.id}>{post.title}</p>
      ))}
    </section>
  );
});

const App = $component(function App() {
  return (
    <Suspense fallback={<p>Loading posts…</p>}>
      <Posts />
    </Suspense>
  );
});
```

Query keys accept only JSON values and use their exact `JSON.stringify()` result as cache identity; argument-sensitive values must therefore be included in the key when they represent distinct resources. Same-key requests share data and an in-flight promise. `data` retains the latest successful result, `lastData` holds the result it replaced, and failures retain both while setting `error` and `isFailed`.

`staleTime` defaults to `0`, `cacheTime` to five minutes, and polling is disabled by default. Polling runs only while an enabled observer is mounted and the document is visible. Initial uncached requests participate in the nearest parent Suspense by default; cached refetches and mutations opt in through their config or per-call `suspense` option. Manual methods reject on failure. Call `refetch()` without arguments to reuse the most recently requested argument tuple; when passing new function arguments, an options object comes first so object-valued arguments remain unambiguous.

## Document head

Use the compiler-managed `Head` component to add reactive content to `document.head` without rendering a body wrapper:

```tsx
import { $component, Head } from "solix";

const Article = $component(function Article(props: { title: string; description: string }) {
  return (
    <article>
      <Head>
        <title>{props.title}</title>
        <meta name="description" content={props.description} />
        <meta property="og:title" content={props.title} />
        <style>{"article { text-wrap: pretty; }"}</style>
      </Head>
      <h1>{props.title}</h1>
    </article>
  );
});
```

Each `Head` block owns the nodes it inserts and removes only those nodes when its component or conditional branch is disposed. Managed blocks are inserted before static document-head content so their titles take effect; newer blocks precede older blocks. Existing content is preserved, and overlapping entries are not deduplicated.

Scripts are recreated as executable DOM elements before insertion. Inline and external scripts therefore follow native browser execution rules: insertion executes them, later inline-text updates do not rerun them, and cleanup cannot reverse their side effects.

During server rendering, pass `onHead` to collect the serialized managed head separately from the body markup. Insert that string into the document `<head>` and the returned body string into the application target before calling `hydrate()`. Hydration claims both trees in place, preserves script identity, and makes the claimed head nodes reactive and owned by their original blocks.

## Transitions

Use `$transition` on an intrinsic element that can enter or leave a conditional, keyed list, or route. Each phase is a whitespace-separated CSS class string, so the application can define animation details with Tailwind, another CSS framework, or its own stylesheet. Transitions run only for updates after the initial render:

```tsx
import { $component, type Transition } from "solix";

const fade: Transition = {
  enter: "animate-in fade-in duration-150",
  leave: "animate-out fade-out duration-100",
};

const List = $component(function List() {
  let items = [{ id: 1, label: "First" }];
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id} $transition={fade}>
          {item.label}
        </li>
      ))}
    </ul>
  );
});
```

The runtime adds the phase classes temporarily and waits for the CSS animations or transitions they create. Leave animations keep their DOM mounted until every transitioned descendant finishes. Re-adding the same conditional branch or keyed-list key cancels its leave and reuses the existing DOM. Route pages use the same directive on their intrinsic root. Reduced-motion preferences and browsers without `Element.getAnimations()` fall back to immediate insertion and removal.

Enable compilation in Vite:

```ts
import { defineConfig } from "vite";
import { solix } from "@solix/compiler/vite";

export default defineConfig({ plugins: [solix()] });
```

During `vite serve`, the plugin injects Solix devtools by default. A circular `S` launcher in the
bottom-right toggles a movable, resizable panel for component, loader/query/mutation, route-manifest,
and form diagnostics, including an element picker. Component, request, and route views use a
resizable master-detail layout, and the panel geometry persists locally. The same live metadata is
available at `globalThis.__solix`; browsers implementing WebMCP
also receive the read-only `solix_get_diagnostics` and `solix_inspect_element` tools. Production
builds do not include the entry or define the global unless explicitly enabled:

```ts
solix({ devtools: false }); // opt out during development
solix({ devtools: true }); // explicitly include it in any Vite command
```

`__solix.getSnapshot()` returns all diagnostic areas, while `getSnapshot("components")` and the
`components`, `requests`, `router`, and `forms` getters return individual areas. Components include
ownership through `parentId`; compiled queries and mutations include authored `source` file/line
metadata; router diagnostics include every compiled route definition. Use
`inspectElement(elementOrSelector)`, `open(tab?)`, `close()`, `startElementPicker()`, and
`subscribe(listener)` for integrations. These interfaces validate their inputs and are intended
only for trusted development environments.

For full-document SSR, add the `solkit` Vite plugin after the compiler, export the application root
from an entry module, and select `bunAdapter()` or `nodeAdapter()`. Development HTML requests render
through Vite middleware with imported stylesheets available for the initial render; `solkit build`
creates client and server bundles plus the selected launcher.
The generated launcher prints its bound HTTP address once it starts listening.
See `solkit/README.md` for the document outlets and complete configuration.

## Context and async rendering

Create a shared object context with `$context<T>()`. A provider accepts the object through its
`data` property, and descendants read a stable reactive proxy with `use()`. The proxy remains
writable and follows provider data replacement. `use()` throws when no matching provider exists;
use `useOptional()` when an absent provider is valid.

```tsx
const noteContext = $context<{ section: string; visits: number }>();

const AsyncNote = $component(async function AsyncNote() {
  const note = await getNote();
  const context = noteContext.use(); // context remains available after awaits
  return (
    <p>
      {context.section}: {note.text}
    </p>
  );
});

const App = $component(function App() {
  const shared = { section: "Inbox", visits: 0 };
  return (
    <noteContext.Provider data={shared}>
      <ErrorBoundary fallback={(error) => <p>{String(error)}</p>}>
        <Suspense
          fallback={<p>Loading…</p>}
          error={(error) => <p>Loading failed: {String(error)}</p>}
        >
          <AsyncNote />
          <Await $promise={getSummary()} error={(error) => <p>{String(error)}</p>}>
            {(summary) => <p>{summary.text}</p>}
          </Await>
        </Suspense>
      </ErrorBoundary>
    </noteContext.Provider>
  );
});
```

Suspense keeps its fallback visible until all async work owned by that boundary resolves. Nested
boundaries account for their own work. Without Suspense, an async component or Await leaves an empty
region until it is ready. Rejections are handled by the nearest Await `error` renderer, then the
owning Suspense `error` renderer, then ErrorBoundary. ErrorBoundary also catches synchronous
descendant setup/render failures; event-handler errors are not intercepted.

## Server rendering and hydration

`renderToStringAsync()` renders a compiled component without a browser DOM. It waits for async
components and `Await` blocks, serializes their results into the returned markup, and emits private
markers used by `hydrate()`:

```tsx
import { hydrate, renderToStringAsync } from "solix";

let head = "";
const html = await renderToStringAsync(
  App,
  { initialCount: 2 },
  {
    timeoutMs: 5_000,
    url: "https://example.com/blog/42",
    onHead: (value) => {
      head = value;
    },
  },
);

// In the browser, after placing `head` in document.head and `html` inside #app:
const dispose = await hydrate(App, document.querySelector("#app")!, { initialCount: 2 });
```

The server and browser must use the same compiled component and equivalent props. An absolute
HTTP(S) `url` resolves the active route before the root renders, so route handles and `router` expose
the same pathname and parsed parameters in server shell, Head, and route content. Hydration claims
the existing elements, attaches effects and events, removes the embedded data payload, and rejects
without replacing the DOM when element or region markers, compiler signatures, dynamic values, or
the async call sequence differ. Hydration mismatches bypass application async and error boundaries.

The render option supplies a five-second default timeout. `Suspense` can override it for one server
boundary with `timeoutMs`. A timed-out boundary emits its fallback; hydration claims that fallback,
then reruns only unfinished work in the browser. Async work outside Suspense rejects the server render
when it exceeds the render timeout.

Captured async data supports primitives, sparse and cyclic graphs, shared references, bigint,
special numbers, Date, RegExp, URL, Map, Set, Error, and plain or null-prototype objects. Functions,
symbols, DOM nodes, accessors, typed buffers, and custom-prototype instances are rejected. Awaited
expressions in compiled components, awaited local helper chains, and lazy `<Await $promise={...}>`
expressions are captured at module-qualified sites. Initial `$query()` promises participate in the
same request-isolated capture and replay, preventing a duplicate browser fetch after server data has
rendered. Promise initializers that are later awaited are made lazy for replay; unrelated unawaited
work and eager promises never consumed by a compiled await are not replayable.

## Routing

Routes are discovered automatically below the Vite project root. Define each route as an exported top-level constant in a `*.route.js`, `.jsx`, `.ts`, or `.tsx` file:

```tsx
import { $component, $route } from "solix";
import * as v from "valibot";

const BlogDetail = $component(function BlogDetail() {
  return <article>Blog entry</article>;
});

export const blogDetailRoute = $route(
  {
    path: "/blog/:id?page=:page",
    schema: v.object({
      id: v.pipe(v.string(), v.transform(Number)),
      page: v.pipe(v.string(), v.transform(Number)),
    }),
  },
  BlogDetail,
);
```

Paths are exact and case-sensitive. A segment beginning with `:` captures one required path parameter. A query template such as `?page=:page` declares a query parameter. The same logical parameter may appear in both places, as in `/blog/:id?selected=:id`; when both incoming values are present, they must agree. Static routes take precedence over parameter routes, so `/blog/new` is matched before `/blog/:id`.

Each compiled route is a typed handle. Its optional `schema` accepts the same callable, `parse()`, `parseAsync()`, and Standard Schema formats as `$form`, including Valibot schemas directly. The parser receives one decoded string record containing both path and declared query parameters; repeated query keys use their final value. Its output must contain exactly the route's declared parameters as strings or numbers. Parsed output types flow through the handle and every typed destination:

```tsx
const id = blogDetailRoute.params.id; // number
const page = blogDetailRoute.params.page; // number
blogDetailRoute.navigate({ params: { id: 42, page: 2 } });

blogDetailRoute.isActive; // exact route match
blogDetailRoute.isActivePrefix; // true anywhere below /blog
```

Routes without a schema retain inferred string values for path parameters and optional strings for query-only parameters. A schema may likewise return `undefined` for a query-only value; `Link` and `navigate()` omit it from the generated URL. `query` is a compatibility alias for the same object exposed by `params`. Reading either property from an inactive, pending, or invalid route throws instead of returning stale values. A recognized schema validation failure makes the route not match; other parser errors remain visible. Async validation ignores stale results after newer navigation.

Use `Link` when the destination is represented by a route handle. It requires exactly one anchor child, supplies that anchor's `href`, and intercepts eligible same-tab clicks without adding a wrapper element:

```tsx
import { Link } from "solix";

<Link route={blogDetailRoute} params={{ id: 42, page: 2 }}>
  <a class="entry-link">Open entry</a>
</Link>;
```

The route handle determines every required value in its single `params` prop. Author styling, ARIA, targets, downloads, and click handlers on the child anchor; do not provide `href`. Prevented, targeted, downloaded, and modified clicks retain native behavior.

Place the route outlet in a compiled application shell and inspect the active location through the reactive `router` object:

```tsx
import { $component, Route, router } from "solix";

const LoadingRoute = $component(function LoadingRoute() {
  return <p>Loading…</p>;
});

const App = $component(function App() {
  return (
    <main>
      <p>Current path: {router.pathname}</p>
      <p>Entry: {router.params.id}</p>
      <button onClick={() => router.navigate("/")}>Home</button>
      <Route pending={LoadingRoute} />
    </main>
  );
});
```

The optional `pending` component renders while an asynchronous schema resolves. Without it, the outlet remains empty during validation. The global `router` remains available for destinations that are not represented by a route handle. It exposes `pathname`, `search`, `hash`, `searchParams`, untyped parsed `params` (with `query` as an alias), the matched route config, and `navigate(path, { replace? })`. Same-origin root-relative anchors are still handled through browser history.

`routerReady` resolves after the browser's initial asynchronous route schema has settled. Solkit
awaits it automatically before hydration; custom hydration entries should do the same before calling
`hydrate()` when their routes use asynchronous schemas.

The example uses Tailwind CSS v4 through `@tailwindcss/vite`; its CSS entry imports `tailwindcss` and defines the paper-ledger design tokens with `@theme`.

## Verification

```bash
bun run typecheck
bun test
bun run build
bun run test:e2e
```
