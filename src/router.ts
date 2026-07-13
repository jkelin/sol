import routes from "virtual:frontend-framework/routes";
import {
  $signal,
  block,
  component,
  configureRouteRuntime,
  instantiate,
  renderComponent,
  runtimeEffect,
  template,
  type Block,
  type NavigateOptions,
  type RouteConfig,
  type RouteDefinition,
} from "./runtime.ts";

export interface Router {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly searchParams: URLSearchParams;
  readonly params: Readonly<Record<string, string>>;
  readonly route: RouteConfig | null;
  navigate(path: string, options?: NavigateOptions): void;
}

interface RouterState {
  pathname: string;
  search: string;
  hash: string;
  searchParams: URLSearchParams;
  params: Readonly<Record<string, string>>;
  route: RouteConfig | null;
  pattern: string | null;
}

interface RouteMatch {
  definition: RouteDefinition;
  params: Readonly<Record<string, string>>;
}

function readLocation(): RouterState {
  if (typeof window === "undefined") {
    return {
      pathname: "/",
      search: "",
      hash: "",
      searchParams: new URLSearchParams(),
      params: Object.freeze({}),
      route: null,
      pattern: null,
    };
  }
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    searchParams: new URLSearchParams(window.location.search),
    params: Object.freeze({}),
    route: null,
    pattern: null,
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

function matchRoute(pathname: string): RouteMatch | null {
  for (const definition of preparedRoutes) {
    const match = new RegExp(definition.compiled.pattern).exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    for (const [index, name] of definition.compiled.parameterNames.entries()) {
      params[name] = decodeParameter(match[index + 1] ?? "");
    }
    return { definition, params: Object.freeze(params) };
  }
  return null;
}

function matchLocation(location: RouterState): RouterState {
  const match = matchRoute(location.pathname);
  return {
    ...location,
    params: match?.params ?? Object.freeze({}),
    route: match?.definition.config ?? null,
    pattern: match?.definition.compiled.pattern ?? null,
  };
}

function synchronizeLocation(): void {
  state.value = matchLocation(readLocation());
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
    return state.value.params;
  },
  get route() {
    return state.value.route;
  },
  navigate,
});

configureRouteRuntime({
  getParams(definition) {
    const current = state.value;
    if (current.pattern !== definition.compiled.pattern) {
      throw new Error("Cannot read params from an inactive route");
    }
    return current.params;
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

export const Route = component(() => {
  const view = instantiate(routeTemplate);
  const cleanups: Array<() => void> = [];
  let active: Block | undefined;
  let activeDefinition: RouteDefinition | undefined;
  let activePathname: string | undefined;

  cleanups.push(listenForNavigation());
  cleanups.push(
    runtimeEffect(() => {
      const location = state.value;
      const match = matchRoute(location.pathname);
      if (activeDefinition === match?.definition && activePathname === location.pathname) return;
      activeDefinition = match?.definition;
      activePathname = location.pathname;
      active?.dispose();
      active = match ? renderComponent(match.definition.component) : undefined;
      active?.mount(view.regions[0]!.end.parentNode!, view.regions[0]!.end);
    }),
    () => active?.dispose(),
  );
  return block(view.fragment, cleanups);
});
