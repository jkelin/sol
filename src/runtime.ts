export interface Signal<T> {
  value: T;
}

export interface ReadonlySignal<T> {
  readonly value: T;
}

export type Component<Props extends object = Record<string, never>> = (
  props: Readonly<Props>,
) => JSX.Element;

type Cleanup = () => void;
type Dependency = Set<ReactiveEffect>;

interface ReactiveEffect {
  active: boolean;
  computed: boolean;
  running: boolean;
  dependencies: Set<Dependency>;
  run: () => void;
}

const ITERATE = Symbol("frontend-framework.iterate");
const SIGNAL = Symbol("frontend-framework.signal");
const COMPONENT = Symbol("frontend-framework.component");
const dependencies = new WeakMap<object, Map<PropertyKey, Dependency>>();
const proxyCache = new WeakMap<object, object>();
const proxyTargets = new WeakMap<object, object>();
const mutatingArrayMethods = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
let activeEffect: ReactiveEffect | undefined;
let activeOwner: Cleanup[] | undefined;
let batchDepth = 0;
let flushingEffects = false;
const pendingEffects = new Set<ReactiveEffect>();

function cleanupEffect(effect: ReactiveEffect): void {
  for (const dependency of effect.dependencies) dependency.delete(effect);
  effect.dependencies.clear();
}

function track(target: object, key: PropertyKey): void {
  if (!activeEffect?.active) return;
  let targetDependencies = dependencies.get(target);
  if (!targetDependencies) {
    targetDependencies = new Map();
    dependencies.set(target, targetDependencies);
  }
  let dependency = targetDependencies.get(key);
  if (!dependency) {
    dependency = new Set();
    targetDependencies.set(key, dependency);
  }
  dependency.add(activeEffect);
  activeEffect.dependencies.add(dependency);
}

function flushEffects(): void {
  if (flushingEffects) return;
  flushingEffects = true;
  let failed = false;
  let failure: unknown;
  try {
    while (pendingEffects.size > 0) {
      let effect: ReactiveEffect | undefined;
      for (const candidate of pendingEffects) {
        effect ??= candidate;
        if (candidate.computed) {
          effect = candidate;
          break;
        }
      }
      if (!effect) break;
      pendingEffects.delete(effect);
      try {
        effect.run();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  } finally {
    flushingEffects = false;
  }
  if (failed) throw failure;
}

function trigger(target: object, key: PropertyKey): void {
  const targetDependencies = dependencies.get(target);
  if (!targetDependencies) return;
  const effects = new Set<ReactiveEffect>();
  for (const effect of targetDependencies.get(key) ?? []) effects.add(effect);
  for (const effect of effects) {
    if (effect.active && !effect.running) pendingEffects.add(effect);
  }
  if (batchDepth === 0 && !flushingEffects) flushEffects();
}

export function batch<T>(callback: () => T): T {
  batchDepth += 1;
  let result: T | undefined;
  let callbackFailed = false;
  let callbackFailure: unknown;
  try {
    result = callback();
  } catch (error) {
    callbackFailed = true;
    callbackFailure = error;
  } finally {
    batchDepth -= 1;
  }
  let flushFailed = false;
  let flushFailure: unknown;
  if (batchDepth === 0) {
    try {
      flushEffects();
    } catch (error) {
      flushFailed = true;
      flushFailure = error;
    }
  }
  if (callbackFailed && flushFailed) {
    throw new AggregateError([callbackFailure, flushFailure], "Batch callback and reactive flush failed");
  }
  if (callbackFailed) throw callbackFailure;
  if (flushFailed) throw flushFailure;
  return result as T;
}

function createReactiveEffect(callback: () => void, computed: boolean): Cleanup {
  const effect: ReactiveEffect = {
    active: true,
    computed,
    running: false,
    dependencies: new Set(),
    run() {
      if (!effect.active || effect.running) return;
      cleanupEffect(effect);
      const previousEffect = activeEffect;
      activeEffect = effect;
      effect.running = true;
      try {
        callback();
      } finally {
        effect.running = false;
        activeEffect = previousEffect;
      }
    },
  };
  const stop = () => {
    if (!effect.active) return;
    effect.active = false;
    pendingEffects.delete(effect);
    cleanupEffect(effect);
  };
  const owner = activeOwner;
  owner?.push(stop);
  try {
    effect.run();
  } catch (error) {
    stop();
    if (owner) {
      const index = owner.lastIndexOf(stop);
      if (index >= 0) owner.splice(index, 1);
    }
    throw error;
  }
  return stop;
}

export function runtimeEffect(callback: () => void): Cleanup {
  return createReactiveEffect(callback, false);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isReactiveTarget(value: object): boolean {
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function unwrap<T>(value: T): T {
  if (!isObject(value)) return value;
  return (proxyTargets.get(value) ?? value) as T;
}

function reactive<T extends object>(target: T): T {
  if (proxyTargets.has(target)) return target;
  const cached = proxyCache.get(target);
  if (cached) return cached as T;

  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      if (Array.isArray(object) && typeof key === "string" && mutatingArrayMethods.has(key)) {
        return (...args: unknown[]) => batch(() => {
          const method = Reflect.get(object, key, receiver) as (...values: unknown[]) => unknown;
          return method.apply(receiver, args);
        });
      }
      track(object, key);
      const value = Reflect.get(object, key, receiver) as unknown;
      return wrap(value);
    },
    set(object, key, value, receiver) {
      const wasPresent = Object.prototype.hasOwnProperty.call(object, key);
      const oldValue = unwrap(Reflect.get(object, key, receiver) as unknown);
      const nextValue = unwrap(value);
      const oldLength = Array.isArray(object) ? object.length : 0;
      const changed = Reflect.set(object, key, nextValue, receiver);
      if (changed && !Object.is(oldValue, nextValue)) {
        trigger(object, key);
        if (!wasPresent) trigger(object, ITERATE);
        if (Array.isArray(object) && key !== "length" && object.length !== oldLength) {
          trigger(object, "length");
        }
      }
      return changed;
    },
    deleteProperty(object, key) {
      const wasPresent = Object.prototype.hasOwnProperty.call(object, key);
      const deleted = Reflect.deleteProperty(object, key);
      if (deleted && wasPresent) {
        trigger(object, key);
        trigger(object, ITERATE);
      }
      return deleted;
    },
    ownKeys(object) {
      track(object, ITERATE);
      return Reflect.ownKeys(object);
    },
  });
  proxyCache.set(target, proxy);
  proxyTargets.set(proxy, target);
  return proxy;
}

function wrap<T>(value: T): T {
  return isObject(value) && isReactiveTarget(value) ? (reactive(value) as T) : value;
}

export function $signal<T>(initial: T): Signal<T> {
  let value = wrap(initial);
  const reference = {
    [SIGNAL]: true,
    get value(): T {
      track(reference, "value");
      return value;
    },
    set value(next: T) {
      const currentValue = unwrap(value);
      const nextValue = unwrap(next);
      if (Object.is(currentValue, nextValue)) return;
      value = wrap(nextValue);
      trigger(reference, "value");
    },
  };
  return reference;
}

export function $computed<T>(derive: () => T): ReadonlySignal<T> {
  if (typeof derive !== "function") throw new TypeError("$computed() expects a function");
  const value = $signal<T>(undefined as T);
  createReactiveEffect(() => {
    value.value = derive();
  }, true);
  return Object.freeze({
    get value(): T {
      return value.value;
    },
  });
}

export function $component<Props extends object>(
  _setup: (props: Readonly<Props>) => JSX.Element,
): Component<Props> {
  throw new Error(
    "$component() reached runtime. Add frontendFramework() before Vite's JSX transform.",
  );
}

export interface Region {
  start: Comment;
  end: Comment;
}

export interface View {
  fragment: DocumentFragment;
  elements: Element[];
  regions: Region[];
}

export interface Block {
  readonly nodes: Node[];
  mount(parent: Node, before?: Node | null): void;
  move(parent: Node, before?: Node | null): void;
  dispose(): void;
}

export interface TemplateDefinition {
  readonly html: string;
  element?: HTMLTemplateElement;
}

type ComponentFactory<Props extends object> = (props: Readonly<Props>) => Block;
type CompiledComponent<Props extends object> = Component<Props> & {
  [COMPONENT]: ComponentFactory<Props>;
};

export function template(html: string): TemplateDefinition {
  return { html };
}

export function instantiate(definition: TemplateDefinition): View {
  if (typeof document === "undefined") {
    throw new Error("frontend-framework can only instantiate templates in a browser DOM");
  }
  definition.element ??= document.createElement("template");
  if (!definition.element.innerHTML) definition.element.innerHTML = definition.html;
  const fragment = definition.element.content.cloneNode(true) as DocumentFragment;
  const elements: Element[] = [];
  for (const element of fragment.querySelectorAll<HTMLElement>("[data-ff-e]")) {
    const index = Number(element.dataset.ffE);
    if (!Number.isInteger(index)) throw new Error("Invalid compiled element marker");
    elements[index] = element;
    element.removeAttribute("data-ff-e");
  }

  const starts = new Map<number, Comment>();
  const ends = new Map<number, Comment>();
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) {
    const comment = walker.currentNode as Comment;
    const match = /^ff:(s|e):(\d+)$/.exec(comment.data);
    if (!match) continue;
    const index = Number(match[2]);
    if (match[1] === "s") starts.set(index, comment);
    else ends.set(index, comment);
  }
  const regions: Region[] = [];
  for (const [index, start] of starts) {
    const end = ends.get(index);
    if (!end) throw new Error(`Missing compiled region end marker ${index}`);
    regions[index] = { start, end };
  }
  return { fragment, elements, regions };
}

export function block(fragment: DocumentFragment, cleanups: Cleanup[] = []): Block {
  const nodes = [...fragment.childNodes];
  let disposed = false;
  const move = (parent: Node, before: Node | null = null): void => {
    const moving = document.createDocumentFragment();
    for (const node of nodes) moving.append(node);
    parent.insertBefore(moving, before);
  };
  return {
    nodes,
    mount: move,
    move,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
      for (const node of nodes) node.parentNode?.removeChild(node);
    },
  };
}

export function emptyBlock(): Block {
  return block(document.createDocumentFragment());
}

export function valueBlock(getValue: () => unknown): Block {
  const fragment = document.createDocumentFragment();
  const textNode = document.createTextNode("");
  fragment.append(textNode);
  const cleanup = runtimeEffect(() => {
    textNode.data = displayValue(getValue());
  });
  return block(fragment, [cleanup]);
}

export function component<Props extends object>(factory: ComponentFactory<Props>): Component<Props> {
  const compiled = (() => {
    throw new Error("Compiled components cannot be called directly; pass them to mount() or render them in JSX");
  }) as unknown as CompiledComponent<Props>;
  const ownedFactory: ComponentFactory<Props> = (props) => {
    const owner: Cleanup[] = [];
    const previousOwner = activeOwner;
    activeOwner = owner;
    let rendered: Block;
    try {
      rendered = factory(props);
    } catch (error) {
      for (const cleanup of owner.reverse()) cleanup();
      throw error;
    } finally {
      activeOwner = previousOwner;
    }
    let disposed = false;
    return {
      nodes: rendered.nodes,
      mount: (parent, before) => rendered.mount(parent, before),
      move: (parent, before) => rendered.move(parent, before),
      dispose() {
        if (disposed) return;
        disposed = true;
        rendered.dispose();
        for (const cleanup of owner.reverse()) cleanup();
      },
    };
  };
  Object.defineProperty(compiled, COMPONENT, { value: ownedFactory });
  return compiled;
}

function getFactory<Props extends object>(candidate: Component<Props>): ComponentFactory<Props> {
  const factory = (candidate as CompiledComponent<Props>)[COMPONENT];
  if (!factory) {
    throw new TypeError(
      "mount() received an uncompiled component. Add frontendFramework() before Vite's JSX transform.",
    );
  }
  return factory;
}

function readonlyProps<Props extends object>(props: Props): Readonly<Props> {
  return new Proxy(props, {
    set() {
      throw new TypeError("Component props are readonly");
    },
    deleteProperty() {
      throw new TypeError("Component props are readonly");
    },
    defineProperty() {
      throw new TypeError("Component props are readonly");
    },
    setPrototypeOf() {
      throw new TypeError("Component props are readonly");
    },
    preventExtensions() {
      throw new TypeError("Component props are readonly");
    },
  });
}

export function mount<Props extends object>(
  candidate: Component<Props>,
  target: Element,
  props?: Props,
): Cleanup {
  if (!target || target.nodeType !== Node.ELEMENT_NODE) {
    throw new TypeError("mount() expects a DOM Element target");
  }
  if (props != null && !isObject(props)) throw new TypeError("mount() props must be an object");
  const factory = getFactory(candidate);
  const initialProps = readonlyProps(reactive({ ...(props ?? {}) }) as Props & object);
  const mounted = factory(initialProps);
  target.replaceChildren();
  mounted.mount(target);
  return () => mounted.dispose();
}

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
  cleanups.push(runtimeEffect(() => {
    setDomValue(element, isClass ? "class" : name, isClass
      ? normalizeClass(getValue() as ClassValue)
      : getValue());
  }));
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

export function bindValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  property: "value" | "checked",
  getValue: () => unknown,
  setValue: (value: unknown) => void,
  cleanups: Cleanup[],
): void {
  const eventName = property === "checked" || element instanceof HTMLSelectElement ? "change" : "input";
  const stopEffect = runtimeEffect(() => {
    const next = getValue();
    if (property === "checked") (element as HTMLInputElement).checked = Boolean(next);
    else if (element.value !== displayValue(next)) element.value = displayValue(next);
  });
  const listener = (): void => {
    batch(() => setValue(property === "checked" ? (element as HTMLInputElement).checked : element.value));
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
  const stop = runtimeEffect(() => {
    const nextCondition = Boolean(getCondition());
    if (nextCondition === currentCondition) return;
    currentCondition = nextCondition;
    current?.dispose();
    current = nextCondition ? consequent() : alternate();
    current.mount(region.end.parentNode!, region.end);
  });
  cleanups.push(stop, () => current?.dispose());
}

interface ListRow<T> {
  key: unknown;
  item: Signal<T>;
  index: Signal<number>;
  block: Block;
}

export function list<T>(
  region: Region,
  getItems: () => Iterable<T>,
  getKey: (item: T, index: number) => unknown,
  render: (item: Signal<T>, index: Signal<number>) => Block,
  cleanups: Cleanup[],
): void {
  let rows = new Map<unknown, ListRow<T>>();
  const stop = runtimeEffect(() => {
    const items = [...getItems()];
    const entries = items.map((item, index) => ({ item, index, key: getKey(item, index) }));
    const uniqueKeys = new Set(entries.map((entry) => entry.key));
    if (uniqueKeys.size !== entries.length) throw new Error("Keyed JSX lists require unique keys");

    const nextRows = new Map<unknown, ListRow<T>>();
    batch(() => {
      for (const entry of entries) {
        let row = rows.get(entry.key);
        if (row) {
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
      if (!nextRows.has(key)) row.block.dispose();
    }
    for (const row of nextRows.values()) {
      row.block.move(region.end.parentNode!, region.end);
    }
    rows = nextRows;
  });
  cleanups.push(stop, () => {
    for (const row of rows.values()) row.block.dispose();
    rows.clear();
  });
}

export function child<Props extends object>(
  region: Region,
  candidate: Component<Props>,
  propGetters: Record<string, () => unknown>,
  cleanups: Cleanup[],
): void {
  const state = reactive<Record<string, unknown>>({});
  for (const [name, getter] of Object.entries(propGetters)) state[name] = getter();
  const props = readonlyProps(state) as Readonly<Props>;
  const mounted = getFactory(candidate)(props);
  mounted.mount(region.end.parentNode!, region.end);
  cleanups.push(() => mounted.dispose());
  for (const [name, getter] of Object.entries(propGetters)) {
    cleanups.push(runtimeEffect(() => {
      state[name] = getter();
    }));
  }
}
import type { JSX } from "./jsx-runtime.ts";
