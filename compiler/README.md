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

Tooling can call `compile(source, filename)` from `@sol/compiler` directly. It returns transformed code and a source map.

## Source files

- `index.ts` exposes the compiler's public interface.
- `types.ts` defines the compilation result shared by callers and the implementation.
- `ast.ts` normalizes Babel's module interop and exposes the generator and traversal helpers.
- `context.ts` defines the internal compilation context, edit, scope, and template data structures.
- `module-analysis.ts` validates bindings and classifies framework, builtin, Head, Link, and component imports.
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
- `route-path.ts` validates route templates and produces compiled matching metadata.
- `http-path.ts` validates and canonicalizes literal HTTP endpoint paths for emitted definitions and
  manifest collision checks.
- `codegen.ts` owns identifier rewriting and reusable Babel-to-code helpers.
- `jsx.ts` lowers JSX elements, Head blocks, raw-text elements, refs, portals, directives, lists, conditionals, and child expressions into templates and runtime operations.
- `setup.ts` analyzes component setup and rewrites local state, derived values, props, frame-explicit context reads, and component factories while preserving `createRef()` objects as non-reactive handles and attaching authored locations to query/mutation diagnostics.
- `html.ts` owns intrinsic-element metadata and escaping for static templates.
- `runtime-import.ts` selects referenced compiler-runtime helpers and emits one minimal import; output adds
  a target-specific endpoint import only for modules containing server declarations.
- `compile.ts` validates input, creates compilation state, and sequences analysis, declaration lowering, final validation, and emission.
- `vite.ts` discovers `.sol.ts` and `.sol.tsx` modules, provides UI-route and server-endpoint
  manifests, emits both RPC declaration kinds as `POST /api/rpc/:name`, rejects matcher collisions,
  invalidates both manifests during development, injects the opt-out development devtools entry,
  and selects client or server compilation before Vite's JSX transform.

## How it works

`compile()` accepts a client or server target; the Vite adapter chooses it from the active environment.

Compilation parses the source with Babel, then `compile.ts` passes shared state through module analysis, declaration lowering, surviving-syntax validation, and output emission. Component setup declarations are rewritten into signals or computed values, while JSX is lowered into static template HTML and narrowly scoped runtime operations. Intrinsic refs become mount-phase operations; Portal and GlobalPortal become owned remote block factories. Context-compatible `use()` calls are routed through the runtime's non-observable context registry so direct, imported, aliased, and prop-supplied contexts receive the render frame across async continuations while ordinary methods retain their authored behavior. Await expressions are wrapped in lazy, module-qualified replay sites, including promise initializers later consumed by an await and awaits in lexically resolved local helper chains. Await ancestry stops at function boundaries, and helper capture is propagated per invocation, so an awaited call is replayable even when another call to the same helper is fire-and-forget. Redundant aggregate capture is omitted when `Promise.all` inputs already own replay sites. `Await` receives its own site, and Suspense forwards its validated server timeout. Generated component factories carry component names and authored file/line metadata for development introspection. Generated templates carry deterministic signatures plus the element tags, region count, and value-sensitive element indexes needed by SSR and hydration; full operation identities remain compiler-private signature inputs. They receive the active render frame so the same compiled operations can target a cloned DOM, server strings, or hydration claims. The output phase applies edits with `magic-string`, injects only referenced runtime helpers and signed templates, removes its private mapping sentinels, and preserves authored locations in the source map. The Vite adapter adds route discovery and feeds matching TSX files through that same `compile` interface.

Compiler diagnostics are part of the module interface: keep their validation and authored source locations intact when reorganizing internals.

The compiler treats a binding-resolved `Head` import as a child-bearing builtin with no properties. Its children become an owned block mounted by the runtime into `document.head` before older managed and static content, leaving no body wrapper. Empty Head blocks emit no operation. `title`, `style`, `script`, and `textarea` use a raw-text operation instead of comment regions so mixed static and reactive content updates through `textContent`; nested JSX is rejected with an authored diagnostic.
