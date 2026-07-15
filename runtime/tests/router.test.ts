import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Component } from "../src/components.ts";
import { $signal } from "../src/reactivity.ts";
import { installDevtools } from "../src/devtools.ts";
import { mount } from "../src/rendering.ts";
import { renderToStringAsync } from "../src/ssr.ts";
import { transition } from "../src/transitions.ts";
import { block, component, instantiate, route, template, text } from "../src/compiler-runtime.ts";

interface ControlledAnimation {
  animation: Animation;
  cancelled: boolean;
  finish(): void;
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
  unicodeRoute,
  prototypeRoute,
  route({ path: "/a!" }, Plain, {
    pattern: "^/a!$",
    parameterNames: [],
    pathnameParameterNames: [],
    queryParameters: [],
    specificity: [1],
  }),
  route(
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
  ),
];

await mock.module("virtual:sol/routes", () => ({ default: routes }));
const devtools = installDevtools()!;
const { configureRouterBase, Route, router } = await import("../src/router.ts");

afterAll(() => window.close());

test("route transitions overlap, freeze outgoing state, and clean rapid navigation", () => {
  expect((devtools.router.routes as Array<{ path: string }>).map((entry) => entry.path)).toEqual([
    "/async/:id",
    "/a!",
    "/café",
    "/plain",
    "/second",
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

test("renders the matched route from an isolated server request URL", async () => {
  const html = await renderToStringAsync(Route, undefined, {
    url: "https://example.test/plain?source=server",
  });

  expect(html).toContain('data-page="plain"');
  expect(html).not.toContain('data-page="first"');
});

test("resolves asynchronous route state before rendering the server root", async () => {
  const definition = template("<p><!--sol:s:0--><!--sol:e:0--></p>", "route-shell", {
    elements: [],
    regionCount: 1,
    propertyValueElements: [],
  });
  const Shell = component((_props, frame) => {
    const view = instantiate(definition, frame);
    text(view.regions[0]!, () => String(router.params.id), []);
    return block(view.fragment);
  });

  const html = await renderToStringAsync(Shell, undefined, {
    url: "https://example.test/async/7",
  });

  expect(html).toContain("<p><!--sol:s:0-->7<!--sol:e:0--></p>");
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

test("validates navigation options", () => {
  expect(() => router.navigate("/", { replace: "yes" } as never)).toThrow(
    "replace must be a boolean",
  );
  expect(() => router.navigate("/", { extra: true } as never)).toThrow("unknown property extra");
  expect(() => router.navigate("/", new Date() as never)).toThrow("plain object");
  expect(() => router.navigate("/", { [Symbol("extra")]: true } as never)).toThrow(
    "unknown property",
  );
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
