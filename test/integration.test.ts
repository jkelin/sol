import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import ts from "typescript";
import { compile } from "../src/compiler.ts";
import { $form, mount, type Component } from "../src/runtime.ts";

interface SetupCounts {
  app: number;
  child: number;
}

declare global {
  var integrationSetups: SetupCounts;
  var integrationForm: typeof $form;
}

let window: Window;

beforeEach(() => {
  window = new Window();
  globalThis.integrationSetups = { app: 0, child: 0 };
  Object.assign(globalThis, {
    integrationForm: $form,
    window,
    document: window.document,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Element: window.Element,
    HTMLSelectElement: window.HTMLSelectElement,
  });
});

afterEach(() => window.close());

async function loadCompiled(source: string): Promise<Record<string, unknown>> {
  const result = compile(source, "Integration.tsx");
  const runtimeUrl = new URL("../src/runtime.ts", import.meta.url).href;
  const sourceWithRuntime = result.code.replace(
    '"frontend-framework/runtime"',
    JSON.stringify(runtimeUrl),
  );
  const javascript =
    ts.transpileModule(sourceWithRuntime, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText + `\n// ${crypto.randomUUID()}`;
  const encoded = Buffer.from(javascript).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("compiled components update fine-grained DOM without rerunning setup", async () => {
  const module = await loadCompiled(`
    const Child = $component(function Child(props: { item: { id: number; label: string } }) {
      globalThis.integrationSetups.child += 1;
      return <li data-id={props.item.id}>{props.item.label}</li>;
    });

    export const App = $component(function App() {
      globalThis.integrationSetups.app += 1;
      let count = 0;
      let visible = true;
      const doubled = count * 2;
      const items = [{ id: 1, label: "One" }, { id: 2, label: "Two" }];

      return <main>
        <button id="increment" onClick={() => count++}>Increment</button>
        <button id="toggle" onClick={() => visible = !visible}>Toggle</button>
        <button id="rename" onClick={() => items[0].label = "Updated"}>Rename</button>
        <button id="reverse" onClick={() => items.reverse()}>Reverse</button>
        <button id="add" onClick={() => items.push({ id: 3, label: "Three" })}>Add</button>
        <button id="remove" onClick={() => items.splice(1, 1)}>Remove</button>
        <output>{count}:{doubled}</output>
        {visible && <p>Visible</p>}
        <ul>{items.map(item => <Child key={item.id} item={item} />)}</ul>
      </main>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  const dispose = mount(App, target);
  const rows = target.querySelectorAll("li");
  const firstRow = rows[0];

  target.querySelector<HTMLButtonElement>("#increment")!.click();
  expect(target.querySelector("output")!.textContent).toBe("1:2");

  target.querySelector<HTMLButtonElement>("#rename")!.click();
  expect(firstRow!.textContent).toBe("Updated");

  target.querySelector<HTMLButtonElement>("#reverse")!.click();
  expect(target.querySelectorAll("li")[1]).toBe(firstRow);

  target.querySelector<HTMLButtonElement>("#add")!.click();
  expect(target.querySelectorAll("li")).toHaveLength(3);
  expect(globalThis.integrationSetups).toEqual({ app: 1, child: 3 });

  target.querySelector<HTMLButtonElement>("#remove")!.click();
  expect(target.querySelectorAll("li")).toHaveLength(2);

  target.querySelector<HTMLButtonElement>("#toggle")!.click();
  expect(target.querySelector("p")).toBeNull();
  expect(globalThis.integrationSetups).toEqual({ app: 1, child: 3 });

  dispose();
  expect(target.childNodes).toHaveLength(0);
});

test("compiled forms bind controller values and patch validation errors", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      globalThis.integrationSetups.app += 1;
      let submitted = "";
      let submissions: { id: number; title: string }[] = [];
      function save(values: { title: string }) {
        submitted = values.title;
        submissions.push({ id: submissions.length + 1, title: values.title });
      }
      const form = globalThis.integrationForm({
        schema: {
          parse(values: { title: string }) {
            if (!values.title) throw { issues: [{ path: ["title"], message: "Required." }] };
            return { title: values.title.toUpperCase() };
          },
        },
        defaultValues: { title: "" },
      }, save);
      const error = form.errors.title?.[0];
      return <form $form={form}>
        <input name="title" $bind={form.values.title} aria-invalid={Boolean(error)} />
        {error && <span role="alert">{error}</span>}
        <button type="submit">Save</button>
        <button type="button" id="remove" onClick={() => submissions.splice(0, 1)}>Remove</button>
        <output>{submitted}</output>
        <ul>{submissions.map(submission => <li key={submission.id}>{submission.title}</li>)}</ul>
      </form>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);
  const form = target.querySelector("form")!;
  const input = target.querySelector("input")!;

  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(target.querySelector('[role="alert"]')?.textContent).toBe("Required.");
  expect(globalThis.integrationSetups.app).toBe(1);

  input.value = "hello";
  input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  expect(target.querySelector('[role="alert"]')).toBeNull();
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("output")?.textContent).toBe("HELLO");
  expect(target.querySelector("li")?.textContent).toBe("HELLO");
  expect(globalThis.integrationSetups.app).toBe(1);

  target.querySelector<HTMLButtonElement>("#remove")!.click();
  expect(target.querySelector("li")).toBeNull();
  expect(globalThis.integrationSetups.app).toBe(1);

  dispose();
});

test("nested keyed lists preserve and react to outer row state", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      globalThis.integrationSetups.app += 1;
      const groups = [{
        id: 1,
        name: "First",
        items: [{ id: 2, label: "Item" }],
      }];
      return <main>
        <button id="rename-group" onClick={() => groups[0].name = "Updated"}>Group</button>
        <button id="rename-item" onClick={() => groups[0].items[0].label = "Renamed"}>Item</button>
        {groups.map(group => <section key={group.id}>
          {group.items.map(item => <p key={item.id}>{group.name}: {item.label}</p>)}
        </section>)}
      </main>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);

  expect(target.querySelector("p")!.textContent).toBe("First: Item");
  target.querySelector<HTMLButtonElement>("#rename-group")!.click();
  expect(target.querySelector("p")!.textContent).toBe("Updated: Item");
  target.querySelector<HTMLButtonElement>("#rename-item")!.click();
  expect(target.querySelector("p")!.textContent).toBe("Updated: Renamed");
  expect(globalThis.integrationSetups.app).toBe(1);

  dispose();
});
