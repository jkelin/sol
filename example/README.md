# Solix example

This private workspace package is a notebook-style Solix application. It demonstrates reactive component state and document-head content, forms with Valibot validation, bindings, keyed lists, transitions, contexts, Suspense and Await, cached queries, polling, mutations, compile-time routes, typed parameters, and browser navigation. The `/queries` route shows an initial Suspense fetch, two observers sharing a JSON-keyed cache, argument-changing refetches, and a mutation followed by an explicit refresh.

From the repository root:

```bash
bun run dev
bun run build
bun run test:e2e
```

The development server includes Solix devtools by default. Use the circular `S` launcher in the
bottom-right to inspect the mounted component ownership tree, loaders and requests with authored
query/mutation locations, routing, and form validation, or access the
same data through `globalThis.__solix` and supported browsers' WebMCP tooling. The production build
does not include devtools.

The production build is written to `example/dist`. The build-output test checks that readable compiler output contains Solix templates, routes, reactivity, and transitions. Playwright exercises the complete application through the Vite preview server and uses a small fixture under `tests/fixtures` to server-render and hydrate an async component tree in a real browser.
