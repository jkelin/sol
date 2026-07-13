import type { JSX } from "./jsx-runtime.ts";
import type { Component } from "./components.ts";
import { hasParser, parseValue, type Parser } from "./validation.ts";
import { isObject, isPromiseLike } from "./reactivity.ts";
import { ROUTE } from "./symbols.ts";
import { validationFailure } from "./forms.ts";
import { getFactory, routeRuntime } from "./rendering.ts";

export interface NavigateOptions {
  readonly replace?: boolean;
}

export type RouteValue = string | number;
export type RawRouteParams = Readonly<Record<string, string | undefined>>;
export type RouteValues = Readonly<Record<string, RouteValue | undefined>>;

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
  getParams(definition: RouteRuntimeDefinition): RouteValues;
  getPathname(): string;
  isActive(definition: RouteRuntimeDefinition): boolean;
  navigate(path: string, options?: NavigateOptions): void;
}

function validateRouteValues(
  values: unknown,
  parameterNames: readonly string[],
  pathnameParameterNames: readonly string[],
): RouteValues {
  if (!isObject(values) || Array.isArray(values)) {
    throw new TypeError("Route schema output must be an object");
  }
  const paramKeys = Object.keys(values);
  const missing = pathnameParameterNames.find((name) => !(name in values));
  if (missing) throw new TypeError(`Route schema output is missing parameter ${missing}`);
  const unexpected = paramKeys.find((name) => !parameterNames.includes(name));
  if (unexpected)
    throw new TypeError(`Route schema output contains unknown parameter ${unexpected}`);
  for (const name of parameterNames) {
    const value = (values as Record<string, unknown>)[name];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      !(value === undefined && !pathnameParameterNames.includes(name))
    ) {
      throw new TypeError(
        `Route schema output parameter ${name} must be a string, number, or undefined query value`,
      );
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
  for (const name of definition.compiled.pathnameParameterNames) {
    if (!(name in candidateParams)) throw new TypeError(`Missing route parameter ${name}`);
    const value = candidateParams[name];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new TypeError(`Route parameter ${name} must be a string or number`);
    }
    path = path
      .split("/")
      .map((segment) => (segment === `:${name}` ? encodeURIComponent(String(value)) : segment))
      .join("/");
  }
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
        ? compiled.pathnameParameterNames.length > 0 || pathname === "/"
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
