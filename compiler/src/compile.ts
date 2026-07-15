import { parse } from "@babel/parser";
import {
  compileComponentDeclarations,
  compileRouteDeclarations,
  compileServerDeclarations,
} from "./declarations.ts";
import { analyzeModule } from "./module-analysis.ts";
import { emitCompilation } from "./output.ts";
import { validateCompiledModule } from "./compiler-validation.ts";
import type { CompilationState, CompilerContext } from "./context.ts";
import type { CompileOptions, CompileResult } from "./types.ts";

export function compile(
  source: string,
  filename = "component.tsx",
  options: CompileOptions = {},
): CompileResult {
  if (typeof source !== "string") throw new TypeError("compile() expects source code as a string");
  if (!filename) throw new TypeError("compile() expects a filename");
  let mappingMarkerPrefix = "__sol_source_";
  while (source.includes(`/*${mappingMarkerPrefix}`))
    mappingMarkerPrefix = `_${mappingMarkerPrefix}`;
  const compiler: CompilerContext = {
    filename,
    source,
    templates: [],
    componentNames: new Set(),
    componentBindings: new Set(),
    componentElements: new WeakSet(),
    componentImports: new Set(),
    componentCalls: new WeakSet(),
    builtinImports: new Map(),
    builtinElements: new WeakMap(),
    linkImports: new Set(),
    linkElements: new WeakSet(),
    reactiveHelperImports: new Map(),
    reactiveHelperCalls: new WeakMap(),
    refCreatorImports: new Set(),
    refCreatorCalls: new WeakSet(),
    declarationHelperImports: new Map(),
    declarationHelperCalls: new WeakMap(),
    declarationHelperNamespaceImports: new Set(),
    requestHelpers: new Map(),
    mappingMarkerPrefix,
    mappingOrigins: [],
    nextListId: 0,
    nextAsyncId: 0,
    target: options.target ?? "server",
  };
  const state: CompilationState = {
    ast: parse(source, {
      sourceType: "module",
      sourceFilename: filename,
      plugins: ["typescript", "jsx"],
    }),
    compiler,
    edits: [],
    compiledJsxRanges: [],
    componentCallRanges: new Set(),
    routeCallRanges: new Set(),
    serverCallRanges: new Set(),
    clientServerSourceRanges: [],
  };

  analyzeModule(state);
  compileComponentDeclarations(state);
  compileRouteDeclarations(state);
  compileServerDeclarations(state);
  if (!validateCompiledModule(state)) return { code: source, map: null };
  return emitCompilation(state);
}
