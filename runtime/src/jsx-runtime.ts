import type { ClassValue } from "./dom.ts";
import type { Ref } from "./refs.ts";
import type { Transition } from "./transitions.ts";

export namespace JSX {
  export interface Element {
    readonly __solElement: unique symbol;
  }

  export type Child = Element | string | number | bigint | boolean | null | undefined;

  export interface IntrinsicAttributes {
    key?: PropertyKey;
  }

  export interface ElementChildrenAttribute {
    children: unknown;
  }

  export type ElementType =
    | keyof IntrinsicElements
    | ((props: never) => Element | PromiseLike<Element>);
  export interface IntrinsicElementAttributes<T extends globalThis.Element = globalThis.Element> {
    $bind?: unknown;
    $transition?: Transition;
    class?: ClassValue;
    className?: ClassValue;
    classNames?: ClassValue;
    key?: PropertyKey;
    ref?: Ref<T>;
    [property: string]: unknown;
  }

  type HTMLElementAttributes = {
    [Name in keyof HTMLElementTagNameMap]: IntrinsicElementAttributes<HTMLElementTagNameMap[Name]>;
  };
  type SVGElementAttributes = {
    [Name in Exclude<
      keyof SVGElementTagNameMap,
      keyof HTMLElementTagNameMap
    >]: IntrinsicElementAttributes<SVGElementTagNameMap[Name]>;
  };
  export type IntrinsicElements = HTMLElementAttributes &
    SVGElementAttributes & { [elementName: string]: IntrinsicElementAttributes<never> };
}

function missingCompiler(): never {
  throw new Error("JSX reached sol/jsx-runtime. Add sol() to the Vite plugins array.");
}

export const Fragment = Symbol("sol.Fragment");
export const jsx = missingCompiler;
export const jsxs = missingCompiler;
export const jsxDEV = missingCompiler;
