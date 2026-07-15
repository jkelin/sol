---
name: soljs
description: Build applications with the Sol compiled JSX framework. Use when creating Sol components, reactivity, forms, data fetching, routing, async UI, transitions, or Solkit applications, and when translating React patterns to Sol.
---

# Sol

Sol is a compiled JSX framework. Its compiler turns component JSX into static HTML templates and fine-grained DOM operations. A component's setup function runs once for each mounted instance; reactive changes update only the operations that depend on the changed state.

## Use Sol

1. Install `@soljs/sol` and the Vite compiler plugin `@soljs/compiler`, put `sol()` before other JSX transforms, and set TypeScript's `jsxImportSource` to `@soljs/sol`.
2. Define components with `$component(function Name() { ... })`. Put component-owned state in writable local declarations and derived state in directly dependent `const` declarations.
3. Return JSX from setup and mount the root component with `mount()`. Use ordinary reads and assignments inside compiled components; use `$signal()` and `$computed()` with `.value` only for state outside compiler-managed setup.
4. Reach for Sol's owned primitives for forms, queries, routing, async boundaries, context, portals, document head, and transitions. Read the matching feature page below before using an API.

The implementation is complete when every Sol API and compiler convention it uses is covered by the relevant linked documentation.

## Differences from React

- **Compilation instead of rerendering:** React calls component functions again and reconciles virtual trees. Sol runs setup once, clones a compiled static template, and patches precise DOM operations.
- **Inferred state instead of hooks:** writable locals become signals and directly derived constants become computed values. Component code reads and assigns ordinary variables instead of calling `useState` setters.
- **Dependency-driven updates:** the compiler discovers direct reactive reads. Use `$computed(() => ...)` when a helper hides a dependency from the initializer.
- **Owned blocks:** conditional branches, keyed rows, routes, async work, and transitions own their effects and dispose them with their mounted DOM block.
- **Specialized composition:** general component children are not part of Sol's first version. Prefer explicit typed props; built-ins such as `Suspense`, `Await`, `ErrorBoundary`, `Head`, `Link`, and context providers have compiler-defined child contracts.
- **DOM-oriented JSX:** events use JSX handlers, while `class`, `className`, and `classNames` are equivalent. `$bind` provides two-way form-control binding.

Translate React designs into Sol's setup-and-operations model rather than reproducing hook or rerender patterns.

## Examples

### Compiled UI, forms, refs, portals, and transitions

Use writable locals for state, direct `const` declarations for derived values, and an explicit `$computed` when a helper hides its dependencies.

```tsx
import {
  $component,
  $computed,
  $form,
  createRef,
  GlobalPortal,
  Head,
  Portal,
  type Transition,
} from "@soljs/sol";

const fade: Transition = { enter: "fade-in", leave: "fade-out" };

export const TaskBoard = $component(function TaskBoard() {
  let tasks = [{ id: 1, title: "Learn compiled reactivity", done: false }];
  let showGlobalNotice = false;
  const localPortal = createRef<HTMLDivElement>();

  function completedLabel() {
    return `${tasks.filter((task) => task.done).length}/${tasks.length} complete`;
  }

  const progress = $computed(() => completedLabel());
  const form = $form(
    {
      defaultValues: { title: "" },
      schema(values) {
        const title = values.title.trim();
        if (!title) throw { issues: [{ message: "Enter a title", path: ["title"] }] };
        return { title };
      },
      validationStrategy: "onSubmit",
    },
    ({ title }) => {
      tasks.push({ id: Date.now(), title, done: false });
      form.reset();
    },
  );

  return (
    <main>
      <Head>
        <title>Task board · {progress}</title>
      </Head>

      <h1>Task board</h1>
      <p>{progress}</p>
      <ul>
        {tasks.map((task) => (
          <li key={task.id} classNames={{ complete: task.done }}>
            <label>
              <input type="checkbox" $bind={task.done} />
              {task.title}
            </label>
          </li>
        ))}
      </ul>

      <form $form={form}>
        <input name="title" $bind={form.values.title} />
        <p role="alert">{form.errors.title?.[0]}</p>
        <button disabled={form.isSubmitting}>Add task</button>
      </form>

      <div ref={localPortal} />
      {tasks.length > 1 && (
        <Portal target={localPortal.current!}>
          <p $transition={fade}>The local portal preserves its owner and context.</p>
        </Portal>
      )}

      <button onClick={() => (showGlobalNotice = true)}>Show notice</button>
      {showGlobalNotice && (
        <GlobalPortal>
          <button $transition={fade} onClick={() => (showGlobalNotice = false)}>
            Dismiss global notice
          </button>
        </GlobalPortal>
      )}
    </main>
  );
});
```

### Full-stack routing, data, context, and async UI

Export routes and server declarations as top-level constants from a `.sol.ts` or `.sol.tsx` file. Validate every network boundary with a schema.

```tsx
import {
  $component,
  $context,
  $httpRoute,
  $mutation,
  $query,
  $route,
  $rpcMutation,
  $rpcQuery,
  Await,
  ErrorBoundary,
  Link,
  Route,
  Suspense,
  type HttpRouteInput,
} from "@soljs/sol";
import * as v from "valibot";

interface Note {
  id: number;
  title: string;
}

const notes: Note[] = [];
const session = $context<{ user: string }>();

export const loadNotes = $rpcQuery(
  "load-notes",
  { schema: v.tuple([v.pipe(v.number(), v.integer(), v.minValue(1))]) },
  async (page) => notes.slice((page - 1) * 10, page * 10),
);

export const saveNote = $rpcMutation(
  "save-note",
  { schema: v.tuple([v.pipe(v.string(), v.trim(), v.minLength(1))]) },
  async (title) => {
    const note = { id: notes.length + 1, title };
    notes.unshift(note);
    return note;
  },
);

export const noteEndpoint = $httpRoute(
  {
    method: "GET",
    path: "/api/notes/:id",
    schema(input: HttpRouteInput) {
      const id = Number(input.params.id);
      if (!Number.isInteger(id) || id < 1) throw { issues: [{ message: "Invalid note id" }] };
      return { id };
    },
  },
  async ({ id }) => Response.json(notes.find((note) => note.id === id) ?? null),
);

const HomePage = $component(function HomePage() {
  return (
    <Link route={notesRoute} params={{ page: 1 }}>
      <a>Open notes</a>
    </Link>
  );
});

const NotesPage = $component(function NotesPage() {
  const { user } = session.use();
  const page = notesRoute.params.page;
  const query = $query({ queryKey: ["notes", page], query: loadNotes, staleTime: 5_000 }, page);
  const mutation = $mutation({ mutation: saveNote });
  const greeting = Promise.resolve(`Welcome, ${user}`);

  async function addNote() {
    await mutation.mutate({}, "A validated note");
    await query.refetch({ suspense: false }, page);
  }

  return (
    <ErrorBoundary fallback={(error) => <p>Page failed: {String(error)}</p>}>
      <Suspense fallback={<p>Loading notes…</p>}>
        <Await $promise={greeting}>{(message) => <p>{message}</p>}</Await>
        <button disabled={mutation.isMutating} onClick={addNote}>
          Add note
        </button>
        <ul>
          {query.data?.map((note) => (
            <li key={note.id}>{note.title}</li>
          ))}
        </ul>
        <Link route={homeRoute}>
          <a>Home</a>
        </Link>
      </Suspense>
    </ErrorBoundary>
  );
});

export const homeRoute = $route({ path: "/" }, HomePage);
export const notesRoute = $route(
  {
    path: "/notes/:page",
    schema: v.object({ page: v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1)) }),
  },
  NotesPage,
);

export const App = $component(function App() {
  return (
    <session.Provider data={{ user: "Ada" }}>
      <Route />
    </session.Provider>
  );
});
```

## Public API

Treat `@soljs/sol/compiler-runtime` as compiler-generated infrastructure. Author application code with the APIs below.

### Components, rendering, and reactivity

- `$component(setup)` declares a compiler-managed component whose setup runs once per mount.
- `mount(component, target, props?)` replaces a browser target's contents with a compiled root and returns its cleanup function.
- `hydrate(component, target, props?)` attaches a compiled root to compatible server-rendered DOM and returns its cleanup function asynchronously.
- `renderToStringAsync(component, props?, options?)` renders body HTML on the server and reports `Head` HTML through `onHead`.
- `$signal(initial)` creates manual reactive state with a writable `.value`, primarily outside compiled setup.
- `$computed(derive)` creates manual derived state with a readonly `.value`; inside compiled setup it also makes hidden dependencies explicit.
- `createRef<T>()` creates a non-reactive `{ current }` object for an intrinsic element ref.

### Forms and data

- `$form(config, submit)` creates a validated form controller. Its methods are `submit()`, `handleInput()`, `handleBlur()`, `reset()`, and `clearErrors()`; `$form={controller}` connects the standard DOM events.
- `$query(config, ...args)` creates an owned, JSON-keyed query observer. Call `refetch(options, ...args)` to force another request.
- `$mutation(config)` creates an owned imperative mutation controller. Call `mutate(options, ...args)` to run it.

### Routes and server declarations

- `$route(config, component)` declares an exported typed route. A route handle exposes `navigate(destination, options?)`, parsed `params`/`query`, `isActive`, and `isActivePrefix`.
- `$rpcQuery(name, config, handler)` declares a schema-validated JSON POST RPC intended for reads.
- `$rpcMutation(name, config, handler)` declares the corresponding RPC intended for writes.
- `$httpRoute(config, handler)` declares a schema-validated Fetch endpoint for an HTTP method and path.
- `configureRouterBase(base)` configures routing below a root-relative deployment base; Solkit normally calls it.
- `router.navigate(path, options?)` performs untyped navigation; `router` also exposes the current location, match, and parsed parameters.

### Context and JSX built-ins

- `$context<T>()` creates a context with a `Provider`, `use()`, and `useOptional()`.
- `Head` renders owned reactive children into `document.head` and a separate SSR head outlet.
- `Portal` renders owned children into a reactive target element; `GlobalPortal` renders them under `document.body`.
- `Link` decorates one anchor with a typed route destination.
- `Route` renders the active route and accepts an optional pending component.
- `Suspense` owns descendant async work, fallback timing, and an optional error renderer.
- `Await` renders a promise result and may handle its rejection locally.
- `ErrorBoundary` catches descendant setup and render failures.
- `$bind={state}`, `$form={controller}`, and `$transition={definition}` are compiler-handled JSX directives rather than callable functions.

### Compiler, Vite, Solkit, and devtools

- `compile(source, filename, options?)` from `@soljs/compiler` validates and transforms one Sol module.
- `sol(options?)` from `@soljs/compiler/vite` compiles JSX, discovers route and server declarations, and optionally installs development tools.
- `solkit(options)` from `solkit/vite` adds client/server builds, request handling, routing setup, hydration, and the selected deployment adapter.
- `createRequestHandler(root, endpoints?, options?)` from `solkit` creates a Fetch-compatible SSR and endpoint handler.
- `bunAdapter()` from `solkit/adapters/bun` builds a Bun server launcher.
- `nodeAdapter()` from `solkit/adapters/node` builds a Node.js server launcher.
- `staticAdapter()` from `solkit/adapters/static` prerenders `staticPaths` into nested HTML documents.
- `installDevtools()` from `@soljs/sol/devtools` installs and returns the development inspector when a browser document is available. The inspector provides `getSnapshot()`, `inspectElement()`, `open()`, `close()`, `startElementPicker()`, and `subscribe()`.

`routerReady` is the promise that settles after initial router synchronization. `Transition` is the `{ enter?, leave? }` type used by `$transition`; the remaining exported names are supporting types for the APIs above.

## Feature documentation

- [Getting started](getting-started.md) — installation, compiler setup, a first component, and mounting.
- [Mental model and compilation](mental-model.md) — setup, dependency inference, DOM operations, ownership, and disposal.
- [Components and JSX](components-and-jsx.md) — props, events, classes, composition, refs, portals, and document head.
- [Reactivity](reactivity.md) — inferred signals, computed values, deep proxies, bindings, and manual primitives.
- [Forms and validation](forms-and-validation.md) — schema-backed form controllers and validation strategies.
- [Routing](routing.md) — typed route declarations, links, outlets, parameters, and navigation.
- [Queries and mutations](queries-and-mutations.md) — cached async data, server declarations, freshness, polling, and mutations.
- [Async rendering and context](async-and-context.md) — providers, `Await`, `Suspense`, and error boundaries.
- [Transitions](transitions.md) — enter and leave lifecycle, cancellation, and CSS phases.
- [API reference](api-reference.md) — compact runtime, compiler, Solkit, and validation interface index.
