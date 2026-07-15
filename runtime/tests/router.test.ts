import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Component } from "../src/components.ts";
import { $signal } from "../src/reactivity.ts";
import { installDevtools } from "../src/devtools.ts";
import { mount, rootFrame } from "../src/rendering.ts";
import { renderToStringAsync } from "../src/ssr.ts";
import { transition } from "../src/transitions.ts";
import {
  block,
  component,
  errorBoundary,
  instantiate,
  lazyRoute,
  renderComponent,
  route,
  routeObject,
  routeRead,
  template,
  text,
} from "../src/compiler-runtime.ts";

interface ControlledAnimation {
  animation: Animation;
  cancelled: boolean;
  finish(): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLSelectElement: window.HTMLSelectElement,
  KeyboardEvent: window.KeyboardEvent,
});

const animations: ControlledAnimation[] = [];
const current = new WeakMap<Element, { signature: string; controlled: ControlledAnimation }>();
Object.defineProperty(window.Element.prototype, "getAnimations", {
  configurable: true,
  value(this: Element): Animation[] {
    const signature = [...this.classList]
      .filter((className) => className.startsWith("route-"))
      .join(" ");
    if (!signature) return [];
    const existing = current.get(this);
    if (existing?.signature === signature) return [existing.controlled.animation];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const controlled: ControlledAnimation = {
      animation: undefined as unknown as Animation,
      cancelled: false,
      finish,
    };
    controlled.animation = {
      finished,
      cancel() {
        controlled.cancelled = true;
        finish();
      },
    } as unknown as Animation;
    animations.push(controlled);
    current.set(this, { signature, controlled });
    return [controlled.animation];
  },
});

const firstValue = $signal("First");

function page(label: string, animated: boolean, reactive = false): Component {
  const definition = template(
    reactive
      ? '<section data-sol-e="0" data-page="first"><!--sol:s:0--><!--sol:e:0--></section>'
      : `<section data-sol-e="0" data-page="${label.toLowerCase()}">${label}</section>`,
    `route-${label}`,
    {
      elements: ["section"],
      regionCount: reactive ? 1 : 0,
      propertyValueElements: [],
    },
  );
  return component((_props, frame) => {
    const view = instantiate(definition, frame);
    const cleanups: Array<() => void> = [];
    if (animated) {
      transition(view.elements[0]!, () => ({
        enter: "route-enter",
        leave: "route-leave",
      }));
    }
    if (reactive) text(view.regions[0]!, () => firstValue.value, cleanups);
    return block(view.fragment, cleanups);
  });
}

const First = page("First", true, true);
const Second = page("Second", true);
const Plain = page("Plain", false);
const Async = page("Async", false);
const Lazy = page("Lazy", false);
const Slow = page("Slow", false);
const Fast = page("Fast", false);
const Pending = page("Pending", false);
const routeRetirement = deferred<void>();
const RejectingRetirement = component((_props, frame) => {
  const view = instantiate(
    template('<section data-page="rejecting-retirement">Retiring</section>', "trejectretire"),
    frame,
  );
  const rendered = block(view.fragment);
  return { ...rendered, retire: () => routeRetirement.promise };
});
const pageFailure = new Error("Page render failed");
const Throwing = component(() => {
  throw pageFailure;
});
const unicodeRoute = route({ path: "/café" }, Plain, {
  pattern: "^/caf%C3%A9$",
  parameterNames: [],
  pathnameParameterNames: [],
  queryParameters: [],
  specificity: [1],
});
const prototypeRoute = route({ path: "/:__proto__" }, Plain, {
  pattern: "^/([^/]+)$",
  parameterNames: ["__proto__"],
  pathnameParameterNames: ["__proto__"],
  queryParameters: [],
  specificity: [0],
});
const asyncRoute = route(
  {
    path: "/async/:id",
    schema: async (raw: Readonly<Record<string, string | undefined>>) => ({
      id: Number(raw.id),
    }),
  },
  Async,
  {
    pattern: "^/async/([^/]+)$",
    parameterNames: ["id"],
    pathnameParameterNames: ["id"],
    queryParameters: [],
    specificity: [1, 2],
  },
);
const lazyMetadata = {
  pattern: "^/lazy/([^/]+)$",
  parameterNames: ["id"],
  pathnameParameterNames: ["id"],
  queryParameters: [],
  specificity: [1, 0],
} as const;
let lazySchemaCalls = 0;
let lazyLoadCalls = 0;
const lazyImplementation = route(
  {
    path: "/lazy/:id",
    schema(raw: Readonly<Record<string, string | undefined>>) {
      lazySchemaCalls += 1;
      return { id: Number(raw.id) };
    },
  },
  Lazy,
  lazyMetadata,
);
const lazyRequest = deferred<unknown>();
const lazyDefinition = lazyRoute("/lazy/:id", lazyMetadata, () => {
  lazyLoadCalls += 1;
  return lazyRequest.promise;
});

function staticMetadata(path: string) {
  return {
    pattern: `^${path}$`,
    parameterNames: [],
    pathnameParameterNames: [],
    queryParameters: [],
    specificity: [1],
  } as const;
}

const slowRequest = deferred<unknown>();
const fastRequest = deferred<unknown>();
const slowMetadata = staticMetadata("/slow-lazy");
const fastMetadata = staticMetadata("/fast-lazy");
const failedMetadata = staticMetadata("/failed-lazy");
const pendingMetadata = staticMetadata("/pending-lazy");
const ssrMetadata = staticMetadata("/ssr-lazy");
const initialMetadata = staticMetadata("/initial-lazy");
let ssrLoadCalls = 0;
let initialLoadCalls = 0;
const failedLoad = new Error("Route chunk failed");
const failedDefinition = lazyRoute("/failed-lazy", failedMetadata, () =>
  Promise.reject(failedLoad),
);
const routes = [
  route({ path: "/" }, First, {
    pattern: "^/$",
    parameterNames: [],
    pathnameParameterNames: [],
    queryParameters: [],
    specificity: [],
  }),
  route({ path: "/second" }, Second, {
    pattern: "^/second$",
    parameterNames: [],
    pathnameParameterNames: [],
    queryParameters: [],
    specificity: [1],
  }),
  route({ path: "/plain" }, Plain, {
    pattern: "^/plain$",
    parameterNames: [],
    pathnameParameterNames: [],
    queryParameters: [],
    specificity: [1],
  }),
  route({ path: "/throwing" }, Throwing, {
    pattern: "^/throwing$",
    parameterNames: [],
    pathnameParameterNames: [],
    queryParameters: [],
    specificity: [1],
  }),
  route({ path: "/rejecting-retirement" }, RejectingRetirement, {
    pattern: "^/rejecting-retirement$",
    parameterNames: [],
    pathnameParameterNames: [],
    queryParameters: [],
    specificity: [1],
  }),
  unicodeRoute,
  prototypeRoute,
  route({ path: "/a!" }, Plain, {
    pattern: "^/a!$",
    parameterNames: [],
    pathnameParameterNames: [],
    queryParameters: [],
    specificity: [1],
  }),
  asyncRoute,
  lazyDefinition,
  lazyRoute("/slow-lazy", slowMetadata, () => slowRequest.promise),
  lazyRoute("/fast-lazy", fastMetadata, () => fastRequest.promise),
  failedDefinition,
  lazyRoute("/pending-lazy", pendingMetadata, () => new Promise<never>(() => undefined)),
  lazyRoute("/ssr-lazy", ssrMetadata, async () => {
    ssrLoadCalls += 1;
    return route({ path: "/ssr-lazy" }, Lazy, ssrMetadata);
  }),
  lazyRoute("/initial-lazy", initialMetadata, async () => {
    initialLoadCalls += 1;
    return route({ path: "/initial-lazy" }, Lazy, initialMetadata);
  }),
];

window.history.replaceState(null, "", "/initial-lazy");
await mock.module("virtual:sol/routes", () => ({ default: routes }));
const devtools = installDevtools()!;
const {
  configureRouterBase,
  configureRouterNavigation,
  configureRouterRoutes,
  Route,
  router,
  routerReady,
} = await import("../src/router.ts");
await configureRouterRoutes(routes);
await routerReady;
const initialRoutePath = router.route?.path;
router.navigate("/");

afterAll(() => window.close());

async function flushNavigation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const boundaryRouteTemplate = template("<!--sol:s:0--><!--sol:e:0-->", "boundary-route", {
  elements: [],
  regionCount: 1,
  propertyValueElements: [],
});
const routeErrorTemplate = template(
  "<p data-route-error><!--sol:s:0--><!--sol:e:0--></p>",
  "route-error",
  { elements: [], regionCount: 1, propertyValueElements: [] },
);
const BoundaryRoute = component((_props, frame) => {
  const view = instantiate(boundaryRouteTemplate, frame);
  const cleanups: Array<() => void> = [];
  errorBoundary(
    view.regions[0]!,
    (childFrame) => renderComponent(Route, undefined, childFrame),
    (error, fallbackFrame) => {
      const fallback = instantiate(routeErrorTemplate, fallbackFrame);
      const fallbackCleanups: Array<() => void> = [];
      text(fallback.regions[0]!, () => String(error), fallbackCleanups);
      return block(fallback.fragment, fallbackCleanups);
    },
    cleanups,
    frame,
  );
  return block(view.fragment, cleanups);
});

test("loads the initial browser route before routerReady resolves", () => {
  expect(initialRoutePath).toBe("/initial-lazy");
  expect(initialLoadCalls).toBe(1);
});

test("does not expose mutable router search parameter state", () => {
  router.navigate("/?first=one&second=two");
  const expectedSearch = router.search;
  const expectedUrl = window.location.href;

  for (const mutate of [
    (params: URLSearchParams) => params.set("first", "changed"),
    (params: URLSearchParams) => params.append("third", "three"),
    (params: URLSearchParams) => params.delete("second"),
    (params: URLSearchParams) => params.sort(),
  ]) {
    mutate(router.searchParams as URLSearchParams);
    expect(router.search).toBe(expectedSearch);
    expect(window.location.href).toBe(expectedUrl);
    expect(router.searchParams.toString()).toBe("first=one&second=two");
  }

  router.navigate("/");
});

test("does not expose mutable search parameters through frame route reads", () => {
  router.navigate("/?first=one&second=two");
  const frame = rootFrame();

  for (const mutate of [
    (params: URLSearchParams) => params.set("first", "changed"),
    (params: URLSearchParams) => params.append("third", "three"),
    (params: URLSearchParams) => params.delete("second"),
    (params: URLSearchParams) => params.sort(),
  ]) {
    const params = routeRead(router, "searchParams", frame) as URLSearchParams;
    mutate(params);
    expect((routeRead(router, "searchParams", frame) as URLSearchParams).toString()).toBe(
      "first=one&second=two",
    );
    expect(router.searchParams.toString()).toBe("first=one&second=two");
    expect(router.search).toBe("?first=one&second=two");
  }

  router.navigate("/");
});

test("route transitions overlap, freeze outgoing state, and clean rapid navigation", () => {
  expect((devtools.router.routes as Array<{ path: string }>).map((entry) => entry.path)).toEqual([
    "/async/:id",
    "/lazy/:id",
    "/a!",
    "/café",
    "/failed-lazy",
    "/fast-lazy",
    "/initial-lazy",
    "/pending-lazy",
    "/plain",
    "/rejecting-retirement",
    "/second",
    "/slow-lazy",
    "/ssr-lazy",
    "/throwing",
    "/:__proto__",
    "/",
  ]);
  const target = document.createElement("main");
  const dispose = mount(Route, target);
  expect(animations).toHaveLength(0);

  router.navigate("/second");
  expect(animations).toHaveLength(2);
  expect(target.querySelector('[data-page="first"]')).not.toBeNull();
  expect(target.querySelector('[data-page="second"]')).not.toBeNull();
  firstValue.value = "Changed";
  expect(target.querySelector('[data-page="first"]')?.textContent).toBe("First");

  router.navigate("/");
  expect(animations[0]!.cancelled).toBe(true);
  expect(animations[1]!.cancelled).toBe(true);
  expect(target.querySelectorAll('[data-page="first"]')).toHaveLength(1);

  router.navigate("/plain");
  expect(target.querySelector('[data-page="second"]')).toBeNull();
  expect(target.querySelector('[data-page="plain"]')).not.toBeNull();
  const latestLeave = animations.at(-1)!;
  latestLeave.finish();
  const before = animations.length;

  router.navigate("/second");

  expect(target.querySelector('[data-page="plain"]')).toBeNull();
  expect(target.querySelector('[data-page="second"]')).not.toBeNull();
  expect(animations).toHaveLength(before + 1);
  dispose();
});

test("shows pending UI, loads before validation, and caches repeated route loads", async () => {
  const target = document.createElement("main");
  const dispose = mount(Route, target, { pending: Pending });

  router.navigate("/lazy/7");
  router.navigate("/lazy/7");
  expect(target.querySelector('[data-page="pending"]')).not.toBeNull();
  expect(lazyLoadCalls).toBe(1);
  expect(lazySchemaCalls).toBe(0);

  lazyRequest.resolve(lazyImplementation);
  await flushNavigation();
  expect(target.querySelector('[data-page="lazy"]')).not.toBeNull();
  expect(router.params.id).toBe(7);
  expect(lazySchemaCalls).toBe(2);

  router.navigate("/");
  await flushNavigation();
  router.navigate("/lazy/8");
  await flushNavigation();
  expect(router.params.id).toBe(8);
  expect(lazyLoadCalls).toBe(1);
  expect(lazySchemaCalls).toBe(3);

  router.navigate("/");
  await flushNavigation();
  dispose();
});

test("ignores stale lazy route resolutions", async () => {
  router.navigate("/slow-lazy");
  router.navigate("/fast-lazy");

  fastRequest.resolve(route({ path: "/fast-lazy" }, Fast, fastMetadata));
  await flushNavigation();
  expect(router.route?.path).toBe("/fast-lazy");

  slowRequest.resolve(route({ path: "/slow-lazy" }, Slow, slowMetadata));
  await flushNavigation();
  expect(router.route?.path).toBe("/fast-lazy");

  router.navigate("/");
  await flushNavigation();
});

test("reports lazy route load failures and recovers on later navigation", async () => {
  router.navigate("/failed-lazy");
  try {
    await failedDefinition.load();
  } catch (error) {
    expect(error).toBe(failedLoad);
  }
  await flushNavigation();

  expect(devtools.router.status).toBe("error");
  expect(devtools.router.error).toEqual({ name: "Error", message: "Route chunk failed" });

  router.navigate("/");
  await flushNavigation();
  expect(devtools.router.status).toBe("ready");
  expect(router.route?.path).toBe("/");
});

test("routes lazy and page failures through the mounted ErrorBoundary", async () => {
  const lazyTarget = document.createElement("main");
  const disposeLazy = mount(BoundaryRoute, lazyTarget);
  router.navigate("/failed-lazy");
  await flushNavigation();
  expect(lazyTarget.querySelector("[data-route-error]")?.textContent).toContain(
    "Route chunk failed",
  );
  disposeLazy();

  router.navigate("/");
  await flushNavigation();
  const pageTarget = document.createElement("main");
  const disposePage = mount(BoundaryRoute, pageTarget);
  expect(() => router.navigate("/throwing")).not.toThrow();
  expect(pageTarget.querySelector("[data-route-error]")?.textContent).toContain(
    "Page render failed",
  );
  disposePage();
  router.navigate("/");
  await flushNavigation();
});

test("routes asynchronous page retirement failures through ErrorBoundary", async () => {
  router.navigate("/rejecting-retirement");
  await flushNavigation();
  const target = document.createElement("main");
  const dispose = mount(BoundaryRoute, target);
  const retirementFailure = new Error("route retirement rejected");

  router.navigate("/plain");
  routeRetirement.reject(retirementFailure);
  await flushNavigation();

  expect(target.querySelector("[data-route-error]")?.textContent).toContain(
    "route retirement rejected",
  );
  dispose();
  router.navigate("/");
  await flushNavigation();
});

test("renders the matched route from an isolated server request URL", async () => {
  const html = await renderToStringAsync(Route, undefined, {
    url: "https://example.test/plain?source=server",
  });

  expect(html).toContain('data-page="plain"');
  expect(html).not.toContain('data-page="first"');
});

test("prepares and caches lazy routes before server rendering", async () => {
  const first = await renderToStringAsync(Route, undefined, {
    url: "https://example.test/ssr-lazy",
  });
  const second = await renderToStringAsync(Route, undefined, {
    url: "https://example.test/ssr-lazy?again=true",
  });

  expect(first).toContain('data-page="lazy"');
  expect(second).toContain('data-page="lazy"');
  expect(ssrLoadCalls).toBe(1);
});

test("rejects server rendering when a lazy route import fails", () => {
  expect(
    renderToStringAsync(Route, undefined, {
      url: "https://example.test/failed-lazy",
    }),
  ).rejects.toBe(failedLoad);
});

test("times out while preparing a never-settling lazy server route", async () => {
  const watchdog = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("render preparation watchdog expired")), 100);
  });
  const failure = await Promise.race([
    renderToStringAsync(Route, undefined, {
      url: "https://example.test/pending-lazy",
      timeoutMs: 5,
    }).catch((error: unknown) => error),
    watchdog,
  ]);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("server rendering timed out after 5ms");
});

test("preserves request route state after async component setup resumes", async () => {
  const definition = template("<p><!--sol:s:0--><!--sol:e:0--></p>", "route-shell", {
    elements: [],
    regionCount: 1,
    propertyValueElements: [],
  });
  const Shell = component(async (_props, frame) => {
    await Promise.resolve();
    const view = instantiate(definition, frame);
    const routerId = routeRead(
      router,
      "params",
      frame,
      (value) => (value as typeof router.params).id,
    );
    const definitionId = routeRead(
      asyncRoute,
      "params",
      frame,
      (value) => (value as typeof asyncRoute.params).id,
    );
    const active = routeRead(asyncRoute, "isActive", frame);
    const activePrefix = routeRead(asyncRoute, "isActivePrefix", frame);
    const { params: destructuredParams } = routeObject(router, frame) as typeof router;
    const spreadRoute = { ...(routeObject(asyncRoute, frame) as typeof asyncRoute) };
    const routeView = routeObject(asyncRoute, frame);
    if (routeView !== routeObject(asyncRoute, frame)) throw new Error("route view was not reused");
    text(
      view.regions[0]!,
      () =>
        `${String(routerId)}:${String(definitionId)}:${String(active)}:${String(activePrefix)}:${String(destructuredParams.id)}:${String(spreadRoute.params.id)}`,
      [],
    );
    return block(view.fragment);
  });

  const [first, second] = await Promise.all([
    renderToStringAsync(Shell, undefined, { url: "https://example.test/async/7" }),
    renderToStringAsync(Shell, undefined, { url: "https://example.test/async/8" }),
  ]);

  expect(first).toContain("<p><!--sol:s:0-->7:7:true:true:7:7<!--sol:e:0--></p>");
  expect(second).toContain("<p><!--sol:s:0-->8:8:true:true:8:8<!--sol:e:0--></p>");
});

test("tracks native hash-only navigation", () => {
  window.location.hash = "#details";
  window.dispatchEvent(new window.Event("hashchange"));

  expect(router.hash).toBe("#details");
});

test("matches canonical-equivalent path encodings and Unicode prefixes", () => {
  router.navigate("/caf%c3%a9");
  expect(router.route?.path).toBe("/café");
  expect(unicodeRoute.isActivePrefix).toBe(true);

  router.navigate("/caf%C3%A9/child");
  expect(unicodeRoute.isActivePrefix).toBe(true);

  router.navigate("/a%21");
  expect(router.route?.path).toBe("/a!");

  router.navigate("/bad%");
  expect(router.route).toBeNull();
  expect(unicodeRoute.isActivePrefix).toBe(false);
});

test("preserves prototype-named route parameters", () => {
  router.navigate("/prototype-value");
  expect(router.route?.path).toBe("/:__proto__");
  expect(Object.hasOwn(router.params, "__proto__")).toBe(true);
  expect(router.params.__proto__).toBe("prototype-value");
});

test("reuses empty values for unmatched router reads", () => {
  router.navigate("/not-a-route");
  const params = router.params;
  const query = router.query;

  expect(router.params).toBe(params);
  expect(router.query).toBe(query);
  expect(query).toBe(params);
});

test("validates navigation options", () => {
  expect(() => router.navigate("/", { replace: "yes" } as never)).toThrow(
    "replace must be a boolean",
  );
  expect(() => router.navigate("/", { extra: true } as never)).toThrow("unknown property extra");
  expect(() => router.navigate("/", new Date() as never)).toThrow("plain object");
  expect(() => router.navigate("/", { [Symbol("extra")]: true } as never)).toThrow(
    "unknown property",
  );
  let reads = 0;
  const changing = Object.defineProperty({}, "replace", {
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? false : "yes";
    },
  });
  expect(() => router.navigate("/", changing)).toThrow("data property");
});

test("uses document location APIs for imperative document navigation", () => {
  const assign = mock(() => {});
  const replace = mock(() => {});
  const pushState = mock(() => {});
  const originalAssign = window.location.assign.bind(window.location);
  const originalReplace = window.location.replace.bind(window.location);
  const originalPushState = window.history.pushState.bind(window.history);
  Object.defineProperty(window.location, "assign", { configurable: true, value: assign });
  Object.defineProperty(window.location, "replace", { configurable: true, value: replace });
  Object.defineProperty(window.history, "pushState", { configurable: true, value: pushState });
  configureRouterNavigation("document");
  try {
    router.navigate("/plain?mode=document");
    router.navigate("/second", { replace: true });
    expect(assign).toHaveBeenCalledWith("/plain?mode=document");
    expect(replace).toHaveBeenCalledWith("/second");
    expect(pushState).not.toHaveBeenCalled();
  } finally {
    configureRouterNavigation("history");
    Object.defineProperty(window.location, "assign", { configurable: true, value: originalAssign });
    Object.defineProperty(window.location, "replace", {
      configurable: true,
      value: originalReplace,
    });
    Object.defineProperty(window.history, "pushState", {
      configurable: true,
      value: originalPushState,
    });
  }
});

test("matches and navigates beneath a configured deployment base", async () => {
  await configureRouterBase("/sol/");
  try {
    const deployedHtml = await renderToStringAsync(Route, undefined, {
      url: "https://example.test/sol/plain",
    });
    const logicalHtml = await renderToStringAsync(Route, undefined, {
      url: "https://example.test/plain",
    });
    expect(deployedHtml).toContain('data-page="plain"');
    expect(logicalHtml).toContain('data-page="plain"');

    router.navigate("/second?source=base#details");
    expect(window.location.pathname).toBe("/sol/second");
    expect(router.pathname).toBe("/second");
    expect(router.search).toBe("?source=base");
    expect(router.hash).toBe("#details");

    window.history.pushState(null, "", "/sol/plain");
    window.dispatchEvent(new window.Event("popstate"));
    expect(router.pathname).toBe("/plain");
    expect(router.route?.path).toBe("/plain");

    window.history.pushState(null, "", "/sol/second/");
    window.dispatchEvent(new window.Event("popstate"));
    expect(router.pathname).toBe("/second");
    expect(router.route?.path).toBe("/second");

    window.history.pushState(null, "", "/plain");
    window.dispatchEvent(new window.Event("popstate"));
    expect(router.pathname).toBe("/plain");
    expect(router.route).toBeNull();
  } finally {
    await configureRouterBase("/");
    router.navigate("/");
  }
});

test("validates deployment bases", () => {
  for (const base of [
    "sol/",
    "//sol/",
    "/sol",
    "/sol\\docs/",
    "/sol//docs/",
    "/sol/../docs/",
    "/sol/%2e%2e/docs/",
  ]) {
    expect(() => configureRouterBase(base)).toThrow("Route base");
  }
});
