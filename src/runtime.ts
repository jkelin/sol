export interface Signal<T> {
  value: T;
}

export interface ReadonlySignal<T> {
  readonly value: T;
}

export interface Transition {
  readonly enter?: string;
  readonly leave?: string;
}

export type FormValidationStrategy = "onSubmit" | "onBlur" | "onInput";

export interface StandardSchema<TInput, TOutput> {
  readonly "~standard": {
    readonly validate: (
      input: unknown,
    ) =>
      | { readonly value: TOutput; readonly issues?: undefined }
      | { readonly issues: readonly unknown[] }
      | PromiseLike<
          | { readonly value: TOutput; readonly issues?: undefined }
          | { readonly issues: readonly unknown[] }
        >;
    readonly types?: { readonly input: TInput; readonly output: TOutput };
  };
}

export type Parser<TInput, TOutput> =
  | ((input: TInput) => TOutput | PromiseLike<TOutput>)
  | { parse(input: TInput): TOutput; parseAsync?: never }
  | { parseAsync(input: TInput): PromiseLike<TOutput>; parse?: (input: TInput) => TOutput }
  | StandardSchema<TInput, TOutput>;

export type FormParser<TValues extends Record<string, unknown>, TOutput> = Parser<TValues, TOutput>;

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
) => JSX.Element | Promise<JSX.Element>;

export interface Context<TShape extends object> {
  readonly Provider: Component<{ data: TShape; children?: JSX.Element | readonly JSX.Element[] }>;
  use(): TShape;
  useOptional(): TShape | undefined;
}

export interface SuspenseProps {
  readonly fallback: JSX.Element;
  readonly error?: (error: unknown) => JSX.Element;
  readonly children?: JSX.Element | readonly JSX.Element[];
}

export interface AwaitProps<T> {
  readonly $promise: PromiseLike<T>;
  readonly error?: (error: unknown) => JSX.Element;
  readonly children: (data: T) => JSX.Element;
}

export interface ErrorBoundaryProps {
  readonly fallback: (error: unknown) => JSX.Element;
  readonly children?: JSX.Element | readonly JSX.Element[];
}

export interface NavigateOptions {
  readonly replace?: boolean;
}

export type RouteValue = string | number;
export type RawRouteParams = Readonly<Record<string, string>>;
export type RouteValues = Readonly<Record<string, RouteValue>>;

type RouteSchemaParameterCheck<Path extends string, Values extends RouteValues> =
  Exclude<keyof Values, keyof RouteParams<Path>> extends never
    ? Exclude<keyof RouteParams<Path>, keyof Values> extends never
      ? unknown
      : { readonly __missingRouteSchemaParameter: never }
    : { readonly __unknownRouteSchemaParameter: never };

export type RouteSchema<Path extends string, Values extends RouteValues> = Parser<
  RawRouteParams,
  Values
> &
  RouteSchemaParameterCheck<Path, Values>;

export interface RouteConfig<
  Path extends string = string,
  Values extends RouteValues = DefaultRouteValues<Path>,
> {
  readonly path: Path & `/${string}`;
  readonly schema?: RouteSchema<Path, Values>;
}

type RoutePathname<Path extends string> = Path extends `${infer Pathname}?${string}`
  ? Pathname
  : Path;
type RouteQuery<Path extends string> = Path extends `${string}?${infer Query}` ? Query : "";

type PathParameterName<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
  ? PathParameterName<Segment> | PathParameterName<Rest>
  : Path extends `:${infer Parameter}`
    ? Parameter
    : never;

type QueryParameterName<Query extends string> = Query extends `${infer Part}&${infer Rest}`
  ? QueryParameterName<Part> | QueryParameterName<Rest>
  : Query extends `${string}=:${infer Parameter}`
    ? Parameter
    : never;

type RouteParameterName<Path extends string> =
  | PathParameterName<RoutePathname<Path>>
  | QueryParameterName<RouteQuery<Path>>;

export type RouteParams<Path extends string> = string extends Path
  ? Readonly<Record<string, string>>
  : Readonly<{ [Parameter in RouteParameterName<Path>]: string }>;

export type DefaultRouteValues<Path extends string> = RouteParams<Path>;

export type RouteDestination<Values extends RouteValues> = keyof Values extends never
  ? {}
  : { readonly params: Values };

export type RouteNavigationParams<Path extends string> = RouteDestination<DefaultRouteValues<Path>>;

export interface CompiledRoutePattern {
  readonly pattern: string;
  readonly parameterNames: readonly string[];
  readonly pathnameParameterNames: readonly string[];
  readonly queryParameters: readonly {
    readonly key: string;
    readonly name: string;
  }[];
  readonly specificity: readonly number[];
}

export interface RouteDefinition<
  Path extends string = string,
  Values extends RouteValues = DefaultRouteValues<Path>,
> {
  readonly config: RouteConfig<Path, Values>;
  readonly component: Component;
  readonly compiled: CompiledRoutePattern;
  readonly params: Values;
  readonly query: Values;
  readonly isActive: boolean;
  readonly isActivePrefix: boolean;
  navigate(destination: RouteDestination<Values>, options?: NavigateOptions): void;
}

export type LinkProps<
  Path extends string,
  Values extends RouteValues,
> = RouteDestination<Values> & {
  readonly route: RouteDefinition<Path, Values>;
  readonly replace?: boolean;
  readonly children: JSX.Element;
};

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
const CONTEXT = Symbol("frontend-framework.context");
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
let activeFrame: RenderFrame | undefined;
let batchDepth = 0;
let flushingEffects = false;
const pendingEffects = new Set<ReactiveEffect>();
const disposedOwners = new WeakSet<Cleanup[]>();

function disposeOwner(owner: Cleanup[]): void {
  if (disposedOwners.has(owner)) return;
  disposedOwners.add(owner);
  for (const cleanup of owner.toReversed()) cleanup();
}

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

function createReactiveEffect(
  callback: () => void,
  computed: boolean,
  explicitOwner?: Cleanup[],
): Cleanup {
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
  const owner = explicitOwner ?? activeOwner;
  const ownerWasDisposed = owner ? disposedOwners.has(owner) : false;
  if (owner && !ownerWasDisposed) owner.push(stop);
  try {
    effect.run();
    if (ownerWasDisposed) stop();
  } catch (error) {
    stop();
    if (owner && !ownerWasDisposed) {
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

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return isObject(value) && typeof (value as { then?: unknown }).then === "function";
}

function isStandardSchema<TInput, TOutput>(
  schema: Parser<TInput, TOutput>,
): schema is StandardSchema<TInput, TOutput> {
  if (!isObject(schema) || !("~standard" in schema)) return false;
  const standard = (schema as { "~standard"?: unknown })["~standard"];
  return isObject(standard) && typeof (standard as { validate?: unknown }).validate === "function";
}

function hasParser(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (isObject(value) &&
      (typeof (value as { parse?: unknown }).parse === "function" ||
        typeof (value as { parseAsync?: unknown }).parseAsync === "function" ||
        ("~standard" in value &&
          isObject((value as { "~standard"?: unknown })["~standard"]) &&
          typeof (value as { "~standard": { validate?: unknown } })["~standard"].validate ===
            "function")))
  );
}

function standardOutput<T>(
  result: { readonly value: T } | { readonly issues: readonly unknown[] },
): T {
  if ("issues" in result) throw { issues: [...result.issues] };
  return result.value;
}

function parseValue<TInput, TOutput>(
  schema: Parser<TInput, TOutput>,
  input: TInput,
): TOutput | PromiseLike<TOutput> {
  if (typeof schema === "function") return schema(input);
  if (isStandardSchema(schema)) {
    const result = schema["~standard"].validate(input);
    return isPromiseLike(result)
      ? Promise.resolve(result).then(standardOutput<TOutput>)
      : standardOutput(result);
  }
  if (typeof schema.parseAsync === "function") return schema.parseAsync(input);
  return schema.parse(input);
}

function isReactiveTarget(value: object): boolean {
  if (!Object.isExtensible(value)) return false;
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

function createComputed<T>(derive: () => T, frame?: RenderFrame): ReadonlySignal<T> {
  if (typeof derive !== "function") throw new TypeError("$computed() expects a function");
  const value = $signal<T>(undefined as T);
  createReactiveEffect(
    () => {
      value.value = derive();
    },
    true,
    frame?.owner,
  );
  return Object.freeze({
    get value(): T {
      return value.value;
    },
  });
}

export function $computed<T>(derive: () => T): ReadonlySignal<T> {
  return createComputed(derive);
}

export function computedInFrame<T>(derive: () => T, frame: RenderFrame): ReadonlySignal<T> {
  return createComputed(derive, frame);
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
  if (!hasParser(schema)) {
    throw new TypeError(
      "$form() schema must be callable, expose parse() or parseAsync(), or implement Standard Schema",
    );
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
    return parseValue(schema, values.value);
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
  _setup: (props: Readonly<Props>) => JSX.Element | Promise<JSX.Element>,
): Component<Props> {
  throw new Error(
    "$component() reached runtime. Add frontendFramework() before Vite's JSX transform.",
  );
}

type ContextRecord = Context<object> & { readonly [CONTEXT]: symbol };

export function $context<TShape extends object>(): Context<TShape> {
  if (arguments.length !== 0) throw new TypeError("$context() does not accept a default value");
  const key = Symbol("frontend-framework.context.value");
  const Provider = (() => {
    throw new Error("Context providers must be rendered as JSX inside a compiled component");
  }) as Component<{ data: TShape; children?: JSX.Element | readonly JSX.Element[] }>;

  const read = (optional: boolean): TShape | undefined => {
    const source = activeFrame?.contexts.get(key);
    if (!source) {
      if (optional) return undefined;
      throw new Error("Context is not available outside its Provider");
    }
    return contextProxy(source) as TShape;
  };

  return Object.freeze({
    [CONTEXT]: key,
    Provider,
    use: () => read(false)!,
    useOptional: () => read(true),
  }) as Context<TShape>;
}

function contextProxy(source: () => object): object {
  const target = {};
  const current = (): object => {
    const value = source();
    if (!isObject(value) || Array.isArray(value)) {
      throw new TypeError("Context Provider data must be an object");
    }
    return value;
  };
  return new Proxy(target, {
    get: (_target, key, receiver) => Reflect.get(current(), key, receiver),
    set: (_target, key, value, receiver) => Reflect.set(current(), key, value, receiver),
    deleteProperty: (_target, key) => Reflect.deleteProperty(current(), key),
    defineProperty: (_target, key, descriptor) =>
      Reflect.defineProperty(current(), key, descriptor),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(), key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(current()),
    has: (_target, key) => Reflect.has(current(), key),
    ownKeys: () => Reflect.ownKeys(current()),
    setPrototypeOf: (_target, prototype) => Reflect.setPrototypeOf(current(), prototype),
  });
}

export const Suspense = (() => {
  throw new Error("Suspense must be rendered as JSX inside a compiled component");
}) as Component<SuspenseProps>;

export const Await = (() => {
  throw new Error("Await must be rendered as JSX inside a compiled component");
}) as <T>(props: Readonly<AwaitProps<T>>) => JSX.Element;

export const ErrorBoundary = (() => {
  throw new Error("ErrorBoundary must be rendered as JSX inside a compiled component");
}) as Component<ErrorBoundaryProps>;

export function $route<
  const Path extends `/${string}`,
  Values extends RouteValues = DefaultRouteValues<Path>,
>(_config: RouteConfig<Path, Values>, _candidate: Component): RouteDefinition<Path, Values> {
  throw new Error(
    "$route() reached runtime. Define exported routes in a *.route.js, .jsx, .ts, or .tsx file and add frontendFramework() to Vite.",
  );
}

export function Link<const Path extends string, Values extends RouteValues>(
  _props: LinkProps<Path, Values>,
): JSX.Element {
  throw new Error("Link reached runtime. Add frontendFramework() before Vite's JSX transform.");
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
  enter(): void;
  leave(): Promise<void> | undefined;
  retire(): Promise<void> | undefined;
  dispose(): void;
}

export interface TemplateDefinition {
  readonly html: string;
  element?: HTMLTemplateElement;
}

interface PendingBlock extends PromiseLike<Block> {
  cancel?: () => void;
}

type MaybeBlock = Block | PendingBlock;
type RenderFactory = (frame: RenderFrame) => Block;
type ErrorRenderFactory = (error: unknown, frame: RenderFrame) => Block;

interface SuspenseController {
  begin(): () => void;
  reject(error: unknown): void;
}

export interface RenderFrame {
  readonly owner: Cleanup[];
  readonly contexts: ReadonlyMap<symbol, () => object>;
  readonly suspense?: SuspenseController;
  readonly handleError?: (error: unknown) => void;
}

type ComponentFactory<Props extends object> = (
  props: Readonly<Props>,
  frame: RenderFrame,
) => MaybeBlock;
type CompiledComponent<Props extends object> = Component<Props> & {
  [COMPONENT]: ComponentFactory<Props>;
};

type CompiledRouteDefinition<
  Path extends string = string,
  Values extends RouteValues = DefaultRouteValues<Path>,
> = RouteDefinition<Path, Values> & {
  [ROUTE]: true;
};

interface RouteRuntimeDefinition {
  readonly compiled: CompiledRoutePattern;
  readonly config: { readonly path: string };
}

interface RouteRuntimeAdapter {
  getParams(definition: RouteRuntimeDefinition): RouteValues;
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

type TransitionPhase = keyof Transition;
type TransitionGetter = () => Transition;

const transitionGetters = new WeakMap<Element, TransitionGetter>();
const runningTransitions = new WeakMap<
  Element,
  { animations: readonly Animation[]; classes: readonly string[] }
>();

export function transition(element: Element, getTransition: TransitionGetter): void {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    throw new TypeError("$transition expects a DOM Element");
  }
  if (typeof getTransition !== "function") {
    throw new TypeError("$transition expects a transition getter");
  }
  transitionGetters.set(element, getTransition);
}

function transitionClasses(value: unknown, phase: TransitionPhase): string[] | undefined {
  if (!isObject(value) || Array.isArray(value) || !isReactiveTarget(value)) {
    throw new TypeError("$transition expects an object with enter and/or leave class names");
  }
  const className = (value as Record<TransitionPhase, unknown>)[phase];
  if (className === undefined) return undefined;
  if (typeof className !== "string" || className.trim() === "") {
    throw new TypeError(`$transition ${phase} must be a non-empty class name string`);
  }
  return className.trim().split(/\s+/);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function transitionedElements(nodes: readonly Node[]): Element[] {
  const elements: Element[] = [];
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    if (transitionGetters.has(node)) elements.push(node);
    for (const descendant of node.querySelectorAll("*")) {
      if (transitionGetters.has(descendant)) elements.push(descendant);
    }
  }
  return elements;
}

function cancelTransitions(nodes: readonly Node[]): void {
  for (const element of transitionedElements(nodes)) {
    const running = runningTransitions.get(element);
    if (!running) continue;
    runningTransitions.delete(element);
    for (const animation of running.animations) animation.cancel();
    element.classList.remove(...running.classes);
  }
}

function runTransitions(nodes: readonly Node[], phase: TransitionPhase): Promise<void> | undefined {
  const configured: Array<{ element: Element; classes: string[] }> = [];
  for (const element of transitionedElements(nodes)) {
    const getter = transitionGetters.get(element)!;
    const classes = transitionClasses(getter(), phase);
    if (classes) configured.push({ element, classes });
  }
  cancelTransitions(nodes);
  if (configured.length === 0 || prefersReducedMotion()) return undefined;

  const finished: Promise<unknown>[] = [];
  for (const { element, classes } of configured) {
    if (typeof element.getAnimations !== "function") continue;
    const existing = new Set(element.getAnimations());
    const addedClasses = classes.filter((className) => !element.classList.contains(className));
    element.classList.add(...classes);
    const animations = element.getAnimations().filter((animation) => !existing.has(animation));
    if (animations.length === 0) {
      element.classList.remove(...addedClasses);
      continue;
    }
    const running = { animations, classes: addedClasses };
    runningTransitions.set(element, running);
    finished.push(
      Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).finally(
        () => {
          if (runningTransitions.get(element) !== running) return;
          runningTransitions.delete(element);
          element.classList.remove(...addedClasses);
        },
      ),
    );
  }
  return finished.length > 0 ? Promise.all(finished).then(() => undefined) : undefined;
}

export function block(fragment: DocumentFragment, cleanups: Cleanup[] = []): Block {
  const start = document.createComment("ff:block:start");
  const end = document.createComment("ff:block:end");
  fragment.prepend(start);
  fragment.append(end);
  let disposed = false;
  let cleaned = false;
  const nodes = (): Node[] => {
    const result: Node[] = [];
    let node: Node | null = start;
    while (node) {
      result.push(node);
      if (node === end) break;
      node = node.nextSibling;
    }
    return result;
  };
  const move = (parent: Node, before: Node | null = null): void => {
    const moving = document.createDocumentFragment();
    for (const node of nodes()) moving.append(node);
    parent.insertBefore(moving, before);
  };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const registered of cleanups.toReversed()) registered();
  };
  const remove = (): void => {
    for (const node of nodes()) node.parentNode?.removeChild(node);
  };
  return {
    get nodes() {
      return nodes();
    },
    mount: move,
    move,
    enter() {
      if (!disposed) void runTransitions(nodes(), "enter");
    },
    leave() {
      return disposed ? undefined : runTransitions(nodes(), "leave");
    },
    retire() {
      if (disposed) return undefined;
      const leaving = runTransitions(nodes(), "leave");
      cleanup();
      if (!leaving) {
        disposed = true;
        remove();
        return undefined;
      }
      return leaving.then(() => {
        if (disposed) return;
        disposed = true;
        remove();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTransitions(nodes());
      cleanup();
      remove();
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
  const ownedFactory: ComponentFactory<Props> = (props, parentFrame) => {
    const owner: Cleanup[] = [];
    const frame: RenderFrame = { ...parentFrame, owner };
    const previousOwner = activeOwner;
    const previousFrame = activeFrame;
    activeOwner = owner;
    activeFrame = frame;
    let rendered: MaybeBlock;
    try {
      rendered = factory(props, frame);
    } catch (error) {
      disposeOwner(owner);
      throw error;
    } finally {
      activeOwner = previousOwner;
      activeFrame = previousFrame;
    }
    if (isPromiseLike(rendered)) {
      const pending = Promise.resolve(rendered).then(
        (resolved) => ownedBlock(resolved, owner),
        (error) => {
          disposeOwner(owner);
          throw error;
        },
      );
      void Object.defineProperty(pending, "cancel", { value: () => disposeOwner(owner) });
      return pending;
    }
    return ownedBlock(rendered, owner);
  };
  Object.defineProperty(compiled, COMPONENT, { value: ownedFactory });
  return compiled;
}

function ownedBlock(rendered: Block, owner: Cleanup[]): Block {
  let disposed = false;
  let retired = false;
  let retirement: Promise<void> | undefined;
  return {
    get nodes() {
      return rendered.nodes;
    },
    mount: (parent, before) => rendered.mount(parent, before),
    move: (parent, before) => rendered.move(parent, before),
    enter: () => rendered.enter(),
    leave: () => rendered.leave(),
    retire() {
      if (disposed || retired) return retirement;
      retired = true;
      disposeOwner(owner);
      const leaving = rendered.retire();
      if (!leaving) {
        disposed = true;
        return undefined;
      }
      retirement = leaving.then(() => {
        disposed = true;
      });
      return retirement;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      rendered.dispose();
      disposeOwner(owner);
    },
  };
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
  const frame = rootFrame();
  return resolvedBlock(getFactory(candidate)(initialProps, frame), frame);
}

function validateRouteValues(values: unknown, parameterNames: readonly string[]): RouteValues {
  if (!isObject(values) || Array.isArray(values)) {
    throw new TypeError("Route schema output must be an object");
  }
  const paramKeys = Object.keys(values);
  const missing = parameterNames.find((name) => !(name in values));
  if (missing) throw new TypeError(`Route schema output is missing parameter ${missing}`);
  const unexpected = paramKeys.find((name) => !parameterNames.includes(name));
  if (unexpected)
    throw new TypeError(`Route schema output contains unknown parameter ${unexpected}`);
  for (const name of parameterNames) {
    const value = (values as Record<string, unknown>)[name];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new TypeError(`Route schema output parameter ${name} must be a string or number`);
    }
  }
  return Object.freeze({ ...values }) as RouteValues;
}

export type RouteResolution =
  | { readonly matched: true; readonly values: RouteValues }
  | { readonly matched: false };

export function resolveRoute<Path extends string, Values extends RouteValues>(
  definition: RouteDefinition<Path, Values>,
  raw: RawRouteParams,
): RouteResolution | PromiseLike<RouteResolution> {
  const schema = definition.config.schema;
  if (!schema) {
    return {
      matched: true,
      values: validateRouteValues(raw, definition.compiled.parameterNames),
    };
  }
  try {
    const result = parseValue(schema, raw);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        (values) => ({
          matched: true as const,
          values: validateRouteValues(values, definition.compiled.parameterNames),
        }),
        (error: unknown) => {
          if (validationFailure(error)) return { matched: false as const };
          throw error;
        },
      );
    }
    return {
      matched: true,
      values: validateRouteValues(result, definition.compiled.parameterNames),
    };
  } catch (error) {
    if (validationFailure(error)) return { matched: false };
    throw error;
  }
}

export function routeHref<Path extends string, Values extends RouteValues>(
  definition: RouteDefinition<Path, Values>,
  destination: Readonly<Record<string, unknown>>,
): string {
  if (!isObject(destination) || Array.isArray(destination)) {
    throw new TypeError("Route destination must be an object");
  }
  const unexpectedSection = Object.keys(destination).find((name) => name !== "params");
  if (unexpectedSection) {
    throw new TypeError(`Route destination contains unknown property ${unexpectedSection}`);
  }
  const hasParams = definition.compiled.parameterNames.length > 0;
  const params = (destination as { params?: unknown }).params;
  if (hasParams && params === undefined) {
    throw new TypeError(`Missing route parameter ${definition.compiled.parameterNames[0]}`);
  }
  if (hasParams && (!isObject(params) || Array.isArray(params))) {
    throw new TypeError("Route destination params must be an object");
  }
  if (!hasParams && params !== undefined) {
    if (!isObject(params) || Array.isArray(params) || Object.keys(params).length > 0) {
      throw new TypeError("Route destination contains params for a static route");
    }
  }
  const candidateParams = (params ?? {}) as Readonly<Record<string, unknown>>;
  const unexpected = Object.keys(candidateParams).find(
    (name) => !definition.compiled.parameterNames.includes(name),
  );
  if (unexpected) throw new TypeError(`Unknown route parameter ${unexpected}`);
  const [pathnameTemplate] = definition.config.path.split("?", 1);
  let path = pathnameTemplate!;
  for (const name of definition.compiled.parameterNames) {
    if (!(name in candidateParams)) throw new TypeError(`Missing route parameter ${name}`);
    const value = candidateParams[name];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new TypeError(`Route parameter ${name} must be a string or number`);
    }
    path = path.replaceAll(`:${name}`, encodeURIComponent(String(value)));
  }
  const search = new URLSearchParams();
  for (const queryParameter of definition.compiled.queryParameters) {
    search.set(queryParameter.key, String(candidateParams[queryParameter.name]));
  }
  const serialized = search.toString();
  return serialized ? `${path}?${serialized}` : path;
}

export function route<
  const Path extends `/${string}`,
  Values extends RouteValues = DefaultRouteValues<Path>,
>(
  config: RouteConfig<Path, Values>,
  candidate: Component,
  compiled: CompiledRoutePattern,
): RouteDefinition<Path, Values> {
  if (!config || typeof config !== "object" || typeof config.path !== "string") {
    throw new TypeError("Compiled route config must contain a path");
  }
  const unexpectedConfig = Object.keys(config).find((name) => name !== "path" && name !== "schema");
  if (unexpectedConfig) {
    throw new TypeError(`Compiled route config contains unknown property ${unexpectedConfig}`);
  }
  if (config.schema !== undefined) {
    const schema = config.schema;
    if (!hasParser(schema)) {
      throw new TypeError(
        "Compiled route schema must be callable, expose parse() or parseAsync(), or implement Standard Schema",
      );
    }
  }
  getFactory(candidate);
  if (
    !compiled ||
    typeof compiled.pattern !== "string" ||
    !Array.isArray(compiled.parameterNames) ||
    !Array.isArray(compiled.pathnameParameterNames) ||
    !Array.isArray(compiled.queryParameters) ||
    !Array.isArray(compiled.specificity)
  ) {
    throw new TypeError("Compiled route metadata is invalid");
  }
  if (
    compiled.parameterNames.some((name) => typeof name !== "string") ||
    compiled.pathnameParameterNames.some(
      (name) => typeof name !== "string" || !compiled.parameterNames.includes(name),
    ) ||
    compiled.queryParameters.some(
      (parameter) =>
        !isObject(parameter) ||
        typeof (parameter as { key?: unknown }).key !== "string" ||
        typeof (parameter as { name?: unknown }).name !== "string" ||
        !compiled.parameterNames.includes((parameter as { name: string }).name),
    ) ||
    compiled.specificity.some((part) => typeof part !== "number")
  ) {
    throw new TypeError("Compiled route metadata is invalid");
  }
  let definition: CompiledRouteDefinition<Path, Values>;
  const staticPrefix = config.path.split("?", 1)[0]!.split("/:", 1)[0] || "/";
  definition = Object.freeze({
    [ROUTE]: true,
    config: Object.freeze({ ...config }),
    component: candidate,
    compiled: Object.freeze({
      pattern: compiled.pattern,
      parameterNames: Object.freeze([...compiled.parameterNames]),
      pathnameParameterNames: Object.freeze([...compiled.pathnameParameterNames]),
      queryParameters: Object.freeze(
        compiled.queryParameters.map((parameter) => Object.freeze({ ...parameter })),
      ),
      specificity: Object.freeze([...compiled.specificity]),
    }),
    get params() {
      if (!routeRuntime) throw new Error("Route runtime is not initialized");
      return routeRuntime.getParams(definition) as Values;
    },
    get query() {
      return definition.params;
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
    navigate(destination: RouteDestination<Values>, options?: NavigateOptions) {
      if (!routeRuntime) throw new Error("Route runtime is not initialized");
      routeRuntime.navigate(
        routeHref(
          definition,
          destination as RouteDestination<Values> & Readonly<Record<string, unknown>>,
        ),
        options,
      );
    },
  }) as CompiledRouteDefinition<Path, Values>;
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
  const frame = rootFrame();
  const mounted = resolvedBlock(factory(initialProps, frame), frame);
  target.replaceChildren();
  mounted.mount(target);
  return () => mounted.dispose();
}

function rootFrame(): RenderFrame {
  return { owner: [], contexts: new Map() };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && typeof (value as { then?: unknown }).then === "function";
}

function cancelPendingBlock(value: PromiseLike<unknown>): void {
  const cancel = (value as PendingBlock).cancel;
  if (typeof cancel === "function") cancel();
}

function surfaceAsyncError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function reportError(frame: RenderFrame, error: unknown): void {
  if (frame.suspense) frame.suspense.reject(error);
  else if (frame.handleError) frame.handleError(error);
  else surfaceAsyncError(error);
}

function resolvedBlock(candidate: MaybeBlock, frame: RenderFrame): Block {
  if (!isPromiseLike(candidate)) return candidate;
  const fragment = document.createDocumentFragment();
  const marker = document.createComment("ff:async");
  fragment.append(marker);
  let disposed = false;
  let resolved: Block | undefined;
  const finish = frame.suspense?.begin();
  Promise.resolve(candidate).then(
    (settledBlock) => {
      if (disposed) {
        settledBlock.dispose();
      } else {
        resolved = settledBlock;
        settledBlock.mount(marker.parentNode!, marker);
      }
      finish?.();
    },
    (error) => {
      if (!disposed) reportError(frame, error);
      finish?.();
    },
  );
  return block(fragment, [
    () => {
      disposed = true;
      cancelPendingBlock(candidate);
      finish?.();
      resolved?.dispose();
    },
  ]);
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
      row?.block.move(region.end.parentNode!, region.end);
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

export function suspense(
  region: Region,
  render: RenderFactory,
  renderFallback: RenderFactory,
  renderError: ErrorRenderFactory | undefined,
  cleanups: Cleanup[],
  frame: RenderFrame,
): void {
  let pending = 0;
  let initialized = false;
  let failed = false;
  let visible: Block | undefined;
  let content: Block | undefined;
  const parking = document.createDocumentFragment();
  const show = (next: Block): void => {
    if (visible === next) return;
    if (visible && visible === content) visible.move(parking);
    else visible?.dispose();
    visible = next;
    next.mount(region.end.parentNode!, region.end);
  };
  const controller: SuspenseController = {
    begin() {
      const wasIdle = pending === 0;
      pending += 1;
      if (initialized && wasIdle && !failed && visible === content) {
        try {
          show(renderFallback(frame));
        } catch (error) {
          controller.reject(error);
        }
      }
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        pending -= 1;
        if (initialized && pending === 0 && !failed && content) show(content);
      };
    },
    reject(error) {
      if (failed) return;
      failed = true;
      if (renderError) {
        if (content) {
          content.dispose();
          if (visible === content) visible = undefined;
        }
        try {
          show(renderError(error, frame));
        } catch (renderFailure) {
          reportError(frame, renderFailure);
        }
      } else if (frame.suspense) frame.suspense.reject(error);
      else if (frame.handleError) frame.handleError(error);
      else surfaceAsyncError(error);
    },
  };
  const contentFrame: RenderFrame = { ...frame, suspense: controller };
  try {
    content = render(contentFrame);
    initialized = true;
    show(pending > 0 ? renderFallback(frame) : content);
  } catch (error) {
    controller.reject(error);
  }
  cleanups.push(() => {
    visible?.dispose();
    if (content && content !== visible) content.dispose();
  });
}

export function awaitBlock<T>(
  region: Region,
  getPromise: () => PromiseLike<T>,
  render: (value: T, frame: RenderFrame) => Block,
  renderError: ErrorRenderFactory | undefined,
  cleanups: Cleanup[],
  frame: RenderFrame,
): void {
  let generation = 0;
  let current: Block | undefined;
  let currentFinish: (() => void) | undefined;
  let disposed = false;
  const showError = (error: unknown): void => {
    if (!renderError) return reportError(frame, error);
    try {
      current = renderError(error, frame);
      current.mount(region.end.parentNode!, region.end);
    } catch (renderFailure) {
      reportError(frame, renderFailure);
    }
  };
  const stop = runtimeEffect(() => {
    const promise = getPromise();
    if (!isPromiseLike(promise)) throw new TypeError("Await $promise must be promise-like");
    const currentGeneration = ++generation;
    currentFinish?.();
    current?.dispose();
    current = undefined;
    const finish = frame.suspense?.begin();
    currentFinish = finish;
    Promise.resolve(promise).then(
      (value) => {
        if (disposed || currentGeneration !== generation) return finish?.();
        try {
          current = render(value, frame);
          current.mount(region.end.parentNode!, region.end);
        } catch (error) {
          showError(error);
        }
        finish?.();
        if (currentFinish === finish) currentFinish = undefined;
      },
      (error) => {
        if (disposed || currentGeneration !== generation) return finish?.();
        showError(error);
        finish?.();
        if (currentFinish === finish) currentFinish = undefined;
      },
    );
  });
  cleanups.push(stop, () => {
    disposed = true;
    generation += 1;
    currentFinish?.();
    current?.dispose();
  });
}

export function errorBoundary(
  region: Region,
  render: RenderFactory,
  renderFallback: ErrorRenderFactory,
  cleanups: Cleanup[],
  frame: RenderFrame,
): void {
  let current: Block | undefined;
  let failed = false;
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    current?.dispose();
    try {
      current = renderFallback(error, frame);
      current.mount(region.end.parentNode!, region.end);
    } catch (fallbackError) {
      if (frame.handleError) frame.handleError(fallbackError);
      else surfaceAsyncError(fallbackError);
    }
  };
  const childFrame: RenderFrame = { ...frame, handleError: fail };
  try {
    current = render(childFrame);
    current.mount(region.end.parentNode!, region.end);
  } catch (error) {
    fail(error);
  }
  cleanups.push(() => current?.dispose());
}
import type { JSX } from "./jsx-runtime.ts";
