import type { ClassValue } from "./runtime.ts";

export namespace JSX {
  export interface Element {
    readonly __frontendFrameworkElement: unique symbol;
  }

  export interface IntrinsicAttributes {
    key?: PropertyKey;
  }

  export interface ElementChildrenAttribute {
    children: unknown;
  }

  export type ElementType =
    | keyof IntrinsicElements
    | ((props: never) => Element | PromiseLike<Element>);

  export interface IntrinsicElementAttributes {
    $bind?: unknown;
    class?: ClassValue;
    className?: ClassValue;
    classNames?: ClassValue;
    key?: PropertyKey;
    [property: string]: unknown;
  }

  export interface IntrinsicElements {
    [elementName: string]: IntrinsicElementAttributes;
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
