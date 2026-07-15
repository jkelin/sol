import type { Component } from "./components.ts";
import { devtoolsRouterUpdated } from "./devtools-hook.ts";
import { regionHydrationClaim } from "./hydration-rendering.ts";
import { $signal, isPromiseLike, runDisposals, runtimeEffect, runtimeState } from "./reactivity.ts";
import {
  block,
  component,
  configureServerRenderPreparation,
  configureRouteRuntime,
  instantiate,
  reportError,
  renderComponent,
  settleRetirement,
  template,
  type Block,
  type Region,
  type RenderFrame,
} from "./rendering.ts";
import {
  canonicalizePathname,
  compareRouteSpecificity,
  defineRouteValue,
  isRouteDefinition,
  registerRouter,
  resolveRoute,
  type NavigateOptions,
  type LazyRouteDefinition,
  type RawRouteParams,
  type RouteConfig,
  type RouteDefinition,
  type RouteValues,
} from "./routes.ts";
import { isServerRegion } from "./server-rendering.ts";
import { configureRouteBase, deployedPath, logicalPathname } from "./route-base.ts";

export interface Router {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly searchParams: Omit<URLSearchParams, "append" | "delete" | "set" | "sort">;
  readonly params: Readonly<Record<string, string | number | undefined>>;
  readonly query: Readonly<Record<string, string | number | undefined>>;
  readonly route: RouteConfig | null;
  navigate(path: string, options?: NavigateOptions): void;
}

export type RouterNavigationMode = "history" | "document";

let navigationMode: RouterNavigationMode = "history";

export function configureRouterNavigation(mode: unknown): void {
  if (mode !== "history" && mode !== "document") {
    throw new TypeError('Router navigation mode must be "history" or "document"');
  }
  navigationMode = mode;
}

interface RouterState {
  pathname: string;
  matchesBase: boolean;
  search: string;
  hash: string;
  searchParams: URLSearchParams;
  values: RouteValues | null;
  route: RouteConfig | null;
  pattern: string | null;
  definition: RouteDefinition | null;
  status: "ready" | "pending" | "error";
  error: unknown;
}

interface RouteMatch {
  definition: LazyRouteDefinition | RouteDefinition;
  params: RawRouteParams;
}

const EMPTY_ROUTE_VALUES: Router["params"] = Object.freeze({});

interface PreparedRoute {
  readonly definition: LazyRouteDefinition | RouteDefinition;
  readonly matcher: RegExp;
}

function readLocation(frame?: RenderFrame): RouterState {
  const location = frame?.url ?? (typeof window === "undefined" ? null : window.location);
  const search = location?.search ?? "";
  const pathname = location?.pathname ?? "/";
  const logicalPath = logicalPathname(pathname);
  const applicationPath = logicalPath ?? pathname;
  return {
    pathname:
      applicationPath.length > 1 && applicationPath.endsWith("/")
        ? applicationPath.slice(0, -1)
        : applicationPath,
    matchesBase: frame !== undefined || logicalPath !== undefined,
    search,
    hash: location?.hash ?? "",
    searchParams: new URLSearchParams(search),
    values: null,
    route: null,
    pattern: null,
    definition: null,
    status: "ready",
    error: undefined,
  };
}

const state = $signal<RouterState>(readLocation());
const serverStates = new WeakMap<URL, RouterState>();

function setRouterState(next: RouterState): void {
  state.value = next;
  devtoolsRouterUpdated({
    pathname: next.pathname,
    search: next.search,
    hash: next.hash,
    searchParams: Object.fromEntries(next.searchParams),
    params: next.values ?? {},
    route: next.route ? { path: next.route.path } : null,
    pattern: next.pattern,
    status: next.status,
    error: next.error,
    routes: preparedRoutes.map(({ definition }) => ({
      path: definition.config.path,
      pattern: definition.compiled.pattern,
      parameterNames: definition.compiled.parameterNames,
      pathnameParameterNames: definition.compiled.pathnameParameterNames,
      queryParameters: definition.compiled.queryParameters,
      specificity: definition.compiled.specificity,
    })),
  });
}

function prepareRoutes(
  definitions: readonly (LazyRouteDefinition | RouteDefinition)[],
): readonly PreparedRoute[] {
  const patterns = new Set<string>();
  for (const definition of definitions) {
    if (patterns.has(definition.compiled.pattern)) {
      throw new Error(`Duplicate route matcher for ${definition.config.path}`);
    }
    patterns.add(definition.compiled.pattern);
  }
  return definitions
    .toSorted((left, right) =>
      compareRouteSpecificity(
        { path: left.config.path, compiled: left.compiled },
        { path: right.config.path, compiled: right.compiled },
      ),
    )
    .map((definition) => ({
      definition,
      matcher: new RegExp(definition.compiled.pattern),
    }));
}

let preparedRoutes: readonly PreparedRoute[] = [];

/** Installs the compiler-generated route manifest before application rendering starts. */
export function configureRouterRoutes(definitions: unknown): void | Promise<void> {
  if (!Array.isArray(definitions)) throw new TypeError("Router routes must be an array");
  for (const definition of definitions) {
    if (
      !isRouteDefinition(definition) &&
      !(
        definition &&
        typeof definition === "object" &&
        typeof (definition as Partial<LazyRouteDefinition>).load === "function"
      )
    ) {
      throw new TypeError("Router routes must contain compiled route definitions");
    }
  }
  preparedRoutes = prepareRoutes(definitions as Array<LazyRouteDefinition | RouteDefinition>);
  return synchronizeLocation();
}

function decodeParameter(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchRoute(pathname: string, searchParams?: URLSearchParams): RouteMatch | null {
  try {
    pathname = canonicalizePathname(pathname);
  } catch {
    return null;
  }
  for (const { definition, matcher } of preparedRoutes) {
    const match = matcher.exec(pathname);
    if (!match) continue;
    const params: Record<string, string | undefined> = {};
    for (const [index, name] of definition.compiled.pathnameParameterNames.entries()) {
      defineRouteValue(params, name, decodeParameter(match[index + 1] ?? ""));
    }
    if (searchParams) {
      let queryMatches = true;
      for (const queryParameter of definition.compiled.queryParameters) {
        const value = searchParams.getAll(queryParameter.key).at(-1);
        if (
          value !== undefined &&
          Object.hasOwn(params, queryParameter.name) &&
          params[queryParameter.name] !== value
        ) {
          queryMatches = false;
          break;
        }
        if (!Object.hasOwn(params, queryParameter.name)) {
          defineRouteValue(params, queryParameter.name, value);
        }
      }
      if (!queryMatches) continue;
    }
    return { definition, params: Object.freeze(params) };
  }
  return null;
}

function resolveDefinition(
  location: RouterState,
  definition: RouteDefinition,
  params: RawRouteParams,
): RouterState | PromiseLike<RouterState> {
  const result = resolveRoute(definition, params);
  if (isPromiseLike(result)) {
    return Promise.resolve(result).then((resolution) =>
      resolution.matched
        ? resolvedState(location, definition, resolution.values)
        : unmatchedState(location),
    );
  }
  return result.matched
    ? resolvedState(location, definition, result.values)
    : unmatchedState(location);
}

function resolveLocation(location: RouterState): RouterState | PromiseLike<RouterState> {
  if (!location.matchesBase) return unmatchedState(location);
  const match = matchRoute(location.pathname, location.searchParams);
  if (!match) return unmatchedState(location);
  if (isRouteDefinition(match.definition)) {
    return resolveDefinition(location, match.definition, match.params);
  }
  return match.definition
    .load()
    .then((definition) => resolveDefinition(location, definition, match.params));
}

function currentState(frame = runtimeState.activeFrame): RouterState {
  const url = frame?.url;
  if (!url) return state.value;
  const existing = serverStates.get(url);
  if (existing) return existing;
  const location = readLocation(frame);
  const resolution = resolveLocation(location);
  if (!isPromiseLike(resolution)) {
    serverStates.set(url, resolution);
    return resolution;
  }
  const initial = { ...unmatchedState(location), status: "pending" as const };
  void Promise.resolve(resolution).then(
    (resolved) => serverStates.set(url, resolved),
    (error: unknown) =>
      serverStates.set(url, { ...unmatchedState(location), status: "error", error }),
  );
  serverStates.set(url, initial);
  return initial;
}

function unmatchedState(location: RouterState): RouterState {
  return {
    ...location,
    values: null,
    route: null,
    pattern: null,
    definition: null,
    status: "ready",
    error: undefined,
  };
}

function resolvedState(
  location: RouterState,
  definition: RouteDefinition,
  values: RouteValues,
): RouterState {
  return {
    ...location,
    values,
    route: definition.config,
    pattern: definition.compiled.pattern,
    definition,
    status: "ready",
    error: undefined,
  };
}

let resolutionId = 0;

function synchronizeLocation(): void | Promise<void> {
  const currentResolution = ++resolutionId;
  const location = readLocation();
  if (!location.matchesBase) {
    setRouterState(unmatchedState(location));
    return;
  }
  const match = matchRoute(location.pathname, location.searchParams);
  if (!match) {
    setRouterState(unmatchedState(location));
    return;
  }

  let resolution: RouterState | PromiseLike<RouterState>;
  try {
    resolution = resolveLocation(location);
  } catch (error) {
    setRouterState({ ...unmatchedState(location), status: "error", error });
    return;
  }
  if (!isPromiseLike(resolution)) {
    setRouterState(resolution);
    return;
  }
  setRouterState({ ...unmatchedState(location), status: "pending" });
  return Promise.resolve(resolution).then(
    (resolved) => {
      if (currentResolution !== resolutionId) return;
      setRouterState(resolved);
    },
    (error: unknown) => {
      if (currentResolution !== resolutionId) return;
      setRouterState({ ...unmatchedState(location), status: "error", error });
    },
  );
}

/** Resolves once the browser's initial route parameters are ready for hydration. */
export const routerReady: Promise<void> = Promise.resolve(synchronizeLocation());

/** Configures the root-relative path where browser routes are deployed. */
export function configureRouterBase(base: unknown): void | Promise<void> {
  configureRouteBase(base);
  return synchronizeLocation();
}

function navigate(path: string, options: NavigateOptions = {}): void {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("router.navigate() expects a same-origin root-relative path");
  }
  if (typeof window === "undefined") {
    throw new Error("router.navigate() requires a browser window");
  }
  if (
    !options ||
    typeof options !== "object" ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new TypeError("router.navigate() options must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const unexpected = Reflect.ownKeys(descriptors).find((name) => name !== "replace");
  if (unexpected)
    throw new TypeError(`router.navigate() options contain unknown property ${String(unexpected)}`);
  const replaceDescriptor = Object.hasOwn(descriptors, "replace") ? descriptors.replace : undefined;
  if (replaceDescriptor && !("value" in replaceDescriptor)) {
    throw new TypeError("router.navigate() options replace must be a data property");
  }
  const replace = replaceDescriptor?.value as unknown;
  if (replace !== undefined && typeof replace !== "boolean") {
    throw new TypeError("router.navigate() options replace must be a boolean");
  }
  const destination = new URL(path, window.location.origin);
  if (destination.origin !== window.location.origin) {
    throw new TypeError("router.navigate() only supports same-origin paths");
  }
  const deployed = `${deployedPath(destination.pathname)}${destination.search}${destination.hash}`;
  if (navigationMode === "document") {
    if (replace) window.location.replace(deployed);
    else window.location.assign(deployed);
    return;
  }
  const method = replace ? "replaceState" : "pushState";
  window.history[method](null, "", deployed);
  void synchronizeLocation();
}

export const router: Router = registerRouter(
  Object.freeze({
    get pathname() {
      return currentState().pathname;
    },
    get search() {
      return currentState().search;
    },
    get hash() {
      return currentState().hash;
    },
    get searchParams() {
      return new URLSearchParams(currentState().searchParams);
    },
    get params() {
      return currentState().values ?? EMPTY_ROUTE_VALUES;
    },
    get query() {
      return currentState().values ?? EMPTY_ROUTE_VALUES;
    },
    get route() {
      return currentState().route;
    },
    navigate,
  }),
);

configureRouteRuntime({
  getParams(definition, frame) {
    const current = currentState(frame);
    if (current.pattern !== definition.compiled.pattern || !current.values) {
      throw new Error("Cannot read values from an inactive route");
    }
    return current.values;
  },
  getPathname(frame) {
    return currentState(frame).pathname;
  },
  isActive(definition, frame) {
    return currentState(frame).pattern === definition.compiled.pattern;
  },
  readRouter(key, frame) {
    const current = currentState(frame);
    if (key === "params" || key === "query") return current.values ?? EMPTY_ROUTE_VALUES;
    if (key === "route") return current.route;
    if (key === "searchParams") return new URLSearchParams(current.searchParams);
    return current[key];
  },
  navigate,
});

configureServerRenderPreparation((frame) => {
  const url = frame.url;
  if (!url) return undefined;
  const resolution = resolveLocation(readLocation(frame));
  if (!isPromiseLike(resolution)) {
    serverStates.set(url, resolution);
    return undefined;
  }
  return Promise.resolve(resolution).then((resolved) => {
    serverStates.set(url, resolved);
  });
});

function listenForNavigation(): () => void {
  const handlePopState = (): void => {
    void synchronizeLocation();
  };
  const handleClick = (event: MouseEvent): void => {
    if (navigationMode === "document") return;
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    const anchor = origin.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    if (!href?.startsWith("/") || href.startsWith("//")) return;
    const target = anchor.getAttribute("target");
    if (target && target.toLowerCase() !== "_self") return;
    const destination = new URL(anchor.href, window.location.href);
    if (destination.origin !== window.location.origin) return;
    const pathname = logicalPathname(destination.pathname);
    if (!pathname) return;
    event.preventDefault();
    navigate(`${pathname}${destination.search}${destination.hash}`);
  };
  window.addEventListener("popstate", handlePopState);
  window.addEventListener("hashchange", handlePopState);
  document.addEventListener("click", handleClick);
  return () => {
    window.removeEventListener("popstate", handlePopState);
    window.removeEventListener("hashchange", handlePopState);
    document.removeEventListener("click", handleClick);
  };
}

if (typeof window !== "undefined") listenForNavigation();

const routeTemplate = template("<!--sol:s:0--><!--sol:e:0-->", "tsolroute", {
  elements: [],
  regionCount: 1,
  propertyValueElements: [],
});

function renderRouteComponent(candidate: Component, frame: RenderFrame, region: Region): Block {
  const claim = regionHydrationClaim(region);
  return renderComponent(candidate, undefined, claim ? { ...frame, claim } : frame);
}

export const Route = component((props: Readonly<{ pending?: Component }>, frame) => {
  const view = instantiate(routeTemplate, frame);
  const cleanups: Array<() => void> = [];
  let active: Block | undefined;
  let outgoing: Block | undefined;
  let activeDefinition: RouteDefinition | undefined;
  let initialized = false;
  let activeLocation: string | undefined;
  let activeStatus: RouterState["status"] | undefined;

  const fail = (error: unknown): void => {
    const failedActive = active;
    const failedOutgoing = outgoing;
    active = undefined;
    outgoing = undefined;
    let reported = error;
    try {
      runDisposals([() => failedActive?.dispose(), () => failedOutgoing?.dispose()]);
    } catch (cleanupError) {
      reported = new AggregateError([error, cleanupError], "Route failure cleanup also failed", {
        cause: error,
      });
    }
    reportError(frame, reported);
  };

  if (frame.mode === "server") {
    const location = readLocation(frame);
    const resolution = (frame.url && serverStates.get(frame.url)) ?? resolveLocation(location);
    const render = (resolved: RouterState): Block => {
      if (frame.url) serverStates.set(frame.url, resolved);
      const region = view.regions[0]!;
      const renderedRoute = resolved.definition
        ? renderRouteComponent(resolved.definition.component, frame, region)
        : undefined;
      if (!isServerRegion(region)) throw new Error("Expected a server route region");
      renderedRoute?.mount(region);
      return block(view.fragment, renderedRoute ? [() => renderedRoute.dispose()] : []);
    };
    return isPromiseLike(resolution)
      ? Promise.resolve(resolution).then(render)
      : render(resolution);
  }

  cleanups.push(
    runtimeEffect(() => {
      const location = state.value;
      const definition = location.definition;
      const locationKey = `${location.pathname}${location.search}`;
      if (
        activeDefinition === definition &&
        activeLocation === locationKey &&
        activeStatus === location.status
      )
        return;
      activeDefinition = definition ?? undefined;
      activeLocation = locationKey;
      activeStatus = location.status;
      if (location.status === "error") {
        fail(location.error);
        return;
      }
      try {
        const previousOutgoing = outgoing;
        outgoing = undefined;
        previousOutgoing?.dispose();
        if (active) {
          const previous = active;
          const finished = previous.retire();
          active = undefined;
          if (finished) {
            outgoing = previous;
            settleRetirement(
              finished,
              () => {
                if (outgoing === previous) outgoing = undefined;
              },
              fail,
            );
          }
        }
        active =
          location.status === "pending"
            ? props.pending
              ? renderRouteComponent(props.pending, frame, view.regions[0]!)
              : undefined
            : definition
              ? renderRouteComponent(definition.component, frame, view.regions[0]!)
              : undefined;
        const region = view.regions[0]!;
        if (isServerRegion(region)) throw new Error("Expected a browser route region");
        active?.mount(region.end.parentNode!, region.end);
        if (initialized) active?.enter();
        initialized = true;
      } catch (error) {
        fail(error);
      }
    }),
    () => {
      runDisposals([() => active?.dispose(), () => outgoing?.dispose()]);
    },
  );
  return block(view.fragment, cleanups);
});
