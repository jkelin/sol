# Solkit

`@soljs/solkit` is the backend runtime and Vite integration for full-stack Sol applications. It renders
the same compiled root component on the server, injects managed `Head` output into the document,
and hydrates the server tree in the browser. Development requests run through Vite middleware;
production builds can emit a Bun or Node.js server, or prerender a multipage static site. The same
request pipeline dispatches compiled RPC and HTTP endpoints before server-hosted document rendering.
Named queries and mutations share the JSON `POST /api/rpc/:name` protocol; lower-level HTTP routes
retain their explicitly declared methods and body modes.

`bun run build` writes one tree-shakeable ESM bundle (`dist/index.js`) and one rolled-up declaration file (`dist/index.d.ts`), then formats both files with Oxfmt. Every published Solkit subpath and the installed `solkit` command resolve to the shared JavaScript bundle; guarded direct-execution detection keeps ordinary and build-time library imports from starting or re-entering the CLI.

## Configure an application

The HTML document owns two required outlets. Put the head outlet before fallback title or metadata
so compiler-managed head entries have browser precedence.

```html
<head>
  <!--solkit-head-->
  <title>Fallback title</title>
</head>
<body>
  <div id="app"><!--solkit-body--></div>
</body>
```

Export the compiled root from one entry module and import application CSS there:

```tsx
import "./styles.css";
export { Shell as App } from "./Shell.tsx";
```

Then add both Vite plugins and choose a deployment adapter:

```ts
import { sol } from "@soljs/compiler/vite";
import { bunAdapter } from "@soljs/solkit/adapters/bun";
import { solkit } from "@soljs/solkit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sol(), solkit({ entry: "/src/entry.tsx", adapter: bunAdapter() })],
});
```

The entry exports `App` by default. Set `exportName` when the root uses another named export, for
example `solkit({ entry: "/src/entry.tsx", exportName: "Shell", adapter: bunAdapter() })`.
RPC and HTTP request bodies are limited to 1 MiB by default. Set `maxBodyBytes` to a non-negative
safe integer to choose another limit; declared and streamed oversized bodies receive 413 responses.

Use `vite` for development and `solkit build` for production. The build writes browser assets to
`dist/client`, the bundled Fetch-style SSR handler to `dist/server/app.mjs`, and the selected host
launcher to `dist/server/index.mjs`. Start the launcher with Bun or Node as selected. `HOST` defaults
to `0.0.0.0`, and `PORT` defaults to `3000`. Once the listener is ready, the launcher prints its
bound HTTP address and actual port.

In development, Solkit follows the complete client module graph and adds stylesheet links to the
server-rendered document before it is sent. CSS imported by the entry, nested components, and route
modules is therefore available for first paint. Once Vite has evaluated the client imports, Solkit
removes those temporary links and Vite owns the styles and their hot updates.

### Static sites

Use `staticAdapter()` to render canonical application paths at build time. Solkit automatically
includes every route without a pathname parameter. Export `staticPaths` only to add concrete
parameterized paths; explicit literal paths remain accepted and are deduplicated with inferred
paths. Static paths are logical root-relative pathnames without queries, hashes, dot segments,
backslashes, or a trailing slash. A literal route with a query template contributes its canonical
pathname once; for example, `/search?term=:term` generates `dist/search/index.html`.

```tsx
// src/entry.tsx
export { App } from "./App.tsx";
export const staticPaths = ["/docs/routing"] as const;
```

```ts
import { staticAdapter } from "@soljs/solkit/adapters/static";

solkit({ entry: "/src/entry.tsx", adapter: staticAdapter() });
```

`solkit build` renders `/` to `dist/index.html` and every other path to its nested
`index.html`. The directory is a self-contained deployment artifact containing the prerendered
documents and Vite's shared and route-specific CSS, JavaScript, and assets. Each document preloads
only its matched route-file chunk and static navigation performs a document load. The temporary SSR
bundle and client manifest are removed after prerendering. Rendering fails rather than overwriting
an existing nested `index.html`. Link to nested documents with directory URLs such as `/docs/`; the
logical route and `staticPaths` values omit the trailing slash.

Route-specific stylesheet and module-preload URLs preserve Vite's configured deployment `base`,
including imported shared chunks.

Solkit emits adapted files through Vite's output-generation pipeline. Prerendered HTML therefore
appears in Vite's build report and is visible to subsequent `generateBundle` and `writeBundle`
hooks instead of being copied into `dist` after the bundle has closed.

For a project site such as GitHub Pages, set Vite's root-relative `base` (for example `/sol/`).
Solkit configures server-rendered route links and browser routing with that base before hydration.
Literal application anchors should use `import.meta.env.BASE_URL`, while route state,
`router.navigate()`, route handles, and `staticPaths` continue to use logical paths beginning at `/`.

`nodeAdapter()` from `@soljs/solkit/adapters/node` emits the equivalent Node.js HTTP launcher. Both
adapters serve built static files from `dist/client`, dispatch `.sol` RPC and HTTP endpoints, and
send HTML-accepting GET or HEAD requests through the SSR renderer. Extensionless routes with an
absent or wildcard `Accept` header also count as document requests. Missing endpoints and
non-document assets return 404; method mismatches on a known HTTP path return 405 with an `Allow`
header. Route state and query caches are isolated by request. Settled query data, async
components, `Await`, Suspense state, managed head nodes, and hydration metadata cross the server to
the browser through the Sol hydration protocol.

### Custom adapters

Implement the exported `SolkitAdapter` interface to target another host. An adapter has a non-empty
`name` and a `write(context)` method. After the client and server bundles complete, Solkit calls
`write` inside a final Vite output-generation phase. `SolkitAdapterContext` supplies absolute
`serverDirectory` and `clientDirectory` paths plus a `writeFile` function that emits the requested
file through Vite. Adapters can fall back to direct filesystem writes when invoked independently,
but production `solkit build` output remains visible to Vite output hooks and reporting. An adapter
must not modify the bundled `app.mjs` handler or client assets, and public implementations should
validate their context before writing.

## Low-level request handler

`createRequestHandler(root, endpoints?, options?)` exposes the Fetch-style handler used by the Vite
integration and generated launchers. `root` is the compiled application component, `endpoints` is
the generated server manifest, and `options.maxBodyBytes` overrides the 1 MiB body limit. Dynamic
handlers reject document URLs outside the configured deployment base. Static renderers set
`options.logicalPaths` so authored paths can be rendered before deployment. The returned `RequestHandler`
accepts a standard `Request` plus a `RenderContext` containing the full
HTML `template`; it dispatches endpoints, handles GET and HEAD document requests, and returns a standard `Response`.
Templates must contain exactly one `<!--solkit-head-->` outlet and one `<!--solkit-body-->` outlet.
The handler forwards the request URL into the Sol renderer, replaces both outlets, and preserves
the resulting hydration payload for the browser entry.

```ts
import { createRequestHandler } from "@soljs/solkit";

import { App } from "./entry.tsx";

const handle = createRequestHandler(App);
const response = await handle(request, { template });
```

## Source files

- `index.ts` dispatches compiled endpoints, validates document requests and templates, renders the
  root, and composes full HTML.
- `types.ts` defines the request handler, Vite options, adapter, and build context contracts.
- `vite.ts` provides virtual browser/server entries, installs generated routes before server rendering,
  streams Vite development requests, coordinates build targets and hydration readiness, and emits adapter output through Vite.
- `cli.ts` runs the Vite client, SSR, and adapter-finalization production builds with Bun.
- `adapter-utils.ts` loads statically identified launcher source through Bun's bundlable text loader
  or Node's file API, validates adapter output paths, and emits or directly writes launchers.
- `adapters/bun.ts` emits the Bun static-file and Fetch-handler host.
- `adapters/node.ts` emits the Node.js HTTP/static-file host and bridges Web responses.
- `adapters/static.ts` validates an entry's static paths and emits prerendered documents beside the
  built client assets.
- `adapters/bun-launcher.mjs` is the formatted launcher source loaded as text by the Bun adapter.
- `adapters/node-launcher.mjs` is the formatted launcher source loaded as text by the Node adapter.

All public configuration and request boundaries validate their inputs before rendering or writing.
