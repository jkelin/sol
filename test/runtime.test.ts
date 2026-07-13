import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  $component,
  $computed,
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
  mount,
  isRouteDefinition,
  route,
  runtimeEffect,
  normalizeClass,
  template,
  text,
  type Signal,
  when,
} from "../src/runtime.ts";

let window: Window;

beforeEach(() => {
  window = new Window();
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

describe("reactivity", () => {
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
      specificity: [1, 0],
    });
    const todo = route({ path: "/" }, Empty, {
      pattern: "^/$",
      parameterNames: [],
      specificity: [],
    });
    let active: object = detail;
    let pathname = "/blog/first";
    const navigations: Array<{ path: string; replace: boolean | undefined }> = [];
    configureRouteRuntime({
      getParams(definition) {
        if (definition !== active) throw new Error("inactive");
        return { id: "first" };
      },
      getPathname: () => pathname,
      isActive: (definition) => definition === active,
      navigate(path, options) {
        navigations.push({ path, replace: options?.replace });
      },
    });

    expect(detail.params.id).toBe("first");
    expect(detail.isActive).toBe(true);
    expect(detail.isActivePrefix).toBe(true);
    expect(todo.isActive).toBe(false);
    expect(todo.isActivePrefix).toBe(false);
    detail.navigate({ id: "hello world" }, { replace: true });
    expect(navigations).toEqual([{ path: "/blog/hello%20world", replace: true }]);
    expect(() => detail.navigate({} as never)).toThrow("Missing route parameter id");
    expect(() => detail.navigate({ id: "one", extra: "two" } as never)).toThrow(
      "Unknown route parameter extra",
    );

    active = todo;
    pathname = "/";
    expect(() => detail.params.id).toThrow("inactive");
    expect(detail.isActive).toBe(false);
    todo.navigate({ replace: true });
    expect(navigations.at(-1)).toEqual({ path: "/", replace: true });
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
