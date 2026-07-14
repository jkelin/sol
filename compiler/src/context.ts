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
  nextElement: number;
  nextRegion: number;
  elementIds: WeakMap<t.JSXOpeningElement, number>;
}

export interface CompilerContext {
  filename: string;
  source: string;
  templates: string[];
  componentNames: Set<string>;
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
