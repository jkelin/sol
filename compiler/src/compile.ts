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

function snapshotCompileOptions(options: CompileOptions): CompileOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("compile() options must be an object");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("compile() options must be a plain object");
  }
  const allowed = ["target", "routeMode"] as const;
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const unexpected = Reflect.ownKeys(descriptors).find(
    (key) => typeof key !== "string" || !allowed.includes(key as (typeof allowed)[number]),
  );
  if (unexpected !== undefined) {
    throw new TypeError(`compile() options contains unknown property ${String(unexpected)}`);
  }
  const snapshot: { target?: unknown; routeMode?: unknown } = {};
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`compile() options ${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot as CompileOptions;
}

export function compile(
  source: string,
  filename = "component.tsx",
  options: CompileOptions = {},
): CompileResult {
  if (typeof source !== "string") throw new TypeError("compile() expects source code as a string");
  if (typeof filename !== "string" || filename.length === 0) {
    throw new TypeError("compile() filename must be a non-empty string");
  }
  const compileOptions = snapshotCompileOptions(options);
  if (
    compileOptions.target !== undefined &&
    compileOptions.target !== "client" &&
    compileOptions.target !== "server"
  ) {
    throw new TypeError('compile() target must be "client" or "server"');
  }
  if (
    compileOptions.routeMode !== undefined &&
    compileOptions.routeMode !== "handle" &&
    compileOptions.routeMode !== "page"
  ) {
    throw new TypeError('compile() routeMode must be "handle" or "page"');
  }
  let mappingMarkerPrefix = "__sol_source_";
  while (source.includes(`/*${mappingMarkerPrefix}`))
    mappingMarkerPrefix = `_${mappingMarkerPrefix}`;
  const compiler: CompilerContext = {
    filename,
    source,
    templates: [],
    templateIndexes: new Map(),
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
    runtimeHelpers: new Set(),
    runtimeHelperOwners: new Map(),
    unownedRuntimeHelpers: new Set(),
    serverRuntimeHelpers: new Set(),
    templateOwners: new Map(),
    mappingMarkerPrefix,
    mappingOrigins: [],
    nextAsyncId: 0,
    target: compileOptions.target ?? "server",
    routeMode: compileOptions.routeMode ?? "page",
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
    componentArtifactStatements: new Map(),
    removedArtifactOwners: new Set(),
  };

  analyzeModule(state);
  compileComponentDeclarations(state);
  compileRouteDeclarations(state);
  compileServerDeclarations(state);
  if (!validateCompiledModule(state)) return { code: source, map: null };
  return emitCompilation(state);
}
