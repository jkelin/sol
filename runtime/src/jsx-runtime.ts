import type { ClassValue } from "./dom.ts";
import type { Transition } from "./transitions.ts";

export namespace JSX {
  export interface Element {
    readonly __solixElement: unique symbol;
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
    $transition?: Transition;
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
  throw new Error("JSX reached solix/jsx-runtime. Add solix() to the Vite plugins array.");
}

export const Fragment = Symbol("solix.Fragment");
export const jsx = missingCompiler;
export const jsxs = missingCompiler;
export const jsxDEV = missingCompiler;
