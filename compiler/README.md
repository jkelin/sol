# Sol compiler

`@soljs/compiler` transforms Sol TSX into static HTML templates and fine-grained DOM operations. Most projects use its Vite adapter:

```ts
import { sol } from "@soljs/compiler/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [sol()] });
```

`sol()` injects `@soljs/sol/devtools` into development HTML by default and omits it from production
builds. Pass `{ devtools: false }` to disable the development panel, or `{ devtools: true }` to
include it explicitly for another Vite command. The option boundary rejects non-boolean values.

Tooling can call `compile(source, filename, options)` from `@soljs/compiler` directly. It returns
transformed code and a source map. The filename must be a non-empty string, and options are
snapshotted from exact own enumerable data properties. `options.target` selects `"client"` or
`"server"` endpoint lowering. `options.routeMode` selects a metadata-only `"handle"` projection or
the full `"page"` implementation (the default). Handle projections retain the route path and
matcher while omitting the schema and route-owned stylesheet imports; bundlers can consequently
remove component, schema, and page-only dependency graphs. The Vite adapter resolves extensionless and aliased module
specifiers and rewrites named or default route-handle imports to a dedicated metadata projection,
even when an import also names ordinary exports. Multiple public aliases of one route share one
manifest entry and one projected handle, including declarations published with `export default
routeName` or an arbitrary string export name. Type-only exports do not publish runtime
declarations, type-only imports remain type-only, and queried or fragment-bearing imports such as
`?raw` and `?url` are left to Vite instead of being split. The ordinary side
of a mixed import retains the route module's full JavaScript, stylesheet, and side-effect semantics.
Namespace imports and direct re-exports of route modules are rejected because they cannot preserve
the lazy implementation boundary; use named imports and an explicit local export instead.
String-named route imports use the same metadata projection and re-export guard as identifier-named
routes. String-named `@soljs/sol` helper imports participate in the same binding-aware lowering as ordinary
identifier imports. Whole-declaration type-only imports from `@soljs/sol` never register compiler helpers.
Handle-only projections contain metadata only. Bare imports and the ordinary side of mixed imports
continue to execute the original module once, preserving authored initialization without pulling
route schemas, components, stylesheets, or their transitive module effects through handle imports.
Generated lazy loaders use the full page projection, while endpoint discovery uses an endpoint-only
binding-and-initialization-effect closure that excludes route implementations and their transitive
dependencies; route handles referenced by endpoint code are projected again as metadata.

`bun run build` writes one tree-shakeable ESM bundle (`dist/index.js`) and one rolled-up declaration file (`dist/index.d.ts`), then formats both files with Oxfmt. The root and Vite subpaths both resolve to those two files.

## Source files

- `index.ts` exposes the compiler's public interface.
- `compile.ts` validates and snapshots the public compilation boundary, coordinates analysis and
  lowering passes, and emits the transformed module.
- `types.ts` defines the compilation result shared by callers and the implementation.
- `ast.ts` normalizes Babel's module interop and exposes the generator and traversal helpers.
- `context.ts` defines the internal compilation context, edit, scope, and template data structures,
  including the constant-time template-signature index, value-sensitive element metadata,
  per-element dynamic-attribute ownership, and
  explicit ordinary and target-specific endpoint helper usage. AST-identity records distinguish
  compiler-instrumented request-controller calls from ordinary calls after lowering. Component-owned
  template and helper records let client projection discard generated artifacts whose server-only
  owners were pruned.
- `module-analysis.ts` validates every lexical binding, including nested scopes, and classifies framework helpers, declarations, builtins,
  Head, Link, refs, and components by lexical binding identity.
- `declarations.ts` validates and lowers top-level component, route, RPC, and HTTP declarations,
  selecting direct server definitions or browser stubs and pruning imports, declarators,
  assignments, effect statements, attached comments, and exported dependency closures used only
  by stripped server expressions. Exported compiled components remain client roots even when their
  only local reference is server-only, while ordinary exported server dependencies are still
  removed to protect the client boundary. Declaration helpers are resolved through named, aliased, or
  namespace Sol import bindings and may be published by inline or later export declarations;
  identifier default exports are supported, type-only exports are ignored, and ambiguous mixed
  frontend/server effects receive a diagnostic instead of being deleted.
- `compiler-validation.ts` rejects misplaced compiler calls and JSX that survives lowering, using
  one monotonic pass across source-ordered compiled JSX ranges.
- `output.ts` applies edits, injects runtime imports and dual-lane signed templates, omits generated
  templates and helpers with no retained owner,
  emits hydration attribute-ownership metadata, redacts stripped server ranges from client source
  content, and creates the final source map.
- `diagnostics.ts` creates authored code frames, owns source-marker insertion and canonical removal,
  and preserves source-map origins while accepting the client-safe source content emitted by
  `output.ts`.
- `route-path.ts` validates route templates, rejects URL-normalized dot segments, and produces
  canonical matching metadata for compiled declarations and lazy manifests.
- `http-path.ts` validates and canonicalizes literal HTTP endpoint paths for emitted definitions and
  manifest collision checks.
- `codegen.ts` owns identifier rewriting, transparent TypeScript-expression unwrapping, and
  reusable Babel-to-code helpers, including nested-JSX detection and validation for `arguments`,
  `new.target`, and named self-references owned by erased function boundaries.
- `jsx.ts` lowers JSX elements, Head blocks, raw-text elements, refs, portals, directives, lists,
  conditionals, and child expressions into source-marker-independent, signature-indexed interned
  templates and reactive or one-shot runtime operations. Keyed-list parameters use deterministic
  nesting-local names so equivalent sibling components share template definitions while nested
  callbacks remain distinct. Unsupported expression shapes cannot leak nested JSX past lowering;
  only dedicated conditional, list, boundary, and renderer forms accept it. Lowering also includes
  single-owner form bindings,
  ASCII-case-insensitive unique DOM attribute targets and private-marker reservation, unique
  case-sensitive component properties, truthy-presence boolean expressions, property-backed
  text-control values with controlled file inputs rejected, canonical boolean-valued enumerated
  attribute tokens, diagnostics for content-replacing and non-hydratable DOM properties,
  lower-initial camel-case SVG intrinsic names, and runtime-validated Link
  navigation options. Expression-free template attributes fold like quoted strings. Deterministic string, template, numeric, boolean, null, and bigint children
  fold directly into ordinary or parser-correct raw-text templates when safe and contain no matching closing-tag
  token; bigint radices and separators canonicalize to their decimal runtime display. Reactive and
  hazardous content retains the safe runtime path.
  Keyed-list calls accept exactly one synchronous, non-generator inline
  callback with only item and optional index identifiers; async-boundary renderers follow the same
  synchronous, non-generator restriction.
- `setup.ts` analyzes component setup, requires `let` or `const` declarations where reactive
  lowering can preserve semantics, rejects unsupported reactive destructuring in assignments and
  loop targets, readonly assignment, update, and delete mutations in dot or bracket syntax,
  mutating array or collection calls, and scope-aware global Object/Reflect mutation APIs on
  computed, derived, and prop values, and rewrites local state,
  derived values, props,
  frame-explicit context and route reads (including destructuring and object spreads), frame-owned
  form/query/mutation helpers, and component
  factories while preserving `createRef()` objects and immutable primitive constants as
  non-reactive values, including primitive literals behind transparent TypeScript assertions,
  `satisfies`, and non-null wrappers. Constant form/query/mutation controllers remain direct stable objects instead
  of receiving redundant signal wrappers, while their members remain valid binding roots. Authored
  `const` compiler-managed bindings reject direct assignment, compound assignment, updates, and loop
  target writes while retaining writable object members. Initializer free references are analyzed
  once for self, forward, and reactive classification, recognizing explicit reactive helpers and extracted context methods,
  capturing awaits through transparent TypeScript expressions with a linear reverse-call-graph
  analysis, rejecting `for await...of` loops whose iterator progress cannot be replayed during
  hydration, attaching authored locations to
  query/mutation diagnostics, and excluding provably ordinary local objects from async route-read
  instrumentation; constructor results retain the conservative frame-aware fallback because a
  constructor may return a route-backed object.
- `html.ts` owns intrinsic-element metadata and browser-compatible escaping for static templates,
  including U+0000 and lone-surrogate replacement before text or attribute emission while
  preserving valid UTF-16 pairs.
- `runtime-import.ts` formats the explicitly recorded compiler-runtime helpers as one minimal
  import without reparsing generated output, including only the target-specific endpoint helpers
  used by each module.
- `compile.ts` validates input, creates compilation state, and sequences analysis, declaration lowering, final validation, and emission.
- `vite.ts` discovers `.sol.ts` and `.sol.tsx` modules, provides lazy route-file and server-endpoint
  manifests, infers literal static paths, emits both RPC declaration kinds as
  `POST /api/rpc/:name`, rejects matcher collisions, invalidates both manifests during development,
  injects route-manifest initialization plus the opt-out development devtools entry, and compiles metadata-only route handles
  separately from page implementations before Vite's JSX transform. Every projection emits a
  source map. Route-import maps compose with compiler maps to retain authored locations and source
  content, while generated handle and endpoint projections expose only their projected source so
  lazy or server-only implementation text cannot leak into eager maps. Unchanged modules avoid
  projection-map allocation. File inspection is cached across route imports, collision checks, and
  manifests; route and endpoint manifests omit files without their respective declaration kind,
  and endpoint manifests deduplicate aliased endpoint identities. Endpoint projection precomputes
  binding dependencies and top-level statement facts once, then incrementally closes only newly
  needed bindings over the declarations and initialization effects required by server endpoints.
  It preserves declaration-level type syntax, replaces referenced same-file routes with metadata
  handles without expanding their page dependency graph, and excludes their page implementations.
  Dependencies shared by a route config and an endpoint remain in the server projection even when
  the route itself becomes a metadata handle.
  The two manifests share one cached discovery and inspection generation; repeating either manifest
  starts a fresh generation so nested additions and valid edits are visible even without a watcher.
  Route-file watcher events invalidate the active generation during development, and failed file
  inspections are evicted so corrected files can be retried.

## How it works

`compile()` accepts a client or server target; the Vite adapter chooses it from the active environment.

Compilation parses the source with Babel, then `compile.ts` passes shared state through binding-aware module analysis, declaration lowering, surviving-syntax validation, and output emission. Component setup declarations are rewritten into signals or computed values, while JSX is lowered into static template HTML and narrowly scoped runtime operations. Constant primitive children and safe boolean and numeric intrinsic literals are folded into template HTML; boolean-target expression strings remain operations so falsey values do not become presence attributes. Static templates omit cleanup and lifecycle scaffolding. Intrinsic refs become mount-phase operations; Portal and GlobalPortal become owned remote block factories. Context-compatible `use()` calls are routed through the runtime's non-observable context registry so direct, imported, aliased, and prop-supplied contexts receive the render frame across async continuations while ordinary methods retain their authored behavior. Await expressions are wrapped in lazy, module-qualified replay sites, including promise initializers later consumed by an await and awaits in lexically resolved local helper chains. Await ancestry stops at function boundaries, and helper capture is propagated per invocation, so an awaited call is replayable even when another call to the same helper is fire-and-forget. Redundant aggregate capture is omitted when `Promise.all` inputs already own replay sites. `Await` receives its own site, and Suspense forwards its validated server timeout. Generated component factories carry component names and authored file/line metadata for development introspection. Generated templates carry deterministic signatures plus the element tags, region count, value-sensitive element indexes, and dynamic-attribute names needed by SSR and exact hydration claims; full operation identities remain compiler-private signature inputs. They receive the active render frame so the same compiled operations can target a cloned DOM, server strings, or hydration claims. The output phase applies edits with `magic-string`, injects only referenced runtime helpers and signed templates, removes source-absent private mapping sentinels in one pass, and preserves authored locations in the source map. The Vite adapter adds route discovery and feeds matching TSX files through that same `compile` interface.

Reactive helpers and declaration macros are recognized by lexical binding identity, imported aliases
included; identical compiled templates are interned within a module. Compiler diagnostics are part
of the module interface: keep their validation and authored source locations intact when reorganizing internals.

The compiler treats a binding-resolved `Head` import as a child-bearing builtin with no properties. Its children become an owned block mounted by the runtime into `document.head` before older managed and static content, leaving no body wrapper. Empty Head blocks emit no operation. `title`, `style`, `script`, and uncontrolled `textarea` elements use a raw-text operation instead of comment regions so mixed static and reactive content updates through `textContent`; nested JSX is rejected with an authored diagnostic, textarea children cannot compete with `value` or `$bind`, and a select controlled by `value` or `$bind` cannot contain an option with `selected`. Static checkbox and radio type matching is ASCII-case-insensitive, matching HTML.
