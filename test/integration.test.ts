import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import ts from "typescript";
import { compile } from "../src/compiler.ts";
import { mount, type Component } from "../src/runtime.ts";

interface SetupCounts {
  app: number;
  child: number;
}

declare global {
  var integrationSetups: SetupCounts;
}

let window: Window;

beforeEach(() => {
  window = new Window();
  globalThis.integrationSetups = { app: 0, child: 0 };
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

  target.querySelector<HTMLButtonElement>("#toggle")!.click();
  expect(target.querySelector("p")).toBeNull();
  expect(globalThis.integrationSetups).toEqual({ app: 1, child: 2 });

  dispose();
  expect(target.childNodes).toHaveLength(0);
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
