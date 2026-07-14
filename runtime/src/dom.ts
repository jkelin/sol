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
import {
  isServerElement,
  isServerRegion,
  mountServerBlock,
  setServerAttribute,
  serverRawValue,
  type ServerElement,
} from "./server-rendering.ts";
import { claimHydratedText, regionHydrationClaim } from "./hydration-rendering.ts";

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
  if (isServerRegion(region)) {
    const value = displayValue(getValue())
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    mountServerBlock(serverRawValue(value), region);
    return;
  }
  const claimed = claimHydratedText(region);
  const textNode = claimed ?? document.createTextNode("");
  if (!claimed) region.end.parentNode?.insertBefore(textNode, region.end);
  let hydrating = Boolean(claimed);
  cleanups.push(
    runtimeEffect(() => {
      const value = displayValue(getValue());
      if (hydrating) {
        hydrating = false;
        if (textNode.data !== value) {
          throw new Error("Solix hydration mismatch: dynamic text differs");
        }
        return;
      }
      textNode.data = value;
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

const BOOLEAN_ATTRIBUTES = new Set([
  "allowFullScreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "formNoValidate",
  "hidden",
  "inert",
  "loop",
  "multiple",
  "muted",
  "noModule",
  "noValidate",
  "open",
  "playsInline",
  "readOnly",
  "required",
  "reversed",
  "selected",
]);

function setServerValue(element: ServerElement, name: string, value: unknown): void {
  if (name.startsWith("aria-") || name.startsWith("data-")) {
    setServerAttribute(element, name, value == null ? undefined : String(value));
  } else if (BOOLEAN_ATTRIBUTES.has(name)) {
    setServerAttribute(element, name, value ? true : undefined);
  } else if (value == null || value === false) {
    setServerAttribute(element, name, undefined);
  } else {
    setServerAttribute(element, name, value === true ? "" : String(value));
  }
}

function serializedAttribute(name: string, value: unknown): string | null {
  if (name.startsWith("aria-") || name.startsWith("data-")) {
    return value == null ? null : String(value);
  }
  if (BOOLEAN_ATTRIBUTES.has(name)) return value ? "" : null;
  if (value == null || value === false) return null;
  return value === true ? "" : String(value);
}

export function attribute(
  element: Element | ServerElement,
  name: string,
  getValue: () => unknown,
  cleanups: Cleanup[],
): void {
  const isClass = name === "class" || name === "className" || name === "classNames";
  if (isServerElement(element)) {
    setServerValue(
      element,
      isClass ? "class" : name,
      isClass ? normalizeClass(getValue() as ClassValue) : getValue(),
    );
    return;
  }
  let hydrating = element.hasAttribute("data-solix-e");
  cleanups.push(
    runtimeEffect(() => {
      const property = isClass ? "class" : name;
      const value = isClass ? normalizeClass(getValue() as ClassValue) : getValue();
      if (hydrating) {
        hydrating = false;
        if (element.getAttribute(property) !== serializedAttribute(property, value)) {
          throw new Error(`Solix hydration mismatch: dynamic attribute ${property} differs`);
        }
        return;
      }
      setDomValue(element, property, value);
    }),
  );
}

export function event(
  element: Element | ServerElement,
  name: string,
  getHandler: () => unknown,
  cleanups: Cleanup[],
): void {
  if (isServerElement(element)) return;
  const listener = (domEvent: Event): void => {
    const handler = getHandler();
    if (typeof handler !== "function") return;
    batch(() => handler(domEvent));
  };
  element.addEventListener(name, listener);
  cleanups.push(() => element.removeEventListener(name, listener));
}

export function link<Path extends string, Values extends RouteValues>(
  element: HTMLAnchorElement | ServerElement,
  getRoute: () => RouteDefinition<Path, Values>,
  getDestination: () => Readonly<Record<string, unknown>>,
  getReplace: () => boolean,
  cleanups: Cleanup[],
): void {
  if (
    !isServerElement(element) &&
    (!element || element.nodeType !== Node.ELEMENT_NODE || element.tagName !== "A")
  ) {
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
  if (isServerElement(element)) {
    setServerAttribute(element, "href", href());
    return;
  }
  let hydrating = element.hasAttribute("data-solix-e");
  cleanups.push(
    runtimeEffect(() => {
      const value = href();
      if (hydrating) {
        hydrating = false;
        if (element.getAttribute("href") !== value) {
          throw new Error("Solix hydration mismatch: Link href differs");
        }
        return;
      }
      element.setAttribute("href", value);
    }),
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
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | ServerElement,
  property: "value" | "checked",
  getValue: () => unknown,
  setValue: (value: unknown) => void,
  cleanups: Cleanup[],
): void {
  if (isServerElement(element)) {
    setServerValue(element, property, property === "checked" ? Boolean(getValue()) : getValue());
    return;
  }
  const eventName =
    property === "checked" || element instanceof HTMLSelectElement ? "change" : "input";
  let hydrating = element.hasAttribute("data-solix-e");
  const stopEffect = runtimeEffect(() => {
    const next = getValue();
    const expected = property === "checked" ? Boolean(next) : displayValue(next);
    const actual = property === "checked" ? (element as HTMLInputElement).checked : element.value;
    if (hydrating) {
      hydrating = false;
      if (actual !== expected) {
        throw new Error(`Solix hydration mismatch: bound ${property} differs`);
      }
      return;
    }
    if (actual !== expected) {
      if (property === "checked") (element as HTMLInputElement).checked = expected as boolean;
      else element.value = expected as string;
    }
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
  consequent: RenderFactory,
  alternate: RenderFactory,
  cleanups: Cleanup[],
  frame: RenderFrame = rootFrame(),
): void {
  const renderFrame = frameForRegion(frame, region);
  if (isServerRegion(region)) {
    mountServerBlock((getCondition() ? consequent : alternate)(renderFrame), region);
    return;
  }
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
      current = (nextCondition ? consequent : alternate)(renderFrame);
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
  render: (item: Signal<T>, index: Signal<number>, frame: RenderFrame) => Block,
  cleanups: Cleanup[],
  frame: RenderFrame = rootFrame(),
): void {
  const renderFrame = frameForRegion(frame, region);
  if (isServerRegion(region)) {
    const keys = new Set<unknown>();
    let index = 0;
    for (const itemValue of getItems()) {
      const key = getKey(itemValue, index);
      if (keys.has(key)) throw new Error("Keyed JSX lists require unique keys");
      keys.add(key);
      const item = $signal(itemValue);
      const position = $signal(index);
      mountServerBlock(render(item, position, renderFrame), region);
      index += 1;
    }
    return;
  }
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
          row = { key: entry.key, item, index, block: render(item, index, renderFrame) };
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
  const renderFrame = frameForRegion(frame, region);
  const mounted = resolvedBlock(getFactory(candidate)(props, renderFrame), renderFrame);
  if (isServerRegion(region)) mountServerBlock(mounted, region);
  else mounted.mount(region.end.parentNode!, region.end);
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
  const rendered = render(frameForRegion(childFrame, region));
  if (isServerRegion(region)) mountServerBlock(rendered, region);
  else rendered.mount(region.end.parentNode!, region.end);
  cleanups.push(() => rendered.dispose());
}

function frameForRegion(frame: RenderFrame, region: Region): RenderFrame {
  const claim = regionHydrationClaim(region);
  return claim ? { ...frame, claim } : frame;
}
