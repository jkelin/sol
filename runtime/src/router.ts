// oxlint-disable-next-line typescript/triple-slash-reference -- Vite provides this virtual module.
/// <reference path="./virtual-routes.d.ts" />

import routes from "virtual:sol/routes";
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
  renderComponent,
  template,
  type Block,
  type Region,
  type RenderFrame,
} from "./rendering.ts";
import {
  canonicalizePathname,
  resolveRoute,
  type NavigateOptions,
  type RawRouteParams,
  type RouteConfig,
  type RouteDefinition,
  type RouteValues,
} from "./routes.ts";
import { isServerRegion } from "./server-rendering.ts";

export interface Router {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly searchParams: URLSearchParams;
  readonly params: Readonly<Record<string, string | number | undefined>>;
  readonly query: Readonly<Record<string, string | number | undefined>>;
  readonly route: RouteConfig | null;
  navigate(path: string, options?: NavigateOptions): void;
}

interface RouterState {
  pathname: string;
  search: string;
  hash: string;
  searchParams: URLSearchParams;
  values: RouteValues | null;
  route: RouteConfig | null;
  pattern: string | null;
  status: "ready" | "pending" | "error";
  error: unknown;
}

interface RouteMatch {
  definition: RouteDefinition;
  params: RawRouteParams;
}

interface PreparedRoute {
  readonly definition: RouteDefinition;
  readonly matcher: RegExp;
}

function readLocation(frame?: RenderFrame): RouterState {
  const location = frame?.url ?? (typeof window === "undefined" ? null : window.location);
  const search = location?.search ?? "";
  return {
    pathname: location?.pathname ?? "/",
    search,
    hash: location?.hash ?? "",
    searchParams: new URLSearchParams(search),
    values: null,
    route: null,
    pattern: null,
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

function compareRoutes(left: RouteDefinition, right: RouteDefinition): number {
  const length = Math.max(left.compiled.specificity.length, right.compiled.specificity.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (right.compiled.specificity[index] ?? -1) - (left.compiled.specificity[index] ?? -1);
    if (difference) return difference;
  }
  return left.config.path.localeCompare(right.config.path);
}

function prepareRoutes(definitions: readonly RouteDefinition[]): readonly PreparedRoute[] {
  const patterns = new Set<string>();
  for (const definition of definitions) {
    if (patterns.has(definition.compiled.pattern)) {
      throw new Error(`Duplicate route matcher for ${definition.config.path}`);
    }
    patterns.add(definition.compiled.pattern);
  }
  return definitions.toSorted(compareRoutes).map((definition) => ({
    definition,
    matcher: new RegExp(definition.compiled.pattern),
  }));
}

const preparedRoutes = prepareRoutes(routes);

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
      params[name] = decodeParameter(match[index + 1] ?? "");
    }
    if (searchParams) {
      let queryMatches = true;
      for (const queryParameter of definition.compiled.queryParameters) {
        const value = searchParams.getAll(queryParameter.key).at(-1);
        if (
          value !== undefined &&
          queryParameter.name in params &&
          params[queryParameter.name] !== value
        ) {
          queryMatches = false;
          break;
        }
        if (!(queryParameter.name in params)) params[queryParameter.name] = value;
      }
      if (!queryMatches) continue;
    }
    return { definition, params: Object.freeze(params) };
  }
  return null;
}

function resolveLocation(location: RouterState): RouterState | PromiseLike<RouterState> {
  const match = matchRoute(location.pathname, location.searchParams);
  if (!match) return unmatchedState(location);
  const result = resolveRoute(match.definition, match.params);
  if (result && typeof result === "object" && "then" in result) {
    return Promise.resolve(result).then((resolution) =>
      resolution.matched
        ? resolvedState(location, match, resolution.values)
        : unmatchedState(location),
    );
  }
  return result.matched ? resolvedState(location, match, result.values) : unmatchedState(location);
}

function currentState(): RouterState {
  const url = runtimeState.activeFrame?.url;
  if (!url) return state.value;
  const existing = serverStates.get(url);
  if (existing) return existing;
  const location = readLocation(runtimeState.activeFrame);
  const resolved = resolveLocation(location);
  const initial =
    resolved && typeof resolved === "object" && "then" in resolved
      ? { ...unmatchedState(location), status: "pending" as const }
      : resolved;
  serverStates.set(url, initial);
  return initial;
}

function unmatchedState(location: RouterState): RouterState {
  return {
    ...location,
    values: null,
    route: null,
    pattern: null,
    status: "ready",
    error: undefined,
  };
}

function resolvedState(location: RouterState, match: RouteMatch, values: RouteValues): RouterState {
  return {
    ...location,
    values,
    route: match.definition.config,
    pattern: match.definition.compiled.pattern,
    status: "ready",
    error: undefined,
  };
}

let resolutionId = 0;

function synchronizeLocation(): void | Promise<void> {
  const currentResolution = ++resolutionId;
  const location = readLocation();
  const match = matchRoute(location.pathname, location.searchParams);
  if (!match) {
    setRouterState(unmatchedState(location));
    return;
  }

  let result;
  try {
    result = resolveRoute(match.definition, match.params);
  } catch (error) {
    setRouterState({ ...unmatchedState(location), status: "error", error });
    return;
  }

  if (!(result && typeof result === "object" && "then" in result)) {
    setRouterState(
      result.matched ? resolvedState(location, match, result.values) : unmatchedState(location),
    );
    return;
  }

  setRouterState({ ...unmatchedState(location), status: "pending" });
  return Promise.resolve(result).then(
    (resolution) => {
      if (currentResolution !== resolutionId) return;
      setRouterState(
        resolution.matched
          ? resolvedState(location, match, resolution.values)
          : unmatchedState(location),
      );
    },
    (error: unknown) => {
      if (currentResolution !== resolutionId) return;
      setRouterState({ ...unmatchedState(location), status: "error", error });
    },
  );
}

/** Resolves once the browser's initial route parameters are ready for hydration. */
export const routerReady: Promise<void> = Promise.resolve(synchronizeLocation());

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
  const unexpected = Reflect.ownKeys(options).find((name) => name !== "replace");
  if (unexpected)
    throw new TypeError(`router.navigate() options contain unknown property ${String(unexpected)}`);
  if (options.replace !== undefined && typeof options.replace !== "boolean") {
    throw new TypeError("router.navigate() options replace must be a boolean");
  }
  const destination = new URL(path, window.location.origin);
  if (destination.origin !== window.location.origin) {
    throw new TypeError("router.navigate() only supports same-origin paths");
  }
  const method = options.replace ? "replaceState" : "pushState";
  window.history[method](
    null,
    "",
    `${destination.pathname}${destination.search}${destination.hash}`,
  );
  void synchronizeLocation();
}

export const router: Router = Object.freeze({
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
    return currentState().searchParams;
  },
  get params() {
    return currentState().values ?? Object.freeze({});
  },
  get query() {
    return currentState().values ?? Object.freeze({});
  },
  get route() {
    return currentState().route;
  },
  navigate,
});

configureRouteRuntime({
  getParams(definition) {
    const current = currentState();
    if (current.pattern !== definition.compiled.pattern || !current.values) {
      throw new Error("Cannot read values from an inactive route");
    }
    return current.values;
  },
  getPathname() {
    return currentState().pathname;
  },
  isActive(definition) {
    return currentState().pattern === definition.compiled.pattern;
  },
  navigate,
});

configureServerRenderPreparation((frame) => {
  const url = frame.url;
  if (!url) return undefined;
  const resolution = resolveLocation(readLocation(frame));
  if (isPromiseLike(resolution)) {
    return Promise.resolve(resolution).then((resolved) => {
      serverStates.set(url, resolved);
    });
  }
  serverStates.set(url, resolution);
  return undefined;
});

function listenForNavigation(): () => void {
  const handlePopState = (): void => {
    void synchronizeLocation();
  };
  const handleClick = (event: MouseEvent): void => {
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
    event.preventDefault();
    navigate(`${destination.pathname}${destination.search}${destination.hash}`);
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

  if (frame.mode === "server") {
    const location = readLocation(frame);
    const resolution = (frame.url && serverStates.get(frame.url)) ?? resolveLocation(location);
    const render = (resolved: RouterState): Block => {
      if (frame.url) serverStates.set(frame.url, resolved);
      const match = resolved.pattern ? matchRoute(resolved.pathname, resolved.searchParams) : null;
      const region = view.regions[0]!;
      const renderedRoute = match
        ? renderRouteComponent(match.definition.component, frame, region)
        : undefined;
      if (!isServerRegion(region)) throw new Error("Expected a server route region");
      renderedRoute?.mount(region);
      return block(view.fragment, renderedRoute ? [() => renderedRoute.dispose()] : []);
    };
    return resolution && typeof resolution === "object" && "then" in resolution
      ? Promise.resolve(resolution).then(render)
      : render(resolution);
  }

  cleanups.push(
    runtimeEffect(() => {
      const location = state.value;
      if (location.status === "error") throw location.error;
      const match = location.pattern ? matchRoute(location.pathname) : null;
      const locationKey = `${location.pathname}${location.search}`;
      if (
        activeDefinition === match?.definition &&
        activeLocation === locationKey &&
        activeStatus === location.status
      )
        return;
      activeDefinition = match?.definition;
      activeLocation = locationKey;
      activeStatus = location.status;
      outgoing?.dispose();
      outgoing = undefined;
      if (active) {
        const previous = active;
        const finished = previous.retire();
        if (finished) {
          outgoing = previous;
          void finished.then(() => {
            if (outgoing === previous) outgoing = undefined;
          });
        }
      }
      active =
        location.status === "pending"
          ? props.pending
            ? renderRouteComponent(props.pending, frame, view.regions[0]!)
            : undefined
          : match
            ? renderRouteComponent(match.definition.component, frame, view.regions[0]!)
            : undefined;
      const region = view.regions[0]!;
      if (isServerRegion(region)) throw new Error("Expected a browser route region");
      active?.mount(region.end.parentNode!, region.end);
      if (initialized) active?.enter();
      initialized = true;
    }),
    () => {
      runDisposals([() => active?.dispose(), () => outgoing?.dispose()]);
    },
  );
  return block(view.fragment, cleanups);
});
