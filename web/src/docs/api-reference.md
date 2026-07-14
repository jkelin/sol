---
title: API Reference
description: A compact index of the public runtime, component, form, routing, async, and transition interfaces.
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
- `batch(callback)` groups writes before reactive consumers run.
- `$bind={state}` connects supported form controls in both directions.

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

## Validation behavior

Public runtime boundaries reject invalid targets, component factories, transition definitions, route destinations, schema outputs, class values, and context usage with descriptive errors. Prefer those failures over silently accepting ambiguous state.
