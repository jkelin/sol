export interface Signal<T> {
  value: T;
}

export interface ReadonlySignal<T> {
  readonly value: T;
}

export type FormValidationStrategy = "onSubmit" | "onBlur" | "onInput";

export type FormParser<TValues extends Record<string, unknown>, TOutput> =
  | ((values: TValues) => TOutput | PromiseLike<TOutput>)
  | { parse(values: TValues): TOutput; parseAsync?: never }
  | { parseAsync(values: TValues): PromiseLike<TOutput>; parse?: (values: TValues) => TOutput };

export interface FormConfig<TValues extends Record<string, unknown>, TOutput> {
  schema: FormParser<TValues, TOutput>;
  defaultValues: TValues;
  validationStrategy?: FormValidationStrategy;
}

export type FormErrors = Readonly<Record<string, readonly string[] | undefined>>;

export interface FormController<TValues extends Record<string, unknown>> {
  readonly values: TValues;
  readonly errors: FormErrors;
  readonly formErrors: readonly string[];
  readonly isSubmitting: boolean;
  submit(this: void, event?: SubmitEvent): Promise<boolean>;
  handleInput(this: void, event: Event): Promise<void>;
  handleBlur(this: void, event: FocusEvent): Promise<void>;
  reset(this: void, values?: TValues): void;
  clearErrors(this: void, field?: string): void;
}

export type Component<Props extends object = Record<string, never>> = (
  props: Readonly<Props>,
) => JSX.Element;

export interface NavigateOptions {
  readonly replace?: boolean;
}

export interface RouteConfig<Path extends string = string> {
  readonly path: Path & `/${string}`;
}

type RouteParameterName<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
  ? RouteParameterName<Segment> | RouteParameterName<Rest>
  : Path extends `:${infer Parameter}`
    ? Parameter
    : never;

export type RouteParams<Path extends string> = string extends Path
  ? Readonly<Record<string, string>>
  : Readonly<{ [Parameter in RouteParameterName<Path>]: string }>;

export type RouteNavigationParams<Path extends string> = {
  readonly [Parameter in keyof RouteParams<Path>]: string | number;
};

export interface CompiledRoutePattern {
  readonly pattern: string;
  readonly parameterNames: readonly string[];
  readonly specificity: readonly number[];
}

type RouteNavigateArguments<Path extends string> = keyof RouteParams<Path> extends never
  ? [options?: NavigateOptions]
  : [params: RouteNavigationParams<Path>, options?: NavigateOptions];

export interface RouteDefinition<Path extends string = string> {
  readonly config: RouteConfig<Path>;
  readonly component: Component;
  readonly compiled: CompiledRoutePattern;
  readonly params: RouteParams<Path>;
  readonly isActive: boolean;
  readonly isActivePrefix: boolean;
  navigate(...arguments_: RouteNavigateArguments<Path>): void;
}

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
const ROUTE = Symbol("frontend-framework.route");
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
    throw new AggregateError(
      [callbackFailure, flushFailure],
      "Batch callback and reactive flush failed",
    );
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
        return (...args: unknown[]) =>
          batch(() => {
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

interface ValidationIssue {
  message: string;
  path?: unknown[];
}

interface ValidationFailure {
  issues: ValidationIssue[];
}

function cloneFormValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneFormValue) as T;
  if (!isObject(value)) return value;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return value;
  const clone: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    clone[key] = cloneFormValue((value as Record<PropertyKey, unknown>)[key]);
  }
  return clone as T;
}

function validationFailure(error: unknown): ValidationFailure | undefined {
  if (!isObject(error) || !("issues" in error)) return undefined;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;
  const normalized: ValidationIssue[] = [];
  for (const issue of issues) {
    if (!isObject(issue) || typeof (issue as { message?: unknown }).message !== "string") {
      return undefined;
    }
    const path = (issue as { path?: unknown }).path;
    if (path !== undefined && !Array.isArray(path)) return undefined;
    normalized.push({ message: (issue as { message: string }).message, path });
  }
  return { issues: normalized };
}

function issueField(path: unknown[] | undefined): string | undefined {
  if (!path || path.length === 0) return undefined;
  const segments: string[] = [];
  for (const item of path) {
    const key = isObject(item) && "key" in item ? (item as { key?: unknown }).key : item;
    if (key !== undefined) segments.push(String(key));
  }
  return segments.length > 0 ? segments.join(".") : undefined;
}

function normalizeFormErrors(failure: ValidationFailure): {
  fields: Record<string, string[]>;
  form: string[];
} {
  const fields: Record<string, string[]> = {};
  const form: string[] = [];
  for (const issue of failure.issues) {
    const field = issueField(issue.path);
    if (field === undefined) form.push(issue.message);
    else (fields[field] ??= []).push(issue.message);
  }
  return { fields, form };
}

function eventField(domEvent: Event): string | undefined {
  const target = domEvent.target;
  if (!isObject(target) || !("name" in target)) return undefined;
  const name = (target as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

export function $form<TValues extends Record<string, unknown>, TOutput>(
  config: FormConfig<TValues, TOutput>,
  onSubmit: (values: TOutput) => void | PromiseLike<void>,
): FormController<TValues> {
  if (!isObject(config) || Array.isArray(config))
    throw new TypeError("$form() expects a config object");
  if (!isObject(config.defaultValues) || Array.isArray(config.defaultValues)) {
    throw new TypeError("$form() defaultValues must be an object");
  }
  if (typeof onSubmit !== "function") throw new TypeError("$form() expects a submit function");
  const schema = config.schema;
  const hasParser =
    typeof schema === "function" ||
    (isObject(schema) &&
      (typeof (schema as { parse?: unknown }).parse === "function" ||
        typeof (schema as { parseAsync?: unknown }).parseAsync === "function"));
  if (!hasParser) {
    throw new TypeError("$form() schema must be callable or expose parse() or parseAsync()");
  }
  const strategy = config.validationStrategy ?? "onSubmit";
  if (strategy !== "onSubmit" && strategy !== "onBlur" && strategy !== "onInput") {
    throw new TypeError("$form() validationStrategy must be onSubmit, onBlur, or onInput");
  }

  const defaults = cloneFormValue(config.defaultValues);
  const values = $signal(cloneFormValue(defaults));
  const errors = $signal<Record<string, string[]>>({});
  const formErrors = $signal<string[]>([]);
  const isSubmitting = $signal(false);
  let validationId = 0;

  const parse = async (): Promise<TOutput> => {
    if (typeof schema === "function") return await schema(values.value);
    if (typeof schema.parseAsync === "function") return await schema.parseAsync(values.value);
    return schema.parse(values.value);
  };

  const validate = async (): Promise<
    { valid: true; output: TOutput; current: boolean } | { valid: false }
  > => {
    const currentValidation = ++validationId;
    try {
      const output = await parse();
      if (currentValidation === validationId) {
        errors.value = {};
        formErrors.value = [];
      }
      return { valid: true, output, current: currentValidation === validationId };
    } catch (error) {
      const failure = validationFailure(error);
      if (!failure) throw error;
      if (currentValidation === validationId) {
        const normalized = normalizeFormErrors(failure);
        errors.value = normalized.fields;
        formErrors.value = normalized.form;
      }
      return { valid: false };
    }
  };

  const clearErrors = (field?: string): void => {
    if (field === undefined) {
      errors.value = {};
      formErrors.value = [];
      return;
    }
    const next = { ...errors.value };
    let changed = false;
    for (const key of Object.keys(next)) {
      if (key === field || key.startsWith(`${field}.`)) {
        delete next[key];
        changed = true;
      }
    }
    if (changed) errors.value = next;
  };

  const controller: FormController<TValues> = {
    get values() {
      return values.value;
    },
    get errors() {
      return errors.value;
    },
    get formErrors() {
      return formErrors.value;
    },
    get isSubmitting() {
      return isSubmitting.value;
    },
    async submit(domEvent?: SubmitEvent): Promise<boolean> {
      domEvent?.preventDefault();
      if (isSubmitting.value) return false;
      isSubmitting.value = true;
      try {
        const result = await validate();
        if (!result.valid || !result.current) return false;
        await onSubmit(result.output);
        return true;
      } finally {
        isSubmitting.value = false;
      }
    },
    async handleInput(domEvent: Event): Promise<void> {
      if (strategy === "onInput") await validate();
      else {
        validationId += 1;
        clearErrors(eventField(domEvent));
      }
    },
    async handleBlur(_event: FocusEvent): Promise<void> {
      if (strategy === "onBlur") await validate();
    },
    reset(nextValues?: TValues): void {
      validationId += 1;
      values.value = cloneFormValue(nextValues ?? defaults);
      clearErrors();
    },
    clearErrors,
  };
  return controller;
}

export function $component<Props extends object>(
  _setup: (props: Readonly<Props>) => JSX.Element,
): Component<Props> {
  throw new Error(
    "$component() reached runtime. Add frontendFramework() before Vite's JSX transform.",
  );
}

export function $route<const Path extends `/${string}`>(
  _config: RouteConfig<Path>,
  _candidate: Component,
): RouteDefinition<Path> {
  throw new Error(
    "$route() reached runtime. Define exported routes in a *.route.js, .jsx, .ts, or .tsx file and add frontendFramework() to Vite.",
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

type CompiledRouteDefinition<Path extends string = string> = RouteDefinition<Path> & {
  [ROUTE]: true;
};

type RouteRuntimeDefinition = Pick<RouteDefinition, "compiled" | "config">;

interface RouteRuntimeAdapter {
  getParams(definition: RouteRuntimeDefinition): Readonly<Record<string, string>>;
  getPathname(): string;
  isActive(definition: RouteRuntimeDefinition): boolean;
  navigate(path: string, options?: NavigateOptions): void;
}

let routeRuntime: RouteRuntimeAdapter | undefined;

export function configureRouteRuntime(adapter: RouteRuntimeAdapter): void {
  routeRuntime = adapter;
}

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
      for (const cleanup of cleanups.toReversed()) cleanup();
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

export function component<Props extends object>(
  factory: ComponentFactory<Props>,
): Component<Props> {
  const compiled = (() => {
    throw new Error(
      "Compiled components cannot be called directly; pass them to mount() or render them in JSX",
    );
  }) as unknown as CompiledComponent<Props>;
  const ownedFactory: ComponentFactory<Props> = (props) => {
    const owner: Cleanup[] = [];
    const previousOwner = activeOwner;
    activeOwner = owner;
    let rendered: Block;
    try {
      rendered = factory(props);
    } catch (error) {
      for (const cleanup of owner.toReversed()) cleanup();
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
        for (const cleanup of owner.toReversed()) cleanup();
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

export function renderComponent<Props extends object>(
  candidate: Component<Props>,
  props?: Props,
): Block {
  if (props != null && !isObject(props)) {
    throw new TypeError("renderComponent() props must be an object");
  }
  const initialProps = readonlyProps(reactive({ ...props }) as Props & object);
  return getFactory(candidate)(initialProps);
}

export function route<const Path extends `/${string}`>(
  config: RouteConfig<Path>,
  candidate: Component,
  compiled: CompiledRoutePattern,
): RouteDefinition<Path> {
  if (!config || typeof config !== "object" || typeof config.path !== "string") {
    throw new TypeError("Compiled route config must contain a path");
  }
  getFactory(candidate);
  if (
    !compiled ||
    typeof compiled.pattern !== "string" ||
    !Array.isArray(compiled.parameterNames) ||
    !Array.isArray(compiled.specificity)
  ) {
    throw new TypeError("Compiled route metadata is invalid");
  }
  let definition: CompiledRouteDefinition<Path>;
  const staticPrefix = config.path.split("/:", 1)[0] || "/";
  const buildPath = (params: Readonly<Record<string, string | number>>): string => {
    let path = config.path as string;
    for (const name of compiled.parameterNames) {
      if (!(name in params)) throw new TypeError(`Missing route parameter ${name}`);
      const value = params[name];
      if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeError(`Route parameter ${name} must be a string or number`);
      }
      path = path.replace(`:${name}`, encodeURIComponent(String(value)));
    }
    return path;
  };
  definition = Object.freeze({
    [ROUTE]: true,
    config: Object.freeze({ ...config }),
    component: candidate,
    compiled: Object.freeze({
      pattern: compiled.pattern,
      parameterNames: Object.freeze([...compiled.parameterNames]),
      specificity: Object.freeze([...compiled.specificity]),
    }),
    get params() {
      if (!routeRuntime) throw new Error("Route runtime is not initialized");
      return routeRuntime.getParams(definition) as RouteParams<Path>;
    },
    get isActive() {
      return routeRuntime?.isActive(definition) ?? false;
    },
    get isActivePrefix() {
      const pathname = routeRuntime?.getPathname();
      if (!pathname) return false;
      return staticPrefix === "/"
        ? compiled.parameterNames.length > 0 || pathname === "/"
        : pathname === staticPrefix || pathname.startsWith(`${staticPrefix}/`);
    },
    navigate(...arguments_: RouteNavigateArguments<Path>) {
      if (!routeRuntime) throw new Error("Route runtime is not initialized");
      const hasParams = compiled.parameterNames.length > 0;
      const candidateParams = arguments_[0];
      if (hasParams && (!candidateParams || typeof candidateParams !== "object")) {
        throw new TypeError("Route navigation params must be an object");
      }
      const params = hasParams
        ? (candidateParams as Readonly<Record<string, string | number>>)
        : {};
      const unexpected = Object.keys(params).find(
        (name) => !compiled.parameterNames.includes(name),
      );
      if (unexpected) throw new TypeError(`Unknown route parameter ${unexpected}`);
      const options = (hasParams ? arguments_[1] : arguments_[0]) as NavigateOptions | undefined;
      routeRuntime.navigate(buildPath(params), options);
    },
  }) as CompiledRouteDefinition<Path>;
  return definition;
}

export function isRouteDefinition(value: unknown): value is RouteDefinition {
  return Boolean(value && typeof value === "object" && (value as CompiledRouteDefinition)[ROUTE]);
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
  const initialProps = readonlyProps(reactive({ ...props }) as Props & object);
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
    cleanups.push(
      runtimeEffect(() => {
        state[name] = getter();
      }),
    );
  }
}
import type { JSX } from "./jsx-runtime.ts";
