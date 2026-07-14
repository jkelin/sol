import type * as t from "@babel/types";

export type Expression = t.Expression | t.JSXElement | t.JSXFragment;
export type Scope = ReadonlyMap<string, string>;

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
  nextElement: number;
  nextRegion: number;
  elementIds: WeakMap<t.JSXOpeningElement, number>;
}

export interface CompiledTemplate {
  html: string;
  elementTags: string[];
  regionCount: number;
  operations: string[];
}

export interface CompilerContext {
  filename: string;
  source: string;
  templates: CompiledTemplate[];
  componentNames: Set<string>;
  contextNames: Set<string>;
  importNames: Set<string>;
  builtinNames: Map<string, "Suspense" | "Await" | "ErrorBoundary" | "Portal" | "GlobalPortal">;
  linkNames: Set<string>;
  refCreatorNames: Set<string>;
  propsName?: string;
  mappingOrigins: Array<{ marker: string; originalOffset: number }>;
  nextListId: number;
  nextAsyncId: number;
}

export interface CompilationState {
  readonly ast: t.File;
  readonly compiler: CompilerContext;
  readonly edits: Edit[];
  readonly compiledJsxRanges: Array<{ start: number; end: number }>;
  readonly componentCallRanges: Set<string>;
  readonly routeCallRanges: Set<string>;
}

export function nextAsyncSite(compiler: CompilerContext): string {
  return `await:${compiler.filename}:${compiler.nextAsyncId++}`;
}
