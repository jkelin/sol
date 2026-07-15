# Sol runtime

The `sol` package is the browser and server runtime plus author-facing interface for Sol applications. It provides compiled components, fine-grained reactive state, document-head content, DOM refs, portals, forms, cached queries, mutations, server RPC and HTTP declarations, context, async rendering, hydration, transitions, typed routes, and the browser router.

```tsx
import { $component, mount } from "sol";

const Greeting = $component(function Greeting() {
  let name = "Sol";
  return <input $bind={name} />;
});

mount(Greeting, document.querySelector("#app")!);
```

Application code normally imports only `sol`. The JSX transform resolves `sol/jsx-runtime` automatically. `sol/compiler-runtime` is reserved for code emitted by `@sol/compiler`.

## Source files

- `index.ts` defines the small public package interface.
- `devtools-hook.ts` defines the inert runtime instrumentation seam used only when development diagnostics are installed.
- `devtools.ts` installs the development global, WebMCP tools, element picker, and isolated in-app diagnostics panel.
- `symbols.ts` owns the private brands shared by compiled components, contexts, and routes.
- `validation.ts` defines supported parser interfaces and dispatches callable, Standard Schema, synchronous, and asynchronous parsers.
- `reactivity.ts` implements signals, computed values, effects, batching, property reads, presence
  checks, and descriptor-based writes, deduplicated proxy invalidation, render ownership state,
  identity-preserving array mutator batching, shared object-or-callable promise-like detection, and
  complete reactive-flush failure reporting and primary-failure-preserving teardown.
- `forms.ts` implements form controllers, descriptor-safe value cloning, reset-boundary validation,
  validation normalization, disposal-safe submission state, and frame-explicit ownership for async
  component setup.
- `queries.ts` implements cached query controllers, mutation controllers, request deduplication,
  setup-lifetime enforcement, polling, eviction, Suspense participation, request-isolated server
  caches, hydration replay, and compiler-authored diagnostic source attachment.
- `components.ts` defines compiler-specialized component, Head, context, async-boundary, route, and
  Link handles, including integrity-safe context proxies, opaque branded-value method receivers,
  and frame-explicit direct or extracted context reads used by async compiled setup.
- `rendering.ts` implements templates, shared component-props validation, block and setup lifecycle,
  compiled component factories,
  mounting, server render preparation, render adapters, head-scoped executable script instantiation,
  and error propagation.
- `server-rendering.ts` implements the DOM-free template-string and block adapter used by SSR,
  including dynamic form-control serialization.
- `hydration-rendering.ts` validates and claims server block, element, and region markers, then
  returns claimed blocks to the normal transition and retirement lifecycle after commit.
- `ssr-session.ts` coordinates async replay entries, shared promise-like validation, template
  signatures, boundary state, and timeouts.
- `serialization.ts` encodes and decodes safe cyclic hydration-data graphs, enumerating sparse
  array entries without scanning unused indexes, rejecting lossy built-in extensions, and
  preserving descriptor guarantees and built-in Error prototypes.
- `server-functions.ts` implements named RPC clients and server definitions, deployment-based RPC
  and HTTP paths, HTTP route decoding, schema validation, JSON POST endpoint matching, JSON response
  envelopes with canonical array-index validation, and development-safe failures.
- `ssr.ts` validates and implements `renderToStringAsync()`.
- `hydrate.ts` validates hydration payloads, claims a compiled tree, and returns its disposer.
- `routes.ts` implements typed route matching, descriptor-safe parsed-value validation, URL
  generation, route handles, complete lazy metadata validation, cached lazy-route descriptors,
  promise-normalized synchronous loader failures, and frame-explicit reads and cached object views
  used after async setup resumes.
- `route-descriptors.ts` defines the lightweight static route shape and specificity ordering shared
  with build adapters without loading the rendering runtime.
- `route-base.ts` validates deployment bases and translates browser pathnames to and from logical
  application paths.
- `specificity.ts` compares matcher specificity vectors before route and HTTP dispatchers apply
  their distinct deterministic tie-breaks.
- `dom.ts` implements the fine-grained DOM operations emitted by the compiler, including owned
  document-head mounting and reactive or one-shot text rendering.
- `refs.ts` defines typed callback/object refs, `createRef()`, ref validation, and mount/cleanup assignment.
- `portals.ts` defines Portal handles and mounts owned blocks into reactive element or body targets.
- `async.ts` implements Suspense, Await, and ErrorBoundary rendering behavior.
- `transitions.ts` implements enter/leave animation discovery, cancellation, and cleanup.
- `router.ts` loads matched route-file chunks before schema resolution, connects definitions to
  browser history or static document navigation, request URLs, SSR route rendering, initial
  asynchronous route readiness, deployment-base translation, trailing-slash directory URL
  normalization, shared empty route values, request-frame reads, and hydration of the active route.
- `compiler-runtime.ts` is the narrow interface used by compiler-generated DOM operations.
- `jsx-runtime.ts` defines Sol JSX types and the missing-compiler diagnostics.
- `jsx-dev-runtime.ts` mirrors the JSX runtime entrypoint used by development transforms.
- `virtual-routes.d.ts` types the UI route and server endpoint manifests generated by the Vite adapter.

## How it works

The compiler turns JSX into signed static templates, compact element/region/value metadata, and calls through `compiler-runtime.ts`. At mount time, `rendering.ts` clones those templates, locates Sol markers, and creates owned blocks. Block mount phases attach refs before resolving portals, and remote portal blocks delegate enter, leave, and disposal to their source owner. Teardown runs every owned cleanup and structural removal before reporting callback failures while preserving the primary mount, transition, or render error. Server rendering uses template metadata directly; tag-aware binding serialization emits browser-correct initial state for inputs, textareas, and selects, including dynamic option values, escapes raw-text closing tags, renders dynamic slots in bounded passes, validates refs without attaching, and omits browser-owned portal children. Hydration attaches refs to claimed elements before mounting portal children as fresh browser DOM; after the claim commits, those blocks use the same enter/leave transitions and retirement path as freshly mounted blocks. `reactivity.ts` tracks the effects that read signals, including array truncation and key iteration, so writes schedule only dependent DOM operations and combined invalidations flush once. Blocks own their effects and child blocks, letting `dom.ts`, `async.ts`, transitions, queries, and route changes dispose the correct work. `queries.ts` keeps shared browser cache entries behind serialized JSON keys while each mounted observer owns its polling and Suspense lifecycle; SSR entries are isolated by render session, survive transient component disposal, and are discarded at the request render boundary. `router.ts` supplies route state through an internal adapter and one browser-lifetime popstate, hashchange, and link subscription while keeping route handles independent of browser globals.

The `sol/devtools` entry installs `globalThis.__sol` and a Shadow DOM panel. Compiler-emitted
component source metadata is joined into an ownership tree with runtime-owned nodes, async component
loader and request state, authored query/mutation locations, the compiled route manifest and active
router resolution, and form validation state. Its movable, resizable master-detail panel persists its
geometry in browser storage. The hooks remain no-ops when the entry is absent, so production builds omit
the panel and global by default. WebMCP registration is feature-detected and requires no polyfill.

`$form()`, `$query()`, and `$mutation()` must be created during component setup. Compiled async setup binds them to its render frame, so creation remains valid after an `await`, while retained closures reject creation after setup settles. Queries default to an automatic initial fetch, zero milliseconds of freshness, five minutes of unused browser-cache retention, and initial-only Suspense participation. Polling is visible-document and mounted-observer only. Same-key calls deduplicate while in flight; manual refetch and mutation methods accept a call-options object before their inferred argument tuple and reject on failure. Owner disposal invalidates pending form validation and prevents a late submit from publishing or invoking its handler.

Compiler-managed `$rpcQuery()` and `$rpcMutation()` declarations attach stable names to request
diagnostics. On the server they validate the full argument tuple before directly invoking the async
handler. Browser declarations POST JSON argument tuples to `/api/rpc/:name`, decode JSON response
envelopes, and reject with reconstructed server errors. RPC arguments and results must be
JSON-serializable. `$httpRoute()` validates decoded path parameters, repeated query values, headers,
and automatic JSON/text or explicit byte bodies before passing the still-readable original `Request`
to a handler. Endpoint bodies are capped at 1 MiB by default; Solkit's `maxBodyBytes` option changes
the limit and oversized requests receive a structured 413 response. Static HTTP path segments are
canonicalized to URL pathname encoding, while query, fragment, backslash, control, and dot-segment
syntax is rejected.

Public interfaces validate inputs before mutating runtime state. Keep that validation intact when moving implementation details between modules.

## SSR and hydration

`renderToStringAsync(component, props?, { timeoutMs?, onHead?, url? })` returns component markup plus one escaped
`application/json` hydration payload. The default timeout is 5,000ms. Each `Suspense` may provide a
server-only `timeoutMs` override; a timeout renders its fallback, while root async timeouts reject.
When a render contains `Head`, `onHead` is required and receives the separately serialized managed
head markup after async work settles. Insert it into the response document's `<head>` before the body
markup. Its private ownership markers let hydration claim the head and body trees together.
An absolute HTTP(S) `url` resolves the request route before root rendering, making compiled routes
and route handles request-aware without a browser global, including in shell and Head content.
Query caches are isolated by that request URL, and initial query promises use the same async
payload as compiled awaits so the browser claims resolved server data without refetching. An initial
query with Suspense disabled claims its server loading branch first, then applies replayed data after
hydration commits.

`hydrate(component, target, props?)` returns a promise for an idempotent disposer. It requires the
exact server output in `target`, replays settled compiler-owned awaits without invoking their thunks,
validates the exact payload and async-entry shapes plus template order against the signed DOM markers
before activating operations, and preserves the existing DOM on signature, marker, property, payload,
or module-qualified async-order mismatches. Claim mismatches bypass application `Await`, `Suspense`,
and `ErrorBoundary` renderers so hydration always rejects instead of converting them into UI errors.
Compiler-owned replay sites include promise initializers later consumed by an await and the individual
helper awaits that make up supported `Promise.all` aggregates.
Timed-out entries execute in the browser after the fallback is claimed.
SSR associates replay entries with their nearest Suspense boundary; once that boundary times out,
its pending entries remain uncaptured even if the server-side promises settle before another boundary
allows the final HTML response to complete. A timed-out owner also retires its pending descendant
boundary timers, marking those descendants uncaptured without rendering hidden fallbacks.

`routerReady` resolves after the browser's initial asynchronous route schema settles. Solkit awaits
it automatically; custom hydration entries should await it before `hydrate()` when asynchronous
route schemas can affect shell, Head, or route output.
Solkit also calls `configureRouterBase(import.meta.env.BASE_URL)` before hydration. Custom Vite
entries deployed below `/` can do the same; router state remains expressed in logical application
paths while browser history retains the configured base. Browser locations outside that base remain
unmatched rather than being interpreted as logical application paths.

`configureRouterNavigation(mode)` selects the browser navigation strategy. Its
`RouterNavigationMode` argument is either `"history"` (the default), which updates browser history
and loads the destination route chunk without a document request, or `"document"`, which leaves
links and imperative navigation to full-page requests. Solkit configures `"document"` for static
applications and `"history"` for server-driven applications. This setting is browser-global and
must be configured before application navigation begins.

The graph serializer preserves `undefined`, sparse arrays, special numbers, bigint, Date, RegExp,
URL, Map, Set, Error, cycles, aliases, and plain or null-prototype objects. It rejects executable or
host-specific values and plain-object properties with non-default descriptors, and the embedded JSON
escapes script-closing characters.

## Document head

`Head` accepts JSX children such as `title`, `meta`, `link`, `style`, and `script`, then mounts them directly into `document.head`. Managed blocks precede static head content so their titles take effect, and newer blocks precede older blocks. Each instance owns and cleans up only its nodes without deduplicating overlaps. Reactive title, style, script, and textarea text is assigned through `textContent`. SSR serializes managed blocks through `onHead`; hydration claims those exact elements, including scripts, and removes only their private compiler markers. The render frame marks client-only Head descendants so only their template scripts are recreated as executable elements; scripts elsewhere retain ordinary inert template-clone behavior. Scripts execute when inserted according to native browser behavior, while later text updates do not rerun an already-connected or hydrated script.
