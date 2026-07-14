# Solix compiler

`@solix/compiler` transforms Solix TSX into static HTML templates and fine-grained DOM operations. Most projects use its Vite adapter:

```ts
import { solix } from "@solix/compiler/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [solix()] });
```

Tooling can call `compile(source, filename)` from `@solix/compiler` directly. It returns transformed code and a source map.

## Source files

- `index.ts` exposes the compiler's public interface.
- `types.ts` defines the compilation result shared by callers and the implementation.
- `ast.ts` normalizes Babel's module interop and exposes the generator and traversal helpers.
- `context.ts` defines the internal compilation context, edit, scope, and template data structures.
- `module-analysis.ts` validates bindings and classifies framework, builtin, Link, and component imports.
- `declarations.ts` validates and lowers top-level component and route declarations.
- `compiler-validation.ts` rejects misplaced compiler calls and JSX that survives lowering.
- `output.ts` applies edits, injects runtime imports and signed templates, validates generated syntax, and creates the final source map.
- `diagnostics.ts` creates authored code frames and preserves source-map origins.
- `route-path.ts` validates route templates and produces compiled matching metadata.
- `codegen.ts` owns identifier rewriting and reusable Babel-to-code helpers.
- `jsx.ts` lowers JSX elements, refs, portals, directives, lists, conditionals, and child expressions into templates and runtime operations.
- `setup.ts` analyzes component setup and rewrites local state, derived values, props, frame-explicit context reads, and component factories while preserving `createRef()` objects as non-reactive handles.
- `html.ts` owns intrinsic-element metadata and escaping for static templates.
- `runtime-import.ts` defines the single generated import from `solix/compiler-runtime`.
- `compile.ts` validates input, creates compilation state, and sequences analysis, declaration lowering, final validation, and emission.
- `vite.ts` discovers routes, provides `virtual:solix/routes`, invalidates it during development, and applies the compiler before Vite's JSX transform.

## How it works

Compilation parses the source with Babel, then `compile.ts` passes shared state through module analysis, declaration lowering, surviving-syntax validation, and output emission. Component setup declarations are rewritten into signals or computed values, while JSX is lowered into static template HTML and narrowly scoped runtime operations. Intrinsic refs become mount-phase operations; Portal and GlobalPortal become owned remote block factories. Binding-aware context `use()` calls receive the render frame explicitly so provider lookup survives async continuations; imported candidates are checked against the runtime's non-observable context registry before frame injection. Await expressions are wrapped in lazy, module-qualified replay sites, including promise initializers later consumed by an await and awaits in lexically resolved local helper chains. Await ancestry stops at function boundaries, and helper capture is propagated per invocation, so an awaited call is replayable even when another call to the same helper is fire-and-forget. Redundant aggregate capture is omitted when `Promise.all` inputs already own replay sites. `Await` receives its own site, and Suspense forwards its validated server timeout. Generated templates carry deterministic signatures plus element tags, region indexes, and stable identities for each dynamic operation. They receive the active render frame so the same compiled operations can target a cloned DOM, server strings, or hydration claims. The output phase applies edits with `magic-string`, injects the generated runtime import and templates, and preserves authored locations in the source map. The Vite adapter adds route discovery and feeds matching TSX files through that same `compile` interface.

Compiler diagnostics are part of the module interface: keep their validation and authored source locations intact when reorganizing internals.
