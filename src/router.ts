import routes from "virtual:frontend-framework/routes";
import {
  $signal,
  block,
  component,
  configureRouteRuntime,
  instantiate,
  resolveRoute,
  renderComponent,
  runtimeEffect,
  template,
  type Block,
  type Component,
  type NavigateOptions,
  type RouteConfig,
  type RouteDefinition,
  type RouteValues,
} from "./runtime.ts";

export interface Router {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly searchParams: URLSearchParams;
  readonly params: Readonly<Record<string, string | number>>;
  readonly query: Readonly<Record<string, string | number>>;
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
  params: Readonly<Record<string, string>>;
}

function readLocation(): RouterState {
  const location = typeof window === "undefined" ? null : window.location;
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

function compareRoutes(left: RouteDefinition, right: RouteDefinition): number {
  const length = Math.max(left.compiled.specificity.length, right.compiled.specificity.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (right.compiled.specificity[index] ?? -1) - (left.compiled.specificity[index] ?? -1);
    if (difference) return difference;
  }
  return left.config.path.localeCompare(right.config.path);
}

function prepareRoutes(definitions: readonly RouteDefinition[]): readonly RouteDefinition[] {
  const patterns = new Set<string>();
  for (const definition of definitions) {
    if (patterns.has(definition.compiled.pattern)) {
      throw new Error(`Duplicate route matcher for ${definition.config.path}`);
    }
    patterns.add(definition.compiled.pattern);
  }
  return definitions.toSorted(compareRoutes);
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
  for (const definition of preparedRoutes) {
    const match = new RegExp(definition.compiled.pattern).exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    for (const [index, name] of definition.compiled.pathnameParameterNames.entries()) {
      params[name] = decodeParameter(match[index + 1] ?? "");
    }
    if (searchParams) {
      let queryMatches = true;
      for (const queryParameter of definition.compiled.queryParameters) {
        const value = searchParams.getAll(queryParameter.key).at(-1);
        if (
          value === undefined ||
          (queryParameter.name in params && params[queryParameter.name] !== value)
        ) {
          queryMatches = false;
          break;
        }
        params[queryParameter.name] = value;
      }
      if (!queryMatches) continue;
    }
    return { definition, params: Object.freeze(params) };
  }
  return null;
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

function synchronizeLocation(): void {
  const currentResolution = ++resolutionId;
  const location = readLocation();
  const match = matchRoute(location.pathname, location.searchParams);
  if (!match) {
    state.value = unmatchedState(location);
    return;
  }

  let result;
  try {
    result = resolveRoute(match.definition, match.params);
  } catch (error) {
    state.value = { ...unmatchedState(location), status: "error", error };
    return;
  }

  if (!(result && typeof result === "object" && "then" in result)) {
    state.value = result.matched
      ? resolvedState(location, match, result.values)
      : unmatchedState(location);
    return;
  }

  state.value = { ...unmatchedState(location), status: "pending" };
  void Promise.resolve(result).then(
    (resolution) => {
      if (currentResolution !== resolutionId) return;
      state.value = resolution.matched
        ? resolvedState(location, match, resolution.values)
        : unmatchedState(location);
    },
    (error: unknown) => {
      if (currentResolution !== resolutionId) return;
      state.value = { ...unmatchedState(location), status: "error", error };
    },
  );
}

synchronizeLocation();

function navigate(path: string, options: NavigateOptions = {}): void {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("router.navigate() expects a same-origin root-relative path");
  }
  if (typeof window === "undefined") {
    throw new Error("router.navigate() requires a browser window");
  }
  if (!options || typeof options !== "object") {
    throw new TypeError("router.navigate() options must be an object");
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
  synchronizeLocation();
}

export const router: Router = Object.freeze({
  get pathname() {
    return state.value.pathname;
  },
  get search() {
    return state.value.search;
  },
  get hash() {
    return state.value.hash;
  },
  get searchParams() {
    return state.value.searchParams;
  },
  get params() {
    return state.value.values ?? Object.freeze({});
  },
  get query() {
    return state.value.values ?? Object.freeze({});
  },
  get route() {
    return state.value.route;
  },
  navigate,
});

configureRouteRuntime({
  getParams(definition) {
    const current = state.value;
    if (current.pattern !== definition.compiled.pattern || !current.values) {
      throw new Error("Cannot read values from an inactive route");
    }
    return current.values;
  },
  getPathname() {
    return state.value.pathname;
  },
  isActive(definition) {
    return state.value.pattern === definition.compiled.pattern;
  },
  navigate,
});

function listenForNavigation(): () => void {
  const handlePopState = (): void => synchronizeLocation();
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
  document.addEventListener("click", handleClick);
  return () => {
    window.removeEventListener("popstate", handlePopState);
    document.removeEventListener("click", handleClick);
  };
}

const routeTemplate = template("<!--ff:s:0--><!--ff:e:0-->");

export const Route = component((props: Readonly<{ pending?: Component }>) => {
  const view = instantiate(routeTemplate);
  const cleanups: Array<() => void> = [];
  let active: Block | undefined;
  let outgoing: Block | undefined;
  let activeDefinition: RouteDefinition | undefined;
  let initialized = false;
  let activeLocation: string | undefined;
  let activeStatus: RouterState["status"] | undefined;

  cleanups.push(listenForNavigation());
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
            ? renderComponent(props.pending)
            : undefined
          : match
            ? renderComponent(match.definition.component)
            : undefined;
      active?.mount(view.regions[0]!.end.parentNode!, view.regions[0]!.end);
      if (initialized) active?.enter();
      initialized = true;
    }),
    () => {
      active?.dispose();
      outgoing?.dispose();
    },
  );
  return block(view.fragment, cleanups);
});
