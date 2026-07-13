import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  batch,
  bindValue,
  block,
  child,
  component,
  computed,
  instantiate,
  list,
  mount,
  runtimeEffect,
  signal,
  template,
  text,
  type Region,
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
  test("tracks primitives, computed values, and batches writes", () => {
    const count = signal(1);
    const doubled = computed(() => count.value * 2);
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

  test("tracks deep object writes and array mutators", () => {
    const state = signal({ todos: [{ done: false }] });
    const observations: string[] = [];
    runtimeEffect(() => observations.push(`${state.value.todos.length}:${state.value.todos[0]?.done}`));

    state.value.todos[0]!.done = true;
    state.value.todos.push({ done: false });
    state.value.todos.splice(0, 1);

    expect(observations).toEqual(["1:false", "1:true", "2:true", "1:false"]);
  });

  test("tracks property iteration and deletion", () => {
    const state = signal<Record<string, number>>({ first: 1, second: 2 });
    const keys: string[] = [];
    runtimeEffect(() => keys.push(Object.keys(state.value).join(",")));

    delete state.value.first;

    expect(keys).toEqual(["first,second", "second"]);
  });

  test("cleans stale conditional dependencies", () => {
    const useLeft = signal(true);
    const left = signal("left");
    const right = signal("right");
    const values: string[] = [];
    runtimeEffect(() => values.push(useLeft.value ? left.value : right.value));

    useLeft.value = false;
    left.value = "ignored";
    right.value = "updated";

    expect(values).toEqual(["left", "right", "updated"]);
  });
});

describe("compiled DOM runtime", () => {
  test("mounts once and patches text without rerunning setup", () => {
    const count = signal(0);
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
    expect(() => mount((() => undefined) as never, target, "bad props" as never)).toThrow("props must be an object");
  });

  test("cleans setup-owned effects when component setup throws", () => {
    const source = signal(1);
    let derivations = 0;
    const Broken = component(() => {
      computed(() => {
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
    const draft = signal("first");
    const definition = template('<input data-ff-e="0">');
    const view = instantiate(definition);
    const cleanups: (() => void)[] = [];
    const input = view.elements[0] as HTMLInputElement;
    bindValue(input, "value", () => draft.value, (value) => {
      draft.value = String(value);
    }, cleanups);

    expect(input.value).toBe("first");
    input.value = "second";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(draft.value).toBe("second");
    draft.value = "third";
    expect(input.value).toBe("third");
    for (const cleanup of cleanups.reverse()) cleanup();
    input.value = "ignored";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(draft.value).toBe("third");
  });

  test("disposes effects owned by removed conditional branches", () => {
    const visible = signal(true);
    const branchValue = signal("first");
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
          const branchCleanups = [runtimeEffect(() => {
            branchReads += 1;
            void branchValue.value;
          })];
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
    const source = signal(1);
    let derivations = 0;
    const definition = template("<p><!--ff:s:0--><!--ff:e:0--></p>");
    const Derived = component(() => {
      const value = computed(() => {
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
    const label = signal("First");
    let childSetups = 0;
    let childReads = 0;
    const childTemplate = template("<span><!--ff:s:0--><!--ff:e:0--></span>");
    const Child = component((props: Readonly<{ label: string }>) => {
      childSetups += 1;
      const view = instantiate(childTemplate);
      const cleanups: (() => void)[] = [];
      text(view.regions[0]!, () => {
        childReads += 1;
        return props.label;
      }, cleanups);
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
    const values = signal([{ id: 1, label: "One" }, { id: 2, label: "Two" }]);
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

    expect([...target.querySelectorAll("li")].map((node) => node.textContent)).toEqual(["Two", "One"]);
    expect(target.querySelectorAll("li")[1]).toBe(firstNode);
  });

  test("disposes effects owned by removed keyed rows", () => {
    const items = signal([{ id: 1, value: "first" }]);
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
          const rowCleanups = [runtimeEffect(() => {
            rowReads += 1;
            void item.value.value;
          })];
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
