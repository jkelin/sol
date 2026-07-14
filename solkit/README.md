# Solkit

`solkit` is the backend runtime and Vite integration for full-stack Solix applications. It renders
the same compiled root component on the server, injects managed `Head` output into the document,
and hydrates the server tree in the browser. Development requests run through Vite middleware;
production builds emit separate client and SSR bundles plus a Bun or Node.js launcher.

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
import { solix } from "@solix/compiler/vite";
import { bunAdapter } from "solkit/adapters/bun";
import { solkit } from "solkit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [solix(), solkit({ entry: "/src/entry.tsx", adapter: bunAdapter() })],
});
```

The entry exports `App` by default. Set `exportName` when the root uses another named export, for
example `solkit({ entry: "/src/entry.tsx", exportName: "Shell", adapter: bunAdapter() })`.

Use `vite` for development and `solkit build` for production. The build writes browser assets to
`dist/client`, the bundled Fetch-style SSR handler to `dist/server/app.mjs`, and the selected host
launcher to `dist/server/index.mjs`. Start the launcher with Bun or Node as selected. `HOST` defaults
to `0.0.0.0`, and `PORT` defaults to `3000`. Once the listener is ready, the launcher prints its
bound HTTP address and actual port.

In development, Solkit follows the complete client module graph and adds stylesheet links to the
server-rendered document before it is sent. CSS imported by the entry, nested components, and route
modules is therefore available for first paint. Once Vite has evaluated the client imports, Solkit
removes those temporary links and Vite owns the styles and their hot updates.

`nodeAdapter()` from `solkit/adapters/node` emits the equivalent Node.js HTTP launcher. Both
adapters serve built static files from `dist/client` and send HTML-accepting GET or HEAD requests
through the SSR handler. Extensionless routes with an absent or wildcard `Accept` header also count
as document requests. Missing non-document assets return 404, and other methods return 405 with an
`Allow` header. Route state and query caches are isolated by request. Settled query data, async
components, `Await`, Suspense state, managed head nodes, and hydration metadata cross the server to
the browser through the Solix hydration protocol.

### Custom adapters

Implement the exported `SolkitAdapter` interface to target another host. An adapter has a non-empty
`name` and a `write(context)` method. Solkit calls `write` after the server build completes, passing
absolute `serverDirectory` and `clientDirectory` paths in `SolkitAdapterContext`. The adapter writes
its launcher into the server directory without modifying the bundled `app.mjs` handler or client
assets. Public adapter implementations should validate these paths before writing.

## Low-level request handler

`createRequestHandler(root)` exposes the Fetch-style SSR handler used by the Vite integration and
generated launchers. `root` is the compiled application component. The returned `RequestHandler`
accepts a standard `Request` plus a `RenderContext` containing the full
HTML `template`; it handles GET and HEAD document requests and returns a standard `Response`.
Templates must contain exactly one `<!--solkit-head-->` outlet and one `<!--solkit-body-->` outlet.
The handler forwards the request URL into the Solix renderer, replaces both outlets, and preserves
the resulting hydration payload for the browser entry.

```ts
import { createRequestHandler } from "solkit";

import { App } from "./entry.tsx";

const handle = createRequestHandler(App);
const response = await handle(request, { template });
```

## Source files

- `index.ts` validates document requests and templates, renders the root, and composes full HTML.
- `types.ts` defines the request handler, Vite options, adapter, and build context contracts.
- `vite.ts` provides virtual browser/server entries, Vite development middleware, build targets,
  hydration readiness, and adapter handoff.
- `cli.ts` runs the paired Vite client and SSR production builds on Bun or Node.js.
- `adapter-utils.ts` validates adapter output paths and writes launchers.
- `adapters/bun.ts` emits the Bun static-file and Fetch-handler host.
- `adapters/node.ts` emits the Node.js HTTP/static-file host and bridges Web responses.

All public configuration and request boundaries validate their inputs before rendering or writing.
