---
title: API Reference
description: A compact index of the public runtime, compiler, component, form, query, routing, async, and transition interfaces.
section: Reference
order: 10
---

## Components and mounting

- `$component(setup)` defines a compiler-managed component.
- `mount(component, target)` mounts one compiled component into a validated DOM target.
- `Head` mounts owned JSX children into `document.head` without a body wrapper or deduplication.
- `renderToStringAsync(component, props?, { timeoutMs?, onHead? })` serializes body markup and reports compiler-managed Head markup through the required `onHead` callback when present, after the hydration payload has serialized successfully.
- `class`, `className`, and `classNames` are equivalent on intrinsic elements.
- `createRef<T>()` creates a mutable, non-reactive `{ current: T | null }` DOM ref; intrinsic `ref` also accepts callback and structurally compatible object refs.
- `Portal` renders JSX, text, and primitive children into a required reactive `Element` target without recreating them during retargeting.
- `GlobalPortal` renders the same child types directly under `document.body` without an element wrapper.

## Reactivity

- `$signal(initial)` creates manual state outside compiled component inference.
- `$computed(read)` creates an explicit derived value.
- `$bind={state}` connects supported form controls in both directions.

`batch()` is an internal compiler-runtime operation, not an author-facing export from `@soljs/sol`.

## Forms

- `$form(options, submit)` creates values, errors, form errors, submission state, reset behavior, and validation handlers.
- `$form={controller}` connects the controller to an intrinsic form.
- Parser inputs may be callable, expose `parse()` or `parseAsync()`, or implement Standard Schema.

## Queries and mutations

- `$query(config, ...initialArgs)` creates a component-owned, JSON-keyed query observer and starts its enabled initial request.
- Query config contains `query`, `queryKey`, `enabled`, `staleTime`, `cacheTime`, `pollingInterval`, and phase-specific `suspense` options.
- Query controllers expose `data`, `lastData`, `error`, `isFetching`, `isRefetching`, `isFailed`, and `refetch(options, ...args)`.
- `$mutation({ mutation, suspense? })` creates an imperative mutation controller without starting work.
- Mutation controllers expose `data`, `lastData`, `error`, `isMutating`, `isFailed`, and `mutate(options, ...args)`.
- `QueryKey`, config, controller, Suspense, and per-call option types are exported from `@soljs/sol`.

## Server declarations

- `$rpcQuery(name, { schema }, handler)` declares a validated JSON POST RPC whose schema parses the full argument tuple.
- `$rpcMutation(name, { schema }, handler)` declares the corresponding POST RPC.
- `$httpRoute({ method, path, schema, body? }, handler)` declares a Fetch endpoint with decoded path parameters, query values, headers, and JSON/text or byte body input.
- Server declarations and `$route()` must be exported top-level constants in `.sol.ts` or `.sol.tsx` files.
- HTTP handlers receive the schema output and original `Request`, and must return a `Response`.
- Static HTTP path segments are URL-canonicalized. Paths reject query or fragment syntax, backslashes, control characters, dot segments, trailing or empty segments, and authored percent escapes; use `:parameter` for decoded dynamic segments.
- RPC and HTTP request bodies are limited to 1 MiB by default. Configure another non-negative byte limit with `solkit({ entry, adapter, maxBodyBytes })`; oversized requests return 413.

## Routing

- `$route(config, component)` declares a compile-time route handle.
- `Link` decorates exactly one anchor child with a typed destination.
- `Route` renders the active route and an optional pending component.
- `router` exposes browser location state and untyped navigation.

## Context and async work

- `$context<T>()` creates `Provider`, `use()`, and `useOptional()`.
- `Suspense` owns async fallback and error rendering.
- `Await` renders a promise result and may own a local error renderer.
- `ErrorBoundary` catches descendant setup and rendering failures.

## Transitions

- `$transition={transition}` attaches enter and leave phases to eligible intrinsic blocks.
- `Transition` contains optional whitespace-separated `enter` and `leave` class strings.

## Compiler and Vite

- `compile(source, filename, { target? })` from `@soljs/compiler` validates and transforms one Sol module for a client or server target. It returns `{ code, map }`, where `map` is the generated source map or `null` when no compiled declarations are present.
- `CompileOptions` and `CompileResult` describe that boundary.
- `sol()` from `@soljs/compiler/vite` compiles TSX, discovers `.sol` UI and server declarations, rejects colliding route and endpoint matchers, and maintains both virtual manifests during development.
- `staticAdapter()` from `solkit/adapters/static` renders the entry module's non-empty `staticPaths` array into nested `index.html` documents beside Vite's client assets.
- `configureRouterBase(base)` configures logical routing beneath a validated root-relative deployment base; Solkit calls it automatically with Vite's `BASE_URL` before hydration.
- Place `sol()` before other JSX transforms in the Vite plugin list. The website additionally places its Markdown compiler before `sol()` so generated examples use the same compiler path.

## Validation behavior

Public runtime boundaries reject invalid targets, component factories, transition definitions, route destinations, schema outputs, class values, and context usage with descriptive errors. Prefer those failures over silently accepting ambiguous state.
