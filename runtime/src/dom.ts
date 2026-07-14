import type { Component, Context } from "./components.ts";
import { $signal, batch, isObject, reactive, runtimeEffect, type Signal } from "./reactivity.ts";
import {
  getFactory,
  readonlyProps,
  resolvedBlock,
  rootFrame,
  routeRuntime,
  type Block,
  type Cleanup,
  type Region,
  type RenderFrame,
} from "./rendering.ts";
import { routeHref, type RouteDefinition, type RouteValues } from "./routes.ts";
import { CONTEXT, ROUTE } from "./symbols.ts";

type ContextRecord = Context<object> & { readonly [CONTEXT]: symbol };
type RenderFactory = (frame: RenderFrame) => Block;

function displayValue(value: unknown): string {
  return value == null || typeof value === "boolean" ? "" : String(value);
}

export type ClassValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ClassValue[]
  | { readonly [className: string]: unknown };

export function normalizeClass(value: ClassValue): string {
  const classes: string[] = [];
  const append = (part: ClassValue): void => {
    if (!part) return;
    if (typeof part === "string" || typeof part === "number") {
      classes.push(String(part));
      return;
    }
    if (Array.isArray(part)) {
      for (const item of part) append(item);
      return;
    }
    if (typeof part === "object") {
      for (const className of Object.keys(part)) {
        if (part[className]) classes.push(className);
      }
    }
  };
  append(value);
  return classes.join(" ");
}

export function text(region: Region, getValue: () => unknown, cleanups: Cleanup[]): void {
  const textNode = document.createTextNode("");
  region.end.parentNode?.insertBefore(textNode, region.end);
  cleanups.push(
    runtimeEffect(() => {
      textNode.data = displayValue(getValue());
    }),
  );
}

function setDomValue(element: Element, name: string, value: unknown): void {
  const property = name === "className" ? "className" : name === "htmlFor" ? "htmlFor" : name;
  if (name.startsWith("aria-") || name.startsWith("data-")) {
    if (value == null) element.removeAttribute(name);
    else element.setAttribute(name, String(value));
    return;
  }
  if (property in element) {
    (element as unknown as Record<string, unknown>)[property] = value == null ? "" : value;
  } else if (value == null || value === false) {
    element.removeAttribute(name);
  } else {
    element.setAttribute(name, value === true ? "" : String(value));
  }
}

export function attribute(
  element: Element,
  name: string,
  getValue: () => unknown,
  cleanups: Cleanup[],
): void {
  const isClass = name === "class" || name === "className" || name === "classNames";
  cleanups.push(
    runtimeEffect(() => {
      setDomValue(
        element,
        isClass ? "class" : name,
        isClass ? normalizeClass(getValue() as ClassValue) : getValue(),
      );
    }),
  );
}

export function event(
  element: Element,
  name: string,
  getHandler: () => unknown,
  cleanups: Cleanup[],
): void {
  const listener = (domEvent: Event): void => {
    const handler = getHandler();
    if (typeof handler !== "function") return;
    batch(() => handler(domEvent));
  };
  element.addEventListener(name, listener);
  cleanups.push(() => element.removeEventListener(name, listener));
}

export function link<Path extends string, Values extends RouteValues>(
  element: HTMLAnchorElement,
  getRoute: () => RouteDefinition<Path, Values>,
  getDestination: () => Readonly<Record<string, unknown>>,
  getReplace: () => boolean,
  cleanups: Cleanup[],
): void {
  if (!element || element.nodeType !== Node.ELEMENT_NODE || element.tagName !== "A") {
    throw new TypeError("Link must decorate an anchor element");
  }
  const href = (): string => {
    const definition = getRoute();
    if (
      !definition ||
      typeof definition !== "object" ||
      !(definition as unknown as { [ROUTE]?: unknown })[ROUTE]
    ) {
      throw new TypeError("Link route must be a route definition");
    }
    return routeHref(definition, getDestination());
  };
  cleanups.push(
    runtimeEffect(() => element.setAttribute("href", href())),
    (() => {
      const listener = (domEvent: MouseEvent): void => {
        if (
          domEvent.defaultPrevented ||
          domEvent.button !== 0 ||
          domEvent.metaKey ||
          domEvent.ctrlKey ||
          domEvent.shiftKey ||
          domEvent.altKey ||
          element.hasAttribute("download")
        )
          return;
        const target = element.getAttribute("target");
        if (target && target.toLowerCase() !== "_self") return;
        if (!routeRuntime) throw new Error("Route runtime is not initialized");
        const replace = getReplace();
        if (typeof replace !== "boolean") throw new TypeError("Link replace must be a boolean");
        domEvent.preventDefault();
        routeRuntime.navigate(href(), { replace });
      };
      element.addEventListener("click", listener);
      return () => element.removeEventListener("click", listener);
    })(),
  );
}

export function bindValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  property: "value" | "checked",
  getValue: () => unknown,
  setValue: (value: unknown) => void,
  cleanups: Cleanup[],
): void {
  const eventName =
    property === "checked" || element instanceof HTMLSelectElement ? "change" : "input";
  const stopEffect = runtimeEffect(() => {
    const next = getValue();
    if (property === "checked") (element as HTMLInputElement).checked = Boolean(next);
    else if (element.value !== displayValue(next)) element.value = displayValue(next);
  });
  const listener = (): void => {
    batch(() =>
      setValue(property === "checked" ? (element as HTMLInputElement).checked : element.value),
    );
  };
  element.addEventListener(eventName, listener);
  cleanups.push(stopEffect, () => element.removeEventListener(eventName, listener));
}

export function when(
  region: Region,
  getCondition: () => unknown,
  consequent: () => Block,
  alternate: () => Block,
  cleanups: Cleanup[],
): void {
  let current: Block | undefined;
  let currentCondition: boolean | undefined;
  let initialized = false;
  const leaving = new Map<boolean, Block>();
  const stop = runtimeEffect(() => {
    const nextCondition = Boolean(getCondition());
    if (nextCondition === currentCondition) return;
    const previousCondition = currentCondition;
    currentCondition = nextCondition;
    if (current && previousCondition !== undefined) {
      const previous = current;
      const finished = previous.leave();
      if (finished) {
        leaving.set(previousCondition, previous);
        void finished.then(() => {
          if (leaving.get(previousCondition) !== previous) return;
          leaving.delete(previousCondition);
          previous.dispose();
        });
      } else {
        previous.dispose();
      }
    }
    current = leaving.get(nextCondition);
    if (current) {
      leaving.delete(nextCondition);
      current.move(region.end.parentNode!, region.end);
      current.enter();
    } else {
      current = nextCondition ? consequent() : alternate();
      current.mount(region.end.parentNode!, region.end);
      if (initialized) current.enter();
    }
    initialized = true;
  });
  cleanups.push(stop, () => {
    current?.dispose();
    for (const leavingBlock of leaving.values()) leavingBlock.dispose();
    leaving.clear();
  });
}

interface ListRow<T> {
  key: unknown;
  item: Signal<T>;
  index: Signal<number>;
  block: Block;
}

function sameKey(left: unknown, right: unknown): boolean {
  return (
    left === right ||
    (typeof left === "number" &&
      typeof right === "number" &&
      Number.isNaN(left) &&
      Number.isNaN(right))
  );
}

export function list<T>(
  region: Region,
  getItems: () => Iterable<T>,
  getKey: (item: T, index: number) => unknown,
  render: (item: Signal<T>, index: Signal<number>) => Block,
  cleanups: Cleanup[],
): void {
  let rows = new Map<unknown, ListRow<T>>();
  const leavingRows = new Map<unknown, ListRow<T>>();
  let order: unknown[] = [];
  let initialized = false;
  const stop = runtimeEffect(() => {
    const items = [...getItems()];
    const entries = items.map((item, index) => ({ item, index, key: getKey(item, index) }));
    const uniqueKeys = new Set(entries.map((entry) => entry.key));
    if (uniqueKeys.size !== entries.length) throw new Error("Keyed JSX lists require unique keys");

    const nextRows = new Map<unknown, ListRow<T>>();
    const entering = new Set<unknown>();
    batch(() => {
      for (const entry of entries) {
        let row = rows.get(entry.key) ?? leavingRows.get(entry.key);
        if (row) {
          if (leavingRows.get(entry.key) === row) {
            leavingRows.delete(entry.key);
            entering.add(entry.key);
          }
          row.item.value = entry.item;
          row.index.value = entry.index;
        } else {
          const item = $signal(entry.item);
          const index = $signal(entry.index);
          row = { key: entry.key, item, index, block: render(item, index) };
        }
        nextRows.set(entry.key, row);
      }
    });
    for (const [key, row] of rows) {
      if (nextRows.has(key)) continue;
      const finished = row.block.leave();
      if (!finished) {
        row.block.dispose();
        order = order.filter((candidate) => !sameKey(candidate, key));
        continue;
      }
      leavingRows.set(key, row);
      void finished.then(() => {
        if (leavingRows.get(key) !== row) return;
        leavingRows.delete(key);
        order = order.filter((candidate) => !sameKey(candidate, key));
        row.block.dispose();
      });
    }

    const activeKeys = [...nextRows.keys()];
    let activeIndex = 0;
    order = order.flatMap((key) => {
      if (leavingRows.has(key)) return [key];
      if (activeIndex >= activeKeys.length) return [];
      const activeKey = activeKeys[activeIndex];
      activeIndex += 1;
      return [activeKey];
    });
    order.push(...activeKeys.slice(activeIndex));

    for (const key of order) {
      const row = nextRows.get(key) ?? leavingRows.get(key);
      row?.block.mount(region.end.parentNode!, region.end);
    }
    if (initialized) {
      for (const key of entering) nextRows.get(key)!.block.enter();
      for (const [key, row] of nextRows) {
        if (!rows.has(key) && !entering.has(key)) row.block.enter();
      }
    }
    rows = nextRows;
    initialized = true;
  });
  cleanups.push(stop, () => {
    for (const row of rows.values()) row.block.dispose();
    for (const row of leavingRows.values()) row.block.dispose();
    rows.clear();
    leavingRows.clear();
    order = [];
  });
}

export function child<Props extends object>(
  region: Region,
  candidate: Component<Props>,
  propGetters: Record<string, () => unknown>,
  cleanups: Cleanup[],
  frame: RenderFrame = rootFrame(),
): void {
  const state = reactive<Record<string, unknown>>({});
  for (const [name, getter] of Object.entries(propGetters)) state[name] = getter();
  const props = readonlyProps(state) as Readonly<Props>;
  const mounted = resolvedBlock(getFactory(candidate)(props, frame), frame);
  mounted.mount(region.end.parentNode!, region.end);
  cleanups.push(() => mounted.dispose());
  for (const [name, getter] of Object.entries(propGetters)) {
    cleanups.push(
      runtimeEffect(() => {
        state[name] = getter();
      }),
    );
  }
}

function contextKey(context: Context<object>): symbol {
  const key = (context as ContextRecord)[CONTEXT];
  if (typeof key !== "symbol") throw new TypeError("Invalid context Provider handle");
  return key;
}

export function contextProvider(
  region: Region,
  context: Context<object>,
  getData: () => unknown,
  render: RenderFactory,
  cleanups: Cleanup[],
  frame: RenderFrame,
): void {
  const key = contextKey(context);
  const readData = (): object => {
    const data = getData();
    if (!isObject(data) || Array.isArray(data)) {
      throw new TypeError("Context Provider data must be an object");
    }
    return data;
  };
  readData();
  const contexts = new Map(frame.contexts);
  contexts.set(key, readData);
  const childFrame: RenderFrame = { ...frame, contexts };
  const rendered = render(childFrame);
  rendered.mount(region.end.parentNode!, region.end);
  cleanups.push(() => rendered.dispose());
}
