# Sol compiler

`@sol/compiler` transforms Sol TSX into static HTML templates and fine-grained DOM operations. Most projects use its Vite adapter:

```ts
import { sol } from "@sol/compiler/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [sol()] });
```

`sol()` injects `sol/devtools` into development HTML by default and omits it from production
builds. Pass `{ devtools: false }` to disable the development panel, or `{ devtools: true }` to
include it explicitly for another Vite command. The option boundary rejects non-boolean values.

Tooling can call `compile(source, filename, options)` from `@sol/compiler` directly. It returns
transformed code and a source map. `options.target` selects `"client"` or `"server"` endpoint
lowering. `options.routeMode` selects a metadata-only `"handle"` projection or the full `"page"`
implementation (the default). Handle projections retain the route path and matcher while omitting
the schema and route-owned stylesheet imports; bundlers can consequently remove component,
schema, and page-only dependency graphs. The Vite adapter rewrites named route-handle imports to a
dedicated metadata projection, even when an import also names ordinary exports. The ordinary side
of a mixed import retains the route module's full JavaScript, stylesheet, and side-effect semantics.
Handle-only projections contain metadata only. Bare imports and the ordinary side of mixed imports
continue to execute the original module once, preserving authored initialization without pulling
route schemas, components, stylesheets, or their transitive module effects through handle imports.
Generated lazy loaders use the full page projection, while endpoint discovery uses an endpoint-only
binding-and-initialization-effect closure that excludes route implementations and their transitive
dependencies; route handles referenced by endpoint code are projected again as metadata.

## Source files

- `index.ts` exposes the compiler's public interface.
- `types.ts` defines the compilation result shared by callers and the implementation.
- `ast.ts` normalizes Babel's module interop and exposes the generator and traversal helpers.
- `context.ts` defines the internal compilation context, edit, scope, and template data structures,
  including the constant-time template-signature index.
- `module-analysis.ts` validates every lexical binding, including nested scopes, and classifies framework helpers, declarations, builtins,
  Head, Link, refs, and components by lexical binding identity.
- `declarations.ts` validates and lowers top-level component, route, RPC, and HTTP declarations,
  selecting direct server definitions or browser stubs and pruning imports, declarators,
  assignments, effect statements, attached comments, and exported dependency closures used only
  by stripped server expressions. Declaration helpers are resolved through named, aliased, or
  namespace Sol import bindings and may be published by inline or later export declarations;
  ambiguous mixed frontend/server effects receive a diagnostic instead of being deleted.
- `compiler-validation.ts` rejects misplaced compiler calls and JSX that survives lowering.
- `output.ts` applies edits, injects runtime imports and signed templates, validates generated syntax,
  redacts stripped server ranges from client source content, and creates the final source map.
- `diagnostics.ts` creates authored code frames and preserves source-map origins while accepting the
  client-safe source content emitted by `output.ts`.
- `route-path.ts` validates route templates, rejects URL-normalized dot segments, and produces
  canonical matching metadata for compiled declarations and lazy manifests.
- `http-path.ts` validates and canonicalizes literal HTTP endpoint paths for emitted definitions and
  manifest collision checks.
- `codegen.ts` owns identifier rewriting, transparent TypeScript-expression unwrapping, and
  reusable Babel-to-code helpers.
- `jsx.ts` lowers JSX elements, Head blocks, raw-text elements, refs, portals, directives, lists,
  conditionals, and child expressions into signature-indexed interned templates and reactive or
  one-shot runtime operations.
- `setup.ts` analyzes component setup, rejects unsupported reactive destructuring and readonly
  mutations in dot or bracket syntax, and rewrites local state, derived values, props,
  frame-explicit context and route reads (including destructuring and object spreads), frame-owned
  form/query/mutation helpers, and component
  factories while preserving `createRef()` objects and immutable primitive constants as
  non-reactive values, recognizing explicit reactive helpers and extracted context methods,
  capturing awaits through transparent TypeScript expressions, and attaching authored locations to
  query/mutation diagnostics.
- `html.ts` owns intrinsic-element metadata and escaping for static templates.
- `runtime-import.ts` resolves referenced compiler-runtime identifiers from generated syntax and emits one minimal import; output adds
  a target-specific endpoint import only for modules containing server declarations.
- `compile.ts` validates input, creates compilation state, and sequences analysis, declaration lowering, final validation, and emission.
- `vite.ts` discovers `.sol.ts` and `.sol.tsx` modules, provides lazy route-file and server-endpoint
  manifests, infers literal static paths, emits both RPC declaration kinds as
  `POST /api/rpc/:name`, rejects matcher collisions, invalidates both manifests during development,
  injects the opt-out development devtools entry, and compiles metadata-only route handles
  separately from page implementations before Vite's JSX transform.

## How it works

`compile()` accepts a client or server target; the Vite adapter chooses it from the active environment.

Compilation parses the source with Babel, then `compile.ts` passes shared state through binding-aware module analysis, declaration lowering, surviving-syntax validation, and output emission. Component setup declarations are rewritten into signals or computed values, while JSX is lowered into static template HTML and narrowly scoped runtime operations. String, boolean, and numeric intrinsic attribute literals are folded into template HTML, and static templates omit cleanup and lifecycle scaffolding. Intrinsic refs become mount-phase operations; Portal and GlobalPortal become owned remote block factories. Context-compatible `use()` calls are routed through the runtime's non-observable context registry so direct, imported, aliased, and prop-supplied contexts receive the render frame across async continuations while ordinary methods retain their authored behavior. Await expressions are wrapped in lazy, module-qualified replay sites, including promise initializers later consumed by an await and awaits in lexically resolved local helper chains. Await ancestry stops at function boundaries, and helper capture is propagated per invocation, so an awaited call is replayable even when another call to the same helper is fire-and-forget. Redundant aggregate capture is omitted when `Promise.all` inputs already own replay sites. `Await` receives its own site, and Suspense forwards its validated server timeout. Generated component factories carry component names and authored file/line metadata for development introspection. Generated templates carry deterministic signatures plus the element tags, region count, and value-sensitive element indexes needed by SSR and hydration; full operation identities remain compiler-private signature inputs. They receive the active render frame so the same compiled operations can target a cloned DOM, server strings, or hydration claims. The output phase applies edits with `magic-string`, injects only referenced runtime helpers and signed templates, removes source-absent private mapping sentinels in one pass, and preserves authored locations in the source map. The Vite adapter adds route discovery and feeds matching TSX files through that same `compile` interface.

Reactive helpers and declaration macros are recognized by lexical binding identity, imported aliases
included; identical compiled templates are interned within a module. Compiler diagnostics are part
of the module interface: keep their validation and authored source locations intact when reorganizing internals.

The compiler treats a binding-resolved `Head` import as a child-bearing builtin with no properties. Its children become an owned block mounted by the runtime into `document.head` before older managed and static content, leaving no body wrapper. Empty Head blocks emit no operation. `title`, `style`, `script`, and `textarea` use a raw-text operation instead of comment regions so mixed static and reactive content updates through `textContent`; nested JSX is rejected with an authored diagnostic.
