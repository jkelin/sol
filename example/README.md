# Solix example

This private workspace package is a notebook-style Solix application. It demonstrates reactive component state, forms with Valibot validation, bindings, keyed lists, transitions, contexts, Suspense and Await, compile-time routes, typed parameters, and browser navigation.

From the repository root:

```bash
bun run dev
bun run build
bun run test:e2e
```

The production build is written to `example/dist`. The build-output test checks that readable compiler output contains Solix templates, routes, reactivity, and transitions. Playwright exercises the complete application through the Vite preview server.
