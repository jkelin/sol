import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as v from "valibot";
import { z } from "zod";
import {
  $component,
  $computed,
  $context,
  $form,
  $signal,
  attribute,
  batch,
  bindValue,
  block,
  child,
  component,
  configureRouteRuntime,
  instantiate,
  list,
  link,
  mount,
  isRouteDefinition,
  route,
  renderComponent,
  resolveRoute,
  routeHref,
  runtimeEffect,
  normalizeClass,
  template,
  text,
  transition,
  type Signal,
  when,
} from "../src/runtime.ts";

let window: Window;

beforeEach(() => {
  window = new Window();
  delete (window.Element.prototype as { getAnimations?: unknown }).getAnimations;
  Object.assign(globalThis, {
    window,
    document: window.document,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Element: window.Element,
    HTMLSelectElement: window.HTMLSelectElement,
  });
});

afterEach(() => window.close());

function noopSubmit(): void {}

interface ControlledAnimation {
  animation: Animation;
  cancelled: boolean;
  finish(): void;
}

function installAnimations(): ControlledAnimation[] {
  const animations: ControlledAnimation[] = [];
  const current = new WeakMap<Element, { signature: string; controlled: ControlledAnimation }>();
  Object.defineProperty(window.Element.prototype, "getAnimations", {
    configurable: true,
    value(this: Element): Animation[] {
      const signature = [...this.classList]
        .filter((className) => className.startsWith("transition-"))
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
  return animations;
}

describe("forms", () => {
  test("validates its public boundary", () => {
    expect(() => $form(undefined as never, noopSubmit)).toThrow("expects a config object");
    expect(() => $form({ schema: {} as never, defaultValues: { title: "" } }, noopSubmit)).toThrow(
      "schema must be callable",
    );
    expect(() =>
      $form(
        {
          schema: (values: { title: string }) => values,
          defaultValues: { title: "" },
          validationStrategy: "later" as never,
        },
        noopSubmit,
      ),
    ).toThrow("validationStrategy");
  });

  test("submits transformed Valibot output and resets controller-owned values", async () => {
    const schema = v.object({
      title: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1, "A title is required."),
        v.maxLength(5, "Use at most five characters."),
      ),
    });
    const submissions: { title: string }[] = [];
    const form = $form({ schema: v.parser(schema), defaultValues: { title: "" } }, (values) => {
      submissions.push(values);
    });

    expect(await form.submit()).toBe(false);
    expect(form.errors.title).toEqual(["A title is required."]);
    form.values.title = "  note  ";
    expect(await form.submit()).toBe(true);
    expect(submissions).toEqual([{ title: "note" }]);

    form.reset({ title: "other" });
    form.values.title = "changed";
    form.reset();
    expect(form.values).toEqual({ title: "" });
    expect(form.errors).toEqual({});
  });

  test("uses Zod parseAsync and normalizes field and form issues", async () => {
    const form = $form(
      {
        schema: z.object({
          profile: z.object({ name: z.string().min(2, "Name is too short.") }),
        }),
        defaultValues: { profile: { name: "" } },
      },
      () => {},
    );

    expect(await form.submit()).toBe(false);
    expect(form.errors["profile.name"]).toEqual(["Name is too short."]);

    const rootForm = $form(
      {
        schema: z.object({ title: z.string() }).refine(() => false, "Form is invalid."),
        defaultValues: { title: "ok" },
      },
      () => {},
    );
    expect(await rootForm.submit()).toBe(false);
    expect(rootForm.formErrors).toEqual(["Form is invalid."]);
  });

  test("preserves multiple messages and rethrows non-validation errors", async () => {
    const failure = {
      issues: [
        { path: ["title"], message: "First problem." },
        { path: [{ key: "title" }], message: "Second problem." },
        { path: [], message: "Form problem." },
      ],
    };
    const form = $form(
      {
        schema: { parse: (_values: { title: string }) => Promise.reject(failure) } as never,
        defaultValues: { title: "" },
      },
      () => {},
    );
    expect(await form.submit()).toBe(false);
    expect(form.errors.title).toEqual(["First problem.", "Second problem."]);
    expect(form.formErrors).toEqual(["Form problem."]);

    const unexpected = new Error("Network failed");
    const broken = $form(
      { schema: () => Promise.reject(unexpected), defaultValues: { title: "" } },
      () => {},
    );
    expect(broken.submit()).rejects.toBe(unexpected);
  });

  test("tracks submission state and prevents duplicate submissions", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    let submissions = 0;
    const form = $form(
      { schema: (values: { title: string }) => values, defaultValues: { title: "ready" } },
      async () => {
        submissions += 1;
        await waiting;
      },
    );

    const first = form.submit();
    await Promise.resolve();
    expect(form.isSubmitting).toBe(true);
    expect(await form.submit()).toBe(false);
    release?.();
    expect(await first).toBe(true);
    expect(form.isSubmitting).toBe(false);
    expect(submissions).toBe(1);
  });

  test("prefers parseAsync and runs the configured validation handlers", async () => {
    let synchronousCalls = 0;
    let asynchronousCalls = 0;
    const form = $form(
      {
        schema: {
          parse: (values: { title: string }) => {
            synchronousCalls += 1;
            return values;
          },
          parseAsync: async (values: { title: string }) => {
            asynchronousCalls += 1;
            return values;
          },
        },
        defaultValues: { title: "" },
        validationStrategy: "onBlur",
      },
      () => {},
    );

    await form.handleInput({ target: { name: "title" } } as unknown as Event);
    expect(asynchronousCalls).toBe(0);
    await form.handleBlur({ target: { name: "title" } } as unknown as FocusEvent);
    expect(asynchronousCalls).toBe(1);
    expect(synchronousCalls).toBe(0);
  });

  test("ignores stale asynchronous validation results", async () => {
    const pending = new Map<
      string,
      {
        resolve: (value: { title: string }) => void;
        reject: (reason: unknown) => void;
      }
    >();
    const form = $form(
      {
        schema: (values: { title: string }) =>
          new Promise<{ title: string }>((resolve, reject) =>
            pending.set(values.title, { resolve, reject }),
          ),
        defaultValues: { title: "" },
        validationStrategy: "onInput",
      },
      () => {},
    );
    const event = { target: { name: "title" } } as unknown as Event;

    form.values.title = "first";
    const first = form.handleInput(event);
    form.values.title = "second";
    const second = form.handleInput(event);
    pending.get("second")!.resolve({ title: "second" });
    await second;
    pending.get("first")!.reject({ issues: [{ path: ["title"], message: "Stale." }] });
    await first;

    expect(form.errors).toEqual({});
  });

  test("does not submit stale output after an input change", async () => {
    let resolveValidation: ((value: { title: string }) => void) | undefined;
    const submissions: { title: string }[] = [];
    const form = $form(
      {
        schema: (values: { title: string }) =>
          new Promise<{ title: string }>((resolve) => {
            resolveValidation = resolve;
            expect(values.title).toBe("before");
          }),
        defaultValues: { title: "before" },
      },
      (values) => {
        submissions.push(values);
      },
    );

    const submission = form.submit();
    form.values.title = "after";
    await form.handleInput({ target: { name: "title" } } as unknown as Event);
    resolveValidation?.({ title: "before" });

    expect(await submission).toBe(false);
    expect(submissions).toEqual([]);
  });

  test("does not submit stale output after reset", async () => {
    let resolveValidation: ((value: { title: string }) => void) | undefined;
    const submissions: { title: string }[] = [];
    const form = $form(
      {
        schema: () =>
          new Promise<{ title: string }>((resolve) => {
            resolveValidation = resolve;
          }),
        defaultValues: { title: "default" },
      },
      (values) => {
        submissions.push(values);
      },
    );

    form.values.title = "pending";
    const submission = form.submit();
    form.reset();
    resolveValidation?.({ title: "pending" });

    expect(await submission).toBe(false);
    expect(form.values.title).toBe("default");
    expect(submissions).toEqual([]);
  });
});

describe("transitions", () => {
  test("validates transition definitions when a phase starts", () => {
    const element = document.createElement("div");
    const fragment = document.createDocumentFragment();
    fragment.append(element);
    transition(element, () => null as never);
    const rendered = block(fragment);

    expect(() => rendered.enter()).toThrow("expects an object");

    const other = document.createElement("div");
    const otherFragment = document.createDocumentFragment();
    otherFragment.append(other);
    transition(other, () => ({ leave: "" }));
    expect(() => block(otherFragment).leave()).toThrow("non-empty class name string");
  });

  test("runs descendant animations together and retires after every leave finishes", async () => {
    const animations = installAnimations();
    const parent = document.createElement("section");
    const descendant = document.createElement("p");
    parent.classList.add("duration-100");
    parent.append(descendant);
    const fragment = document.createDocumentFragment();
    fragment.append(parent);
    const fade = { leave: "transition-leave duration-100" };
    transition(parent, () => fade);
    transition(descendant, () => fade);
    let cleanups = 0;
    const rendered = block(fragment, [() => (cleanups += 1)]);
    const target = document.createElement("main");
    rendered.mount(target);

    const retired = rendered.retire();

    expect(animations).toHaveLength(2);
    expect(parent.classList.contains("transition-leave")).toBe(true);
    expect(cleanups).toBe(1);
    expect(target.contains(parent)).toBe(true);
    animations[0]!.finish();
    await Promise.resolve();
    expect(target.contains(parent)).toBe(true);
    animations[1]!.finish();
    await retired;
    expect(parent.classList.contains("transition-leave")).toBe(false);
    expect(parent.classList.contains("duration-100")).toBe(true);
    expect(target.contains(parent)).toBe(false);
  });

  test("cancels a leave when a block re-enters and cancels animations on disposal", () => {
    const animations = installAnimations();
    const element = document.createElement("div");
    const fragment = document.createDocumentFragment();
    fragment.append(element);
    transition(element, () => ({
      enter: "transition-enter",
      leave: "transition-leave",
    }));
    const rendered = block(fragment);
    const target = document.createElement("main");
    rendered.mount(target);

    rendered.enter();
    void rendered.leave();
    expect(animations[0]!.cancelled).toBe(true);
    rendered.enter();
    expect(animations[1]!.cancelled).toBe(true);
    rendered.dispose();
    expect(animations[2]!.cancelled).toBe(true);
    expect(target.childNodes).toHaveLength(0);
  });

  test("falls back to immediate lifecycle behavior without animation support or with reduced motion", () => {
    const element = document.createElement("div");
    const fragment = document.createDocumentFragment();
    fragment.append(element);
    transition(element, () => ({ leave: "transition-leave" }));
    const rendered = block(fragment);
    const target = document.createElement("main");
    rendered.mount(target);

    expect(rendered.retire()).toBeUndefined();
    expect(target.childNodes).toHaveLength(0);

    const animations = installAnimations();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }),
    });
    const reducedElement = document.createElement("div");
    const reducedFragment = document.createDocumentFragment();
    reducedFragment.append(reducedElement);
    transition(reducedElement, () => ({ enter: "transition-enter" }));
    block(reducedFragment).enter();
    expect(animations).toHaveLength(0);
  });

  test("freezes a retiring component while its DOM finishes leaving", async () => {
    const animations = installAnimations();
    const source = $signal("first");
    let reads = 0;
    const definition = template('<p data-ff-e="0"><!--ff:s:0--><!--ff:e:0--></p>');
    const Page = component(() => {
      const view = instantiate(definition);
      const cleanups: Array<() => void> = [];
      transition(view.elements[0]!, () => ({ leave: "transition-leave" }));
      text(
        view.regions[0]!,
        () => {
          reads += 1;
          return source.value;
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const rendered = renderComponent(Page);
    const target = document.createElement("main");
    rendered.mount(target);

    const retirement = rendered.retire();
    source.value = "second";

    expect(reads).toBe(1);
    expect(target.textContent).toBe("first");
    animations[0]!.finish();
    await retirement;
    expect(target.childNodes).toHaveLength(0);
  });
});

describe("reactivity", () => {
  test("validates context creation and missing-provider reads", () => {
    expect(() => ($context as (...values: unknown[]) => unknown)({ value: "default" })).toThrow(
      "$context() does not accept a default value",
    );
    const context = $context<{ value: string }>();
    expect(context.useOptional()).toBeUndefined();
    expect(() => context.use()).toThrow("Context is not available outside its Provider");
  });

  test("validates the public compiler boundary and class values", () => {
    expect(() =>
      $component(function Example() {
        return undefined as never;
      }),
    ).toThrow("reached runtime");
    expect(
      normalizeClass([
        "todo-row",
        [null, false, "ledger-line"],
        { "todo-row--completed": true, hidden: 0 },
        2,
      ]),
    ).toBe("todo-row ledger-line todo-row--completed 2");
  });

  test("tracks primitives, computed values, and batches writes", () => {
    const count = $signal(1);
    const doubled = $computed(() => count.value * 2);
    const values: number[] = [];
    const stop = runtimeEffect(() => values.push(doubled.value));

    batch(() => {
      count.value = 2;
      count.value = 3;
    });

    expect(values).toEqual([2, 6]);
    stop();
    count.value = 4;
    expect(values).toEqual([2, 6]);
  });

  test("deduplicates computed cascades during a batch", () => {
    const count = $signal(1);
    const doubled = $computed(() => count.value * 2);
    const observations: string[] = [];
    runtimeEffect(() => observations.push(`${count.value}:${doubled.value}`));

    batch(() => {
      count.value = 2;
      count.value = 3;
    });

    expect(observations).toEqual(["1:2", "3:6"]);
  });

  test("deduplicates computed cascades outside a batch", () => {
    const count = $signal(1);
    const doubled = $computed(() => count.value * 2);
    const observations: string[] = [];
    runtimeEffect(() => observations.push(`${count.value}:${doubled.value}`));

    count.value = 2;

    expect(observations).toEqual(["1:2", "2:4"]);
  });

  test("settles transitive computed chains before running consumers", () => {
    for (const update of [
      (source: Signal<number>) => {
        source.value = 2;
      },
      (source: Signal<number>) =>
        batch(() => {
          source.value = 2;
        }),
    ]) {
      const source = $signal(1);
      const doubled = $computed(() => source.value * 2);
      const incremented = $computed(() => doubled.value + 1);
      const observations: string[] = [];
      runtimeEffect(() => observations.push(`${source.value}:${incremented.value}`));

      update(source);

      expect(observations).toEqual(["1:3", "2:5"]);
    }
  });

  test("preserves a batch callback failure when the reactive flush also fails", () => {
    const source = $signal(0);
    runtimeEffect(() => {
      if (source.value > 0) throw new Error("effect failed");
    });

    try {
      batch(() => {
        source.value = 1;
        throw new Error("callback failed");
      });
      throw new Error("expected batch to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        "Error: callback failed",
        "Error: effect failed",
      ]);
    }
  });

  test("unsubscribes effects and computed values whose initial evaluation throws", () => {
    const source = $signal(0);
    let effectRuns = 0;
    expect(() =>
      runtimeEffect(() => {
        effectRuns += 1;
        void source.value;
        throw new Error("effect failed");
      }),
    ).toThrow("effect failed");

    let computedRuns = 0;
    expect(() =>
      $computed(() => {
        computedRuns += 1;
        void source.value;
        throw new Error("computed failed");
      }),
    ).toThrow("computed failed");

    source.value = 1;
    expect(effectRuns).toBe(1);
    expect(computedRuns).toBe(1);
  });

  test("tracks deep object writes and array mutators", () => {
    const state = $signal({ todos: [{ done: false }] });
    const observations: string[] = [];
    runtimeEffect(() =>
      observations.push(`${state.value.todos.length}:${state.value.todos[0]?.done}`),
    );

    state.value.todos[0]!.done = true;
    state.value.todos.push({ done: false });
    state.value.todos.splice(0, 1);

    expect(observations).toEqual(["1:false", "1:true", "2:true", "1:false"]);
  });

  test("preserves built-in and class instances instead of proxying them", () => {
    class Model {
      constructor(readonly value: number) {}
    }
    const date = new Date(0);
    const map = new Map([["answer", 42]]);
    const model = new Model(7);
    const state = $signal({ date, map, model });

    expect(state.value.date).toBe(date);
    expect(state.value.date.getTime()).toBe(0);
    expect(state.value.map).toBe(map);
    expect(state.value.map.get("answer")).toBe(42);
    expect(state.value.model).toBe(model);
    expect(state.value.model.value).toBe(7);
  });

  test("preserves frozen object identity and proxy invariants", () => {
    const nested = Object.freeze({ value: 1 });
    const frozen = Object.freeze({ nested });
    const frozenArray = Object.freeze([nested]);
    const state = $signal({ frozen, frozenArray });

    expect(state.value.frozen).toBe(frozen);
    expect(state.value.frozen.nested).toBe(nested);
    expect(state.value.frozenArray).toBe(frozenArray);
    expect(state.value.frozenArray[0]).toBe(nested);
  });

  test("treats assigning a cached proxy back to its property as a no-op", () => {
    const state = $signal({ child: { value: 1 } });
    const observations: number[] = [];
    runtimeEffect(() => observations.push(state.value.child.value));
    const childProxy = state.value.child;

    state.value.child = childProxy;
    childProxy.value = 2;

    expect(state.value.child).toBe(childProxy);
    expect(observations).toEqual([1, 2]);
  });

  test("tracks property iteration and deletion", () => {
    const state = $signal<Record<string, number>>({ first: 1, second: 2 });
    const keys: string[] = [];
    runtimeEffect(() => keys.push(Object.keys(state.value).join(",")));

    delete state.value.first;

    expect(keys).toEqual(["first,second", "second"]);
  });

  test("cleans stale conditional dependencies", () => {
    const useLeft = $signal(true);
    const left = $signal("left");
    const right = $signal("right");
    const values: string[] = [];
    runtimeEffect(() => values.push(useLeft.value ? left.value : right.value));

    useLeft.value = false;
    left.value = "ignored";
    right.value = "updated";

    expect(values).toEqual(["left", "right", "updated"]);
  });
});

describe("compiled DOM runtime", () => {
  test("validates and brands compiled route records", () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const definition = route({ path: "/entry/:id" }, Empty, {
      pattern: "^/entry/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [],
      specificity: [1, 0],
    });

    expect(isRouteDefinition(definition)).toBe(true);
    expect(definition.config.path).toBe("/entry/:id");
    expect(() => route(null as never, Empty, definition.compiled)).toThrow(
      "config must contain a path",
    );
    expect(() => route({ path: "/bad" }, (() => undefined) as never, definition.compiled)).toThrow(
      "uncompiled component",
    );
  });

  test("provides typed route params, navigation, and active state", () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const detail = route({ path: "/blog/:id" }, Empty, {
      pattern: "^/blog/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [],
      specificity: [1, 0],
    });
    const todo = route({ path: "/" }, Empty, {
      pattern: "^/$",
      parameterNames: [],
      pathnameParameterNames: [],
      queryParameters: [],
      specificity: [],
    });
    let active: object = detail;
    let pathname = "/blog/first";
    const activeParams = { id: "first" } as const;
    const navigations: Array<{ path: string; replace: boolean | undefined }> = [];
    configureRouteRuntime({
      getParams(definition) {
        if (definition !== active) throw new Error("inactive");
        return activeParams;
      },
      getPathname: () => pathname,
      isActive: (definition) => definition === active,
      navigate(path, options) {
        navigations.push({ path, replace: options?.replace });
      },
    });

    expect(detail.params.id).toBe("first");
    expect(detail.query).toBe(detail.params);
    expect(detail.isActive).toBe(true);
    expect(detail.isActivePrefix).toBe(true);
    expect(todo.isActive).toBe(false);
    expect(todo.isActivePrefix).toBe(false);
    detail.navigate({ params: { id: "hello world" } }, { replace: true });
    expect(navigations).toEqual([{ path: "/blog/hello%20world", replace: true }]);
    expect(() => detail.navigate({} as never)).toThrow("Missing route parameter id");
    expect(() => detail.navigate({ params: { id: "one", extra: "two" } } as never)).toThrow(
      "Unknown route parameter extra",
    );

    active = todo;
    pathname = "/";
    expect(() => detail.params.id).toThrow("inactive");
    expect(detail.isActive).toBe(false);
    todo.navigate({}, { replace: true });
    expect(navigations.at(-1)).toEqual({ path: "/", replace: true });
  });

  test("validates and serializes parsed route values", async () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const detail = route(
      {
        path: "/blog/:id?page=:page&filter=:filter",
        schema: ({ id, page, filter }) => ({ id: Number(id), page: Number(page), filter: filter! }),
      },
      Empty,
      {
        pattern: "^/blog/([^/]+)$",
        parameterNames: ["id", "page", "filter"],
        pathnameParameterNames: ["id"],
        queryParameters: [
          { key: "page", name: "page" },
          { key: "filter", name: "filter" },
        ],
        specificity: [1, 0],
      },
    );

    const resolution = await resolveRoute(detail, { id: "42", page: "3", filter: "recent" });
    expect(resolution).toEqual({
      matched: true,
      values: { id: 42, page: 3, filter: "recent" },
    });
    expect(
      routeHref(detail, {
        params: { id: 42, page: 3, filter: "recent" },
      }),
    ).toBe("/blog/42?page=3&filter=recent");
    expect(() =>
      routeHref(detail, { params: { id: 42, page: true, filter: "recent" } } as never),
    ).toThrow("must be a string or number");
    expect(() => routeHref(detail, { params: { id: 42 }, extra: true })).toThrow(
      "unknown property extra",
    );

    const repeated = route({ path: "/blog/:id?selected=:id" }, Empty, {
      pattern: "^/blog/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [{ key: "selected", name: "id" }],
      specificity: [1, 0],
    });
    expect(routeHref(repeated, { params: { id: "hello world" } })).toBe(
      "/blog/hello%20world?selected=hello+world",
    );
  });

  test("validates routes with Standard Schema implementations", async () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const detail = route(
      {
        path: "/blog/:id?from=:from",
        schema: v.object({
          id: v.pipe(v.string(), v.transform(Number), v.integer()),
          from: v.string(),
        }),
      },
      Empty,
      {
        pattern: "^/blog/([^/]+)$",
        parameterNames: ["id", "from"],
        pathnameParameterNames: ["id"],
        queryParameters: [{ key: "from", name: "from" }],
        specificity: [1, 0],
      },
    );

    expect(await resolveRoute(detail, { id: "42", from: "index" })).toEqual({
      matched: true,
      values: { id: 42, from: "index" },
    });
    expect(await resolveRoute(detail, { id: "invalid", from: "index" })).toEqual({
      matched: false,
    });
  });

  test("treats schema issues as no match and preserves unexpected failures", async () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const compiled = {
      pattern: "^/entry/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [],
      specificity: [1, 0],
    };
    const invalid = route(
      {
        path: "/entry/:id",
        schema: async (): Promise<{ id: string }> => {
          throw { issues: [{ message: "Invalid id", path: ["id"] }] };
        },
      },
      Empty,
      compiled,
    );
    const broken = route(
      {
        path: "/entry/:id",
        schema: (): { id: string } => {
          throw new Error("parser failed");
        },
      },
      Empty,
      compiled,
    );

    expect(await resolveRoute(invalid, { id: "bad" })).toEqual({
      matched: false,
    });
    expect(() => resolveRoute(broken, { id: "bad" })).toThrow("parser failed");
  });

  test("decorates Link anchors and preserves cancelled or modified clicks", () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const detail = route({ path: "/blog/:id" }, Empty, {
      pattern: "^/blog/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [],
      specificity: [1, 0],
    });
    const navigations: string[] = [];
    configureRouteRuntime({
      getParams: () => ({ id: "first" }),
      getPathname: () => "/",
      isActive: () => false,
      navigate: (path) => navigations.push(path),
    });
    const anchor = document.createElement("a");
    const cleanups: Array<() => void> = [];
    let cancelNext = false;
    anchor.addEventListener("click", (event) => {
      if (cancelNext) event.preventDefault();
    });
    link(
      anchor,
      () => detail,
      () => ({ params: { id: "hello world" } }),
      () => false,
      cleanups,
    );

    expect(anchor.getAttribute("href")).toBe("/blog/hello%20world");
    anchor.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      }) as unknown as Event,
    );
    anchor.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        button: 0,
        ctrlKey: true,
        cancelable: true,
      }) as unknown as Event,
    );
    cancelNext = true;
    anchor.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      }) as unknown as Event,
    );
    cancelNext = false;
    anchor.target = "_blank";
    anchor.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      }) as unknown as Event,
    );
    anchor.removeAttribute("target");
    anchor.setAttribute("download", "entry.txt");
    anchor.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      }) as unknown as Event,
    );

    expect(navigations).toEqual(["/blog/hello%20world"]);
    for (const cleanup of cleanups.toReversed()) cleanup();
  });

  test("updates normalized DOM classes reactively", () => {
    const classes = $signal(["todo-row", { "todo-row--completed": false }]);
    const element = document.createElement("div");
    const cleanups: (() => void)[] = [];
    attribute(element, "classNames", () => classes.value, cleanups);

    expect(element.className).toBe("todo-row");
    classes.value = ["todo-row", { "todo-row--completed": true }];
    expect(element.className).toBe("todo-row todo-row--completed");
    for (const cleanup of cleanups.toReversed()) cleanup();
  });

  test("mounts once and patches text without rerunning setup", () => {
    const count = $signal(0);
    let setups = 0;
    const definition = template("<p><!--ff:s:0--><!--ff:e:0--></p>");
    const Counter = component(() => {
      setups += 1;
      const view = instantiate(definition);
      const cleanups: (() => void)[] = [];
      text(view.regions[0]!, () => count.value, cleanups);
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");

    const dispose = mount(Counter, target);
    count.value = 2;

    expect(target.textContent).toBe("2");
    expect(setups).toBe(1);
    dispose();
    expect(target.textContent).toBe("");
  });

  test("validates mount boundaries", () => {
    const target = document.createElement("main");
    expect(() => mount((() => undefined) as never, target)).toThrow("uncompiled component");
    expect(() => mount((() => undefined) as never, null as never)).toThrow("DOM Element target");
    expect(() => mount((() => undefined) as never, target, "bad props" as never)).toThrow(
      "props must be an object",
    );
  });

  test("rejects every reflective mutation of readonly component props", () => {
    let receivedProps: Readonly<{ label: string }> | undefined;
    const Example = component((props: Readonly<{ label: string }>) => {
      receivedProps = props;
      return block(document.createDocumentFragment());
    });
    mount(Example, document.createElement("main"), { label: "original" });
    const props = receivedProps!;

    expect(() => Object.defineProperty(props, "label", { value: "changed" })).toThrow(
      "Component props are readonly",
    );
    expect(() => Reflect.defineProperty(props, "label", { value: "changed" })).toThrow(
      "Component props are readonly",
    );
    expect(() => Object.setPrototypeOf(props, null)).toThrow("Component props are readonly");
    expect(() => Reflect.setPrototypeOf(props, null)).toThrow("Component props are readonly");
    expect(() => Object.preventExtensions(props)).toThrow("Component props are readonly");
    expect(() => Reflect.preventExtensions(props)).toThrow("Component props are readonly");
    expect(() => Object.freeze(props)).toThrow("Component props are readonly");
    expect(() => Object.seal(props)).toThrow("Component props are readonly");
    expect(props.label).toBe("original");
    expect(Object.isExtensible(props)).toBe(true);
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
  });

  test("cleans setup-owned effects when component setup throws", () => {
    const source = $signal(1);
    let derivations = 0;
    const Broken = component(() => {
      $computed(() => {
        derivations += 1;
        return source.value;
      });
      throw new Error("setup failed");
    });
    const target = document.createElement("main");

    expect(() => mount(Broken, target)).toThrow("setup failed");
    source.value = 2;

    expect(derivations).toBe(1);
  });

  test("synchronizes form bindings in both directions", () => {
    const draft = $signal("first");
    const definition = template('<input data-ff-e="0">');
    const view = instantiate(definition);
    const cleanups: (() => void)[] = [];
    const input = view.elements[0] as HTMLInputElement;
    bindValue(
      input,
      "value",
      () => draft.value,
      (value) => {
        draft.value = String(value);
      },
      cleanups,
    );

    expect(input.value).toBe("first");
    input.value = "second";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(draft.value).toBe("second");
    draft.value = "third";
    expect(input.value).toBe("third");
    for (const cleanup of cleanups.toReversed()) cleanup();
    input.value = "ignored";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(draft.value).toBe("third");
  });

  test("synchronizes inferred checked bindings in both directions", () => {
    const completed = $signal(false);
    const definition = template('<input type="checkbox" data-ff-e="0">');
    const view = instantiate(definition);
    const cleanups: (() => void)[] = [];
    const input = view.elements[0] as HTMLInputElement;
    bindValue(
      input,
      "checked",
      () => completed.value,
      (value) => {
        completed.value = Boolean(value);
      },
      cleanups,
    );

    expect(input.checked).toBe(false);
    input.checked = true;
    input.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    expect(completed.value).toBe(true);
    completed.value = false;
    expect(input.checked).toBe(false);
    for (const cleanup of cleanups.toReversed()) cleanup();
  });

  test("disposes effects owned by removed conditional branches", () => {
    const visible = $signal(true);
    const branchValue = $signal("first");
    let branchReads = 0;
    const parentTemplate = template("<div><!--ff:s:0--><!--ff:e:0--></div>");
    const Parent = component(() => {
      const view = instantiate(parentTemplate);
      const cleanups: (() => void)[] = [];
      when(
        view.regions[0]!,
        () => visible.value,
        () => {
          const fragment = document.createDocumentFragment();
          fragment.append(document.createTextNode("visible"));
          const branchCleanups = [
            runtimeEffect(() => {
              branchReads += 1;
              void branchValue.value;
            }),
          ];
          return block(fragment, branchCleanups);
        },
        () => block(document.createDocumentFragment()),
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");
    mount(Parent, target);

    visible.value = false;
    branchValue.value = "ignored";

    expect(branchReads).toBe(1);
  });

  test("disposes setup-owned computed effects", () => {
    const source = $signal(1);
    let derivations = 0;
    const definition = template("<p><!--ff:s:0--><!--ff:e:0--></p>");
    const Derived = component(() => {
      const value = $computed(() => {
        derivations += 1;
        return source.value * 2;
      });
      const view = instantiate(definition);
      const cleanups: (() => void)[] = [];
      text(view.regions[0]!, () => value.value, cleanups);
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");
    const dispose = mount(Derived, target);

    dispose();
    source.value = 2;

    expect(derivations).toBe(1);
  });

  test("disposes setup-owned effects while an async component is pending", async () => {
    const source = $signal(0);
    const observations: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const Async = component(async () => {
      runtimeEffect(() => observations.push(source.value));
      await gate;
      return block(document.createDocumentFragment());
    });
    const target = document.createElement("div");
    const dispose = mount(Async, target);

    expect(observations).toEqual([0]);
    dispose();
    source.value = 1;
    expect(observations).toEqual([0]);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(target.childNodes).toHaveLength(0);
  });

  test("updates reactive child props without rerunning child setup", () => {
    const label = $signal("First");
    let childSetups = 0;
    let childReads = 0;
    const childTemplate = template("<span><!--ff:s:0--><!--ff:e:0--></span>");
    const Child = component((props: Readonly<{ label: string }>) => {
      childSetups += 1;
      const view = instantiate(childTemplate);
      const cleanups: (() => void)[] = [];
      text(
        view.regions[0]!,
        () => {
          childReads += 1;
          return props.label;
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const parentTemplate = template("<div><!--ff:s:0--><!--ff:e:0--></div>");
    const Parent = component(() => {
      const view = instantiate(parentTemplate);
      const cleanups: (() => void)[] = [];
      child(view.regions[0]!, Child, { label: () => label.value }, cleanups);
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");
    const dispose = mount(Parent, target);

    label.value = "Second";

    expect(target.textContent).toBe("Second");
    expect(childSetups).toBe(1);
    dispose();
    label.value = "Ignored";
    expect(childReads).toBe(2);
  });

  test("reorders keyed blocks while preserving their nodes", () => {
    const values = $signal([
      { id: 1, label: "One" },
      { id: 2, label: "Two" },
    ]);
    const definition = template("<ol><!--ff:s:0--><!--ff:e:0--></ol>");
    const rowDefinition = template("<li><!--ff:s:0--><!--ff:e:0--></li>");
    const List = component(() => {
      const view = instantiate(definition);
      const cleanups: (() => void)[] = [];
      list(
        view.regions[0]!,
        () => values.value,
        (item) => item.id,
        (item) => {
          const row = instantiate(rowDefinition);
          const rowCleanups: (() => void)[] = [];
          text(row.regions[0]!, () => item.value.label, rowCleanups);
          return block(row.fragment, rowCleanups);
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");
    mount(List, target);
    const firstNode = target.querySelectorAll("li")[0];

    values.value.reverse();

    expect([...target.querySelectorAll("li")].map((node) => node.textContent)).toEqual([
      "Two",
      "One",
    ]);
    expect(target.querySelectorAll("li")[1]).toBe(firstNode);
  });

  test("disposes effects owned by removed keyed rows", () => {
    const items = $signal([{ id: 1, value: "first" }]);
    const removed = items.value[0]!;
    let rowReads = 0;
    const definition = template("<div><!--ff:s:0--><!--ff:e:0--></div>");
    const List = component(() => {
      const view = instantiate(definition);
      const cleanups: (() => void)[] = [];
      list(
        view.regions[0]!,
        () => items.value,
        (item) => item.id,
        (item) => {
          const fragment = document.createDocumentFragment();
          fragment.append(document.createTextNode("row"));
          const rowCleanups = [
            runtimeEffect(() => {
              rowReads += 1;
              void item.value.value;
            }),
          ];
          return block(fragment, rowCleanups);
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    mount(List, document.createElement("main"));

    items.value.splice(0, 1);
    removed.value = "ignored";

    expect(rowReads).toBe(1);
  });
});
