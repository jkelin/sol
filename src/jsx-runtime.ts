export namespace JSX {
  export interface Element {
    readonly __frontendFrameworkElement: unique symbol;
  }

  export interface IntrinsicAttributes {
    key?: PropertyKey;
  }

  export interface IntrinsicElements {
    [elementName: string]: Record<string, unknown>;
  }
}

function missingCompiler(): never {
  throw new Error(
    "JSX reached frontend-framework/jsx-runtime. Add frontendFramework() to the Vite plugins array.",
  );
}

export const Fragment = Symbol("frontend-framework.Fragment");
export const jsx = missingCompiler;
export const jsxs = missingCompiler;
export const jsxDEV = missingCompiler;
