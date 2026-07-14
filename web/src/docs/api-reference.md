---
title: API Reference
description: A compact index of the public runtime, compiler, component, form, routing, async, and transition interfaces.
section: Reference
order: 9
---

## Components and mounting

- `$component(setup)` defines a compiler-managed component.
- `mount(component, target)` mounts one compiled component into a validated DOM target.
- `class`, `className`, and `classNames` are equivalent on intrinsic elements.

## Reactivity

- `$signal(initial)` creates manual state outside compiled component inference.
- `$computed(read)` creates an explicit derived value.
- `$bind={state}` connects supported form controls in both directions.

`batch()` is an internal compiler-runtime operation, not an author-facing export from `solix`.

## Forms

- `$form(options, submit)` creates values, errors, form errors, submission state, reset behavior, and validation handlers.
- `$form={controller}` connects the controller to an intrinsic form.
- Parser inputs may be callable, expose `parse()` or `parseAsync()`, or implement Standard Schema.

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

- `compile(source, filename)` from `@solix/compiler` validates and transforms one Solix TSX module. It returns `{ code, map }`, where `map` is the generated source map or `null` when no compiled declarations are present.
- `CompileResult` is the exported result type for that `{ code, map }` object.
- `solix()` from `@solix/compiler/vite` returns the Vite plugin that compiles TSX, discovers typed route modules, rejects colliding route matchers, and maintains the virtual route manifest during development.
- Place `solix()` before other JSX transforms in the Vite plugin list. The website additionally places its Markdown compiler before `solix()` so generated examples use the same compiler path.

## Validation behavior

Public runtime boundaries reject invalid targets, component factories, transition definitions, route destinations, schema outputs, class values, and context usage with descriptive errors. Prefer those failures over silently accepting ambiguous state.
