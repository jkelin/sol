import { parse } from "@babel/parser";
import { compileComponentDeclarations, compileRouteDeclarations } from "./declarations.ts";
import { analyzeModule } from "./module-analysis.ts";
import { emitCompilation } from "./output.ts";
import { validateCompiledModule } from "./compiler-validation.ts";
import type { CompilationState, CompilerContext } from "./context.ts";
import type { CompileResult } from "./types.ts";

export function compile(source: string, filename = "component.tsx"): CompileResult {
  if (typeof source !== "string") throw new TypeError("compile() expects source code as a string");
  if (!filename) throw new TypeError("compile() expects a filename");
  const compiler: CompilerContext = {
    filename,
    source,
    templates: [],
    componentNames: new Set(),
    contextNames: new Set(),
    importNames: new Set(),
    builtinNames: new Map(),
    linkNames: new Set(),
    refCreatorNames: new Set(),
    mappingOrigins: [],
    nextListId: 0,
    nextAsyncId: 0,
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
  };

  analyzeModule(state);
  compileComponentDeclarations(state);
  compileRouteDeclarations(state);
  if (!validateCompiledModule(state)) return { code: source, map: null };
  return emitCompilation(state);
}
