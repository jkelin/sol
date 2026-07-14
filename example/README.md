# Sol example

This private workspace package is a notebook-style Sol application. It demonstrates reactive component state and document-head content, forms with Valibot validation, bindings, keyed lists, transitions, contexts, portals, resolved and timed-out Suspense, Await, error boundaries, cached queries, polling, mutations, compile-time routes, typed parameters, and browser navigation. The `/queries` route uses named, tuple-validated `$rpcQuery` and `$rpcMutation` declarations for its Suspense fetch and explicit refresh workflow, and exports a validated `GET /api/notes/:id` `$httpRoute`.

From the repository root:

```bash
bun run dev
bun run build
bun run start
bun run test:e2e
```

The development server includes Sol devtools by default. Use the circular `S` launcher in the
bottom-right to inspect the mounted component ownership tree, loaders and requests with authored
query/mutation locations, routing, and form validation, or access the
same data through `globalThis.__sol` and supported browsers' WebMCP tooling. The production build
does not include devtools.

Development runs through Solkit's Vite SSR middleware. The production build writes browser assets to
`example/dist/client` and a bundled SSR handler plus Bun launcher to `example/dist/server`. The
build-output test checks that readable compiler output contains Sol templates, routes, reactivity,
and transitions. The query declarations import their validators and a fake secret from
`src/notes-backend.ts`; the build-output test requires those markers in the server bundle and rejects
them in both client JavaScript and source maps. Playwright exercises server-rendered routes, managed
head content, async/query data replay, browser hydration, and navigation against both the Bun and
Node.js deployment adapters, as well as Vite development middleware. A focused fixture under
`tests/fixtures` also covers timed-out Suspense continuation in a real browser.
