import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Component } from "../src/components.ts";
import { $signal } from "../src/reactivity.ts";
import { installDevtools } from "../src/devtools.ts";
import { mount } from "../src/rendering.ts";
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
      ? '<section data-solix-e="0" data-page="first"><!--solix:s:0--><!--solix:e:0--></section>'
      : `<section data-solix-e="0" data-page="${label.toLowerCase()}">${label}</section>`,
  );
  return component(() => {
    const view = instantiate(definition);
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
];

await mock.module("virtual:solix/routes", () => ({ default: routes }));
const devtools = installDevtools()!;
const { Route, router } = await import("../src/router.ts");

afterAll(() => window.close());

test("route transitions overlap, freeze outgoing state, and clean rapid navigation", () => {
  expect((devtools.router.routes as Array<{ path: string }>).map((entry) => entry.path)).toEqual([
    "/plain",
    "/second",
    "/",
  ]);
  const target = document.createElement("main");
  mount(Route, target);
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
});
