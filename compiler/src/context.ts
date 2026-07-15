import type * as t from "@babel/types";

export type Expression = t.Expression | t.JSXElement | t.JSXFragment;
export type Scope = ReadonlyMap<string, string>;
export type BuiltinKind =
  | "Suspense"
  | "Await"
  | "ErrorBoundary"
  | "Portal"
  | "GlobalPortal"
  | "Head";

export interface Edit {
  start: number;
  end: number;
  code: string;
}

export interface CompiledFunction {
  code: string;
  returned: t.JSXElement | t.JSXFragment;
}

export interface TemplateContext {
  html: string[];
  operations: string[];
  elementTags: string[];
  propertyValueElements: Set<number>;
  nextElement: number;
  nextRegion: number;
  elementIds: WeakMap<t.JSXOpeningElement, number>;
}

export interface CompiledTemplate {
  html: string;
  elementTags: string[];
  regionCount: number;
  operations: string[];
  propertyValueElements: number[];
}

export interface CompilerContext {
  filename: string;
  source: string;
  templates: CompiledTemplate[];
  templateIndexes: Map<string, number>;
  componentNames: Set<string>;
  componentBindings: Set<t.Identifier>;
  componentElements: WeakSet<t.JSXElement>;
  componentImports: Set<t.Identifier>;
  componentCalls: WeakSet<t.CallExpression>;
  builtinImports: Map<t.Identifier, BuiltinKind>;
  builtinElements: WeakMap<t.JSXElement, BuiltinKind>;
  linkImports: Set<t.Identifier>;
  linkElements: WeakSet<t.JSXElement>;
  reactiveHelperImports: Map<t.Identifier, "signal" | "computed">;
  reactiveHelperCalls: WeakMap<t.CallExpression, "signal" | "computed">;
  refCreatorImports: Set<t.Identifier>;
  refCreatorCalls: WeakSet<t.CallExpression>;
  declarationHelperImports: Map<
    t.Identifier,
    "$route" | "$rpcQuery" | "$rpcMutation" | "$httpRoute"
  >;
  declarationHelperCalls: WeakMap<
    t.CallExpression,
    "$route" | "$rpcQuery" | "$rpcMutation" | "$httpRoute"
  >;
  declarationHelperNamespaceImports: Set<t.Identifier>;
  requestHelpers: Map<string, "$query" | "$mutation" | "$form">;
  propsName?: string;
  mappingMarkerPrefix: string;
  mappingOrigins: Array<{ marker: string; originalOffset: number }>;
  nextListId: number;
  nextAsyncId: number;
  target: "client" | "server";
  routeMode: "handle" | "page";
}

export interface CompilationState {
  readonly ast: t.File;
  readonly compiler: CompilerContext;
  readonly edits: Edit[];
  readonly compiledJsxRanges: Array<{ start: number; end: number }>;
  readonly componentCallRanges: Set<string>;
  readonly routeCallRanges: Set<string>;
  readonly serverCallRanges: Set<string>;
  readonly clientServerSourceRanges: Array<{ start: number; end: number }>;
}

export function nextAsyncSite(compiler: CompilerContext): string {
  return `await:${compiler.filename}:${compiler.nextAsyncId++}`;
}
