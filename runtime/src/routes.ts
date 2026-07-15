import type { JSX } from "./jsx-runtime.ts";
import type { Component } from "./components.ts";
import { hasParser, parseValue, type Parser } from "./validation.ts";
import { isObject, isPromiseLike } from "./reactivity.ts";
import { ROUTE } from "./symbols.ts";
import { validationFailure } from "./forms.ts";
import { getFactory, routeRuntime, type RenderFrame } from "./rendering.ts";
export {
  compareRouteSpecificity,
  type RouteSpecificityDescriptor,
  type StaticRouteDescriptor,
} from "./route-descriptors.ts";

export interface NavigateOptions {
  readonly replace?: boolean;
}

export function canonicalizePathname(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");
}

export type RouteValue = string | number;
export type RawRouteParams = Readonly<Record<string, string | undefined>>;
export type RouteValues = Readonly<Record<string, RouteValue | undefined>>;

export function defineRouteValue(
  target: Record<string, string | number | undefined>,
  name: string,
  value: string | number | undefined,
): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

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

export type RouteParams<Path extends string> = string extends Path
  ? Readonly<Record<string, string | undefined>>
  : Readonly<
      { [Parameter in PathParameterName<RoutePathname<Path>>]: string } & {
        [Parameter in Exclude<
          QueryParameterName<RouteQuery<Path>>,
          PathParameterName<RoutePathname<Path>>
        >]?: string;
      }
    >;

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

export interface LazyRouteDefinition {
  readonly config: { readonly path: string };
  readonly compiled: CompiledRoutePattern;
  load(): Promise<RouteDefinition>;
}

const unloadedRouteComponent = (() => {
  throw new Error("Route implementation has not been loaded");
}) as Component;

export type LinkProps<
  Path extends string,
  Values extends RouteValues,
> = RouteDestination<Values> & {
  readonly route: RouteDefinition<Path, Values>;
  readonly replace?: boolean;
  readonly children: JSX.Element;
};

export type CompiledRouteDefinition<
  Path extends string = string,
  Values extends RouteValues = DefaultRouteValues<Path>,
> = RouteDefinition<Path, Values> & {
  [ROUTE]: true;
};

export interface RouteRuntimeDefinition {
  readonly compiled: CompiledRoutePattern;
  readonly config: { readonly path: string };
}

export interface RouteRuntimeAdapter {
  getParams(definition: RouteRuntimeDefinition, frame?: RenderFrame): RouteValues;
  getPathname(frame?: RenderFrame): string;
  isActive(definition: RouteRuntimeDefinition, frame?: RenderFrame): boolean;
  readRouter?(key: RouterReadKey, frame?: RenderFrame): unknown;
  navigate(path: string, options?: NavigateOptions): void;
}

export type RouterReadKey =
  | "pathname"
  | "search"
  | "hash"
  | "searchParams"
  | "params"
  | "query"
  | "route";

export type RouteReadKey = RouterReadKey | "isActive" | "isActivePrefix";

const ROUTE_READ_KEYS = new Set<RouteReadKey>([
  "pathname",
  "search",
  "hash",
  "searchParams",
  "params",
  "query",
  "route",
  "isActive",
  "isActivePrefix",
]);

const routePrefixes = new WeakMap<RouteRuntimeDefinition, string>();
const routerValues = new WeakSet<object>();
const frameRouteObjects = new WeakMap<RenderFrame, WeakMap<object, object>>();

export function registerRouter<T extends object>(candidate: T): T {
  routerValues.add(candidate);
  return candidate;
}

function routeIsActivePrefix(definition: RouteRuntimeDefinition, frame?: RenderFrame): boolean {
  const rawPathname = routeRuntime?.getPathname(frame);
  let pathname: string | undefined;
  try {
    pathname = rawPathname ? canonicalizePathname(rawPathname) : undefined;
  } catch {
    return false;
  }
  if (!pathname) return false;
  const staticPrefix = routePrefixes.get(definition);
  if (!staticPrefix) return false;
  return staticPrefix === "/"
    ? definition.compiled.pathnameParameterNames.length > 0 || pathname === "/"
    : pathname === staticPrefix || pathname.startsWith(`${staticPrefix}/`);
}

export function routeRead(
  candidate: unknown,
  key: RouteReadKey,
  frame: RenderFrame,
  continuation?: (value: unknown) => unknown,
): unknown {
  if (candidate == null) {
    if (continuation) return undefined;
    return (candidate as unknown as Record<RouteReadKey, unknown>)[key];
  }
  let value: unknown;
  if (typeof candidate === "object" && routePrefixes.has(candidate as RouteRuntimeDefinition)) {
    const definition = candidate as RouteRuntimeDefinition;
    if (key === "params" || key === "query") {
      if (!routeRuntime) throw new Error("Route runtime is not initialized");
      value = routeRuntime.getParams(definition, frame);
    } else if (key === "isActive") {
      value = routeRuntime?.isActive(definition, frame) ?? false;
    } else if (key === "isActivePrefix") {
      value = routeIsActivePrefix(definition, frame);
    } else {
      value = (candidate as unknown as Record<RouteReadKey, unknown>)[key];
    }
  } else if (typeof candidate === "object" && routerValues.has(candidate)) {
    if (!routeRuntime?.readRouter) throw new Error("Router runtime is not initialized");
    value = routeRuntime.readRouter(key as RouterReadKey, frame);
  } else {
    value = (candidate as Record<RouteReadKey, unknown>)[key];
  }
  return continuation ? continuation(value) : value;
}

export function routeObject(candidate: unknown, frame: RenderFrame): unknown {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    (!routePrefixes.has(candidate as RouteRuntimeDefinition) && !routerValues.has(candidate))
  ) {
    return candidate;
  }
  let objects = frameRouteObjects.get(frame);
  if (!objects) {
    objects = new WeakMap();
    frameRouteObjects.set(frame, objects);
  }
  const existing = objects.get(candidate);
  if (existing) return existing;
  const view = new Proxy(candidate, {
    get(target, key, receiver) {
      return typeof key === "string" && ROUTE_READ_KEYS.has(key as RouteReadKey)
        ? routeRead(target, key as RouteReadKey, frame)
        : Reflect.get(target, key, receiver);
    },
  });
  objects.set(candidate, view);
  return view;
}

function validateRouteValues(
  values: unknown,
  parameterNames: readonly string[],
  pathnameParameterNames: readonly string[],
): RouteValues {
  if (!isObject(values) || Array.isArray(values)) {
    throw new TypeError("Route schema output must be an object");
  }
  const prototype = Object.getPrototypeOf(values);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Route schema output must be a plain object");
  }
  const ownKeys = Reflect.ownKeys(values);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new TypeError("Route schema output must not contain symbol properties");
  }
  const paramKeys = ownKeys as string[];
  const descriptors = Object.getOwnPropertyDescriptors(values);
  const missing = pathnameParameterNames.find((name) => descriptors[name] === undefined);
  if (missing) throw new TypeError(`Route schema output is missing parameter ${missing}`);
  const unexpected = paramKeys.find((name) => !parameterNames.includes(name));
  if (unexpected)
    throw new TypeError(`Route schema output contains unknown parameter ${unexpected}`);
  const validated: Record<string, string | number | undefined> = {};
  for (const name of parameterNames) {
    const descriptor = descriptors[name];
    if (!descriptor) continue;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(
        `Route schema output parameter ${name} must be an enumerable data property`,
      );
    }
    const value = descriptor.value as unknown;
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      !(value === undefined && !pathnameParameterNames.includes(name))
    ) {
      throw new TypeError(
        `Route schema output parameter ${name} must be a string, number, or undefined query value`,
      );
    }
    defineRouteValue(validated, name, value);
  }
  return Object.freeze(validated) as RouteValues;
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
      values: validateRouteValues(
        raw,
        definition.compiled.parameterNames,
        definition.compiled.pathnameParameterNames,
      ),
    };
  }
  try {
    const result = parseValue(schema, raw);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        (values) => ({
          matched: true as const,
          values: validateRouteValues(
            values,
            definition.compiled.parameterNames,
            definition.compiled.pathnameParameterNames,
          ),
        }),
        (error: unknown) => {
          if (validationFailure(error)) return { matched: false as const };
          throw error;
        },
      );
    }
    return {
      matched: true,
      values: validateRouteValues(
        result,
        definition.compiled.parameterNames,
        definition.compiled.pathnameParameterNames,
      ),
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
  const destinationPrototype = Object.getPrototypeOf(destination);
  if (destinationPrototype !== Object.prototype && destinationPrototype !== null) {
    throw new TypeError("Route destination must be a plain object");
  }
  const destinationKeys = Reflect.ownKeys(destination);
  if (destinationKeys.some((key) => typeof key === "symbol")) {
    throw new TypeError("Route destination must not contain symbol properties");
  }
  const unexpectedSection = (destinationKeys as string[]).find((name) => name !== "params");
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
  if (isObject(params) && !Array.isArray(params)) {
    const prototype = Object.getPrototypeOf(params);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Route destination params must be a plain object");
    }
    if (Reflect.ownKeys(params).some((key) => typeof key === "symbol")) {
      throw new TypeError("Route destination params must not contain symbol properties");
    }
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
  path = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return encodeURIComponent(decodeURIComponent(segment));
      const name = segment.slice(1);
      if (!Object.hasOwn(candidateParams, name))
        throw new TypeError(`Missing route parameter ${name}`);
      const value = candidateParams[name];
      if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeError(`Route parameter ${name} must be a string or number`);
      }
      return encodeURIComponent(String(value));
    })
    .join("/");
  const search = new URLSearchParams();
  for (const queryParameter of definition.compiled.queryParameters) {
    const value = candidateParams[queryParameter.name];
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number") {
      throw new TypeError(
        `Route parameter ${queryParameter.name} must be a string, number, or undefined`,
      );
    }
    search.set(queryParameter.key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function validatedCompiledRoute(compiled: CompiledRoutePattern): CompiledRoutePattern {
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
  return Object.freeze({
    pattern: compiled.pattern,
    parameterNames: Object.freeze([...compiled.parameterNames]),
    pathnameParameterNames: Object.freeze([...compiled.pathnameParameterNames]),
    queryParameters: Object.freeze(
      compiled.queryParameters.map((parameter) => Object.freeze({ ...parameter })),
    ),
    specificity: Object.freeze([...compiled.specificity]),
  });
}

function createRouteDefinition<
  const Path extends `/${string}`,
  Values extends RouteValues = DefaultRouteValues<Path>,
>(
  config: RouteConfig<Path, Values>,
  candidate: Component | undefined,
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
  if (candidate) getFactory(candidate);
  const validatedCompiled = validatedCompiledRoute(compiled);
  let definition: CompiledRouteDefinition<Path, Values>;
  const staticPrefix = canonicalizePathname(config.path.split("?", 1)[0]!.split("/:", 1)[0] || "/");
  definition = Object.freeze({
    [ROUTE]: true,
    config: Object.freeze({ ...config }),
    component: candidate ?? unloadedRouteComponent,
    compiled: validatedCompiled,
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
      return routeIsActivePrefix(definition);
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
  routePrefixes.set(definition, staticPrefix);
  return definition;
}

export function route<
  const Path extends `/${string}`,
  Values extends RouteValues = DefaultRouteValues<Path>,
>(
  config: RouteConfig<Path, Values>,
  candidate: Component,
  compiled: CompiledRoutePattern,
): RouteDefinition<Path, Values> {
  return createRouteDefinition(config, candidate, compiled);
}

export function routeHandle<
  const Path extends `/${string}`,
  Values extends RouteValues = DefaultRouteValues<Path>,
>(
  config: RouteConfig<Path, Values>,
  compiled: CompiledRoutePattern,
): RouteDefinition<Path, Values> {
  return createRouteDefinition(config, undefined, compiled);
}

export function lazyRoute(
  path: string,
  compiled: CompiledRoutePattern,
  loader: () => Promise<unknown>,
): LazyRouteDefinition {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("Lazy route path must be root-relative");
  }
  if (typeof loader !== "function") throw new TypeError("Lazy route loader must be a function");
  canonicalizePathname(path.split("?", 1)[0]!);
  const config = Object.freeze({ path });
  const validatedCompiled = validatedCompiledRoute(compiled);
  let loaded: Promise<RouteDefinition> | undefined;
  return Object.freeze({
    config,
    compiled: validatedCompiled,
    load() {
      loaded ??= Promise.resolve(loader()).then((definition) => {
        if (!isRouteDefinition(definition)) {
          throw new TypeError(`Lazy route module did not export a compiled route for ${path}`);
        }
        if (
          definition.config.path !== path ||
          definition.compiled.pattern !== validatedCompiled.pattern
        ) {
          throw new TypeError(`Lazy route module metadata does not match ${path}`);
        }
        return definition;
      });
      return loaded;
    },
  });
}

export function isRouteDefinition(value: unknown): value is RouteDefinition {
  return Boolean(value && typeof value === "object" && (value as CompiledRouteDefinition)[ROUTE]);
}
