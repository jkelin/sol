import { isObject, runtimeEffect, untrack } from "./reactivity.ts";
import type { BlockLifecycle, Cleanup } from "./rendering.ts";
import { isServerElement, type ServerElement } from "./server-rendering.ts";

export type RefCallback<T extends Element = Element> = (element: T | null) => void;

export interface RefObject<T extends Element = Element> {
  current: T | null;
}

export type Ref<T extends Element = Element> = RefCallback<T> | RefObject<T>;

const noopCleanup: Cleanup = () => undefined;

export function createRef<T extends Element = Element>(): RefObject<T> {
  if (arguments.length !== 0) throw new TypeError("createRef() does not accept an initial value");
  return { current: null };
}

function writableCurrent(reference: object): boolean {
  let current: object | null = reference;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "current");
    if (descriptor) {
      return "value" in descriptor
        ? descriptor.writable === true
        : typeof descriptor.set === "function";
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function validateRef<T extends Element>(value: unknown): Ref<T> {
  if (typeof value === "function") return value as RefCallback<T>;
  if (!isObject(value) || Array.isArray(value) || !("current" in value)) {
    throw new TypeError("ref expects a callback or an object with a writable current property");
  }
  if (!writableCurrent(value)) {
    throw new TypeError("ref object current property must be writable");
  }
  return value as RefObject<T>;
}

function assignRef<T extends Element>(reference: Ref<T>, value: T | null): void {
  if (typeof reference === "function") reference(value);
  else reference.current = value;
}

export function ref(
  element: Element | ServerElement,
  getRef: () => unknown,
  cleanups: Cleanup[],
  lifecycle: BlockLifecycle,
): void {
  if (typeof getRef !== "function") throw new TypeError("ref expects a ref getter");
  if (isServerElement(element)) {
    validateRef(getRef());
    return;
  }
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    throw new TypeError("ref expects a DOM Element");
  }
  lifecycle.refMounts.push(() => {
    let attached: Ref | undefined;
    let stop: Cleanup = noopCleanup;
    cleanups.push(() => {
      stop();
      if (attached) assignRef(attached, null);
      attached = undefined;
    });
    stop = runtimeEffect(() => {
      const next = validateRef(getRef());
      if (next === attached) return;
      untrack(() => {
        if (attached) assignRef(attached, null);
        attached = next;
        assignRef(next, element);
      });
    });
  });
}
