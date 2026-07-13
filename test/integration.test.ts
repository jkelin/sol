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
  delete (window.Element.prototype as { getAnimations?: unknown }).getAnimations;
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

function installAnimations(): Array<{ cancelled: boolean; finish(): void }> {
  const animations: Array<{ cancelled: boolean; finish(): void }> = [];
  const current = new WeakMap<
    Element,
    { signature: string; animation: Animation; controlled: { cancelled: boolean; finish(): void } }
  >();
  Object.defineProperty(window.Element.prototype, "getAnimations", {
    configurable: true,
    value(this: Element): Animation[] {
      const signature = [...this.classList]
        .filter((className) => className.startsWith("transition-"))
        .join(" ");
      if (!signature) return [];
      const existing = current.get(this);
      if (existing?.signature === signature) return [existing.animation];
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const controlled = { cancelled: false, finish };
      animations.push(controlled);
      const animation = {
        finished,
        cancel() {
          controlled.cancelled = true;
          finish();
        },
      } as unknown as Animation;
      current.set(this, { signature, animation, controlled });
      return [animation];
    },
  });
  return animations;
}

async function loadCompiled(source: string): Promise<Record<string, unknown>> {
  const result = compile(source, "Integration.tsx");
  const runtimeUrl = new URL("../src/runtime.ts", import.meta.url).href;
  const sourceWithRuntime = result.code
    .replace('"frontend-framework/runtime"', JSON.stringify(runtimeUrl))
    .replaceAll('"frontend-framework"', JSON.stringify(runtimeUrl));
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

test("compiled conditionals and keyed lists transition dynamic blocks", async () => {
  const animations = installAnimations();
  const module = await loadCompiled(`
    const fade = {
      enter: "transition-enter duration-100",
      leave: "transition-leave duration-100",
    };
    export const App = $component(function App() {
      let visible = true;
      let items = [{ id: 1 }, { id: 2 }];
      return <main>
        <button id="toggle" onClick={() => visible = !visible}>Toggle</button>
        <button id="remove" onClick={() => items.splice(0, 1)}>Remove</button>
        <button id="restore" onClick={() => items.unshift({ id: 1 })}>Restore</button>
        <button id="add" onClick={() => items.push({ id: 3 })}>Add</button>
        {visible && <p $transition={fade}>Visible</p>}
        <ul>{items.map(item => <li key={item.id} data-id={item.id} $transition={fade}>{item.id}</li>)}</ul>
      </main>;
    });
  `);
  const target = document.createElement("div");
  mount(module.App as Component, target);
  const initialParagraph = target.querySelector("p");

  expect(animations).toHaveLength(0);
  target.querySelector<HTMLButtonElement>("#toggle")!.click();
  expect(target.querySelector("p")).toBe(initialParagraph);
  expect(animations).toHaveLength(1);
  target.querySelector<HTMLButtonElement>("#toggle")!.click();
  expect(animations[0]!.cancelled).toBe(true);
  expect(target.querySelector("p")).toBe(initialParagraph);
  expect(animations).toHaveLength(2);

  const firstRow = target.querySelector('[data-id="1"]');
  target.querySelector<HTMLButtonElement>("#remove")!.click();
  expect(target.querySelector('[data-id="1"]')).toBe(firstRow);
  expect(animations).toHaveLength(3);
  target.querySelector<HTMLButtonElement>("#restore")!.click();
  expect(animations[2]!.cancelled).toBe(true);
  expect(target.querySelector('[data-id="1"]')).toBe(firstRow);
  expect([...target.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["1", "2"]);
  expect(animations).toHaveLength(4);

  target.querySelector<HTMLButtonElement>("#remove")!.click();
  expect(animations[3]!.cancelled).toBe(true);
  expect(animations).toHaveLength(5);
  animations[4]!.finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(target.querySelector('[data-id="1"]')).toBeNull();

  target.querySelector<HTMLButtonElement>("#add")!.click();
  expect(target.querySelector('[data-id="3"]')).not.toBeNull();
  expect(animations).toHaveLength(6);
});

test("compiled ternaries transition and reuse both branches", async () => {
  const animations = installAnimations();
  const module = await loadCompiled(`
    const fade = { enter: "transition-enter", leave: "transition-leave" };
    export const App = $component(function App() {
      let left = true;
      return <main>
        <button onClick={() => left = !left}>Swap</button>
        {left
          ? <p data-side="left" $transition={fade}>Left</p>
          : <p data-side="right" $transition={fade}>Right</p>}
      </main>;
    });
  `);
  const target = document.createElement("div");
  mount(module.App as Component, target);
  const left = target.querySelector('[data-side="left"]');

  target.querySelector("button")!.click();
  expect(animations).toHaveLength(2);
  expect(target.querySelector('[data-side="left"]')).toBe(left);
  expect(target.querySelector('[data-side="right"]')).not.toBeNull();

  target.querySelector("button")!.click();
  expect(animations[0]!.cancelled).toBe(true);
  expect(animations[1]!.cancelled).toBe(true);
  expect(animations).toHaveLength(4);
  expect(target.querySelector('[data-side="left"]')).toBe(left);
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

test("contexts compose with async components, Suspense, Await, and ErrorBoundary", async () => {
  const module = await loadCompiled(`
    import { $component, $context, Suspense, Await, ErrorBoundary } from "frontend-framework";

    const sharedContext = $context<{ label: string; count: number }>();

    const AsyncChild = $component(async function AsyncChild() {
      const shared = sharedContext.use();
      const data = await Promise.resolve({ text: "async" });
      shared.count += 1;
      return <p id="async-result">{shared.label}:{data.text}:{shared.count}</p>;
    });

    const ContextChild = $component(function ContextChild() {
      const shared = sharedContext.use();
      return <button id="context-result" onClick={() => shared.count += 1}>
        {shared.label}:{shared.count}
      </button>;
    });

    export const App = $component(function App() {
      const shared = { label: "provided", count: 0 };
      const promise = Promise.resolve({ text: "awaited" });
      return <sharedContext.Provider data={shared}>
        <ErrorBoundary fallback={error => <p id="boundary-error">{String(error)}</p>}>
          <Suspense fallback={<p id="loading">Loading</p>} error={error => <p>{String(error)}</p>}>
            <main>
              <button id="replace-context" onClick={() => shared = { label: "replaced", count: 10 }}>
                Replace
              </button>
              <ContextChild />
              <AsyncChild />
              <Await $promise={promise} error={error => <p>{String(error)}</p>}>
                {data => <p id="await-result">{data.text}</p>}
              </Await>
            </main>
          </Suspense>
        </ErrorBoundary>
      </sharedContext.Provider>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);

  expect(target.querySelector("#loading")?.textContent).toBe("Loading");
  expect(target.querySelector("main")).toBeNull();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(target.querySelector("#loading")).toBeNull();
  expect(target.querySelector("#async-result")?.textContent).toBe("provided:async:1");
  expect(target.querySelector("#await-result")?.textContent).toBe("awaited");
  expect(target.querySelector("#context-result")?.textContent).toBe("provided:1");
  target.querySelector<HTMLButtonElement>("#context-result")!.click();
  expect(target.querySelector("#context-result")?.textContent).toBe("provided:2");
  target.querySelector<HTMLButtonElement>("#replace-context")!.click();
  expect(target.querySelector("#context-result")?.textContent).toBe("replaced:10");

  dispose();
  expect(target.childNodes).toHaveLength(0);
});

test("context optional reads and local Await errors work without Suspense", async () => {
  const module = await loadCompiled(`
    import { $component, $context, Await } from "frontend-framework";
    const optionalContext = $context<{ value: string }>();
    export const App = $component(function App() {
      const optional = optionalContext.useOptional();
      const promise = Promise.reject(new Error("Rejected locally"));
      return <main>
        <p id="optional">{optional === undefined ? "missing" : optional.value}</p>
        <Await $promise={promise} error={error => <p id="await-error">{String(error)}</p>}>
          {data => <p>{String(data)}</p>}
        </Await>
      </main>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);

  expect(target.querySelector("#optional")?.textContent).toBe("missing");
  expect(target.querySelector("#await-error")).toBeNull();
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("#await-error")?.textContent).toContain("Rejected locally");

  dispose();
});

test("missing contexts throw and ErrorBoundary catches sync and async render failures", async () => {
  const missingModule = await loadCompiled(`
    import { $component, $context } from "frontend-framework";
    const missingContext = $context<{ value: string }>();
    export const App = $component(function App() {
      const value = missingContext.use();
      return <p>{value.value}</p>;
    });
  `);
  const target = document.createElement("div");
  expect(() => mount(missingModule.App as Component, target)).toThrow(
    "Context is not available outside its Provider",
  );

  const boundaryModule = await loadCompiled(`
    import { $component, ErrorBoundary } from "frontend-framework";
    const SyncFailure = $component(function SyncFailure() {
      throw new Error("sync failure");
      return <p>unreachable</p>;
    });
    const AsyncFailure = $component(async function AsyncFailure() {
      await Promise.resolve();
      throw new Error("async failure");
      return <p>unreachable</p>;
    });
    export const App = $component(function App() {
      return <main>
        <ErrorBoundary fallback={error => <p id="sync-error">{String(error)}</p>}>
          <SyncFailure />
        </ErrorBoundary>
        <ErrorBoundary fallback={error => <p id="async-error">{String(error)}</p>}>
          <AsyncFailure />
        </ErrorBoundary>
      </main>;
    });
  `);
  const dispose = mount(boundaryModule.App as Component, target);
  expect(target.querySelector("#sync-error")?.textContent).toContain("sync failure");
  expect(target.querySelector("#async-error")).toBeNull();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("#async-error")?.textContent).toContain("async failure");
  dispose();
});

test("Await replaces stale promises and re-enters its Suspense fallback", async () => {
  const module = await loadCompiled(`
    import { $component, Await, Suspense } from "frontend-framework";
    let resolveFirst!: (value: string) => void;
    const first = new Promise<string>(resolve => resolveFirst = resolve);
    export function settleFirst() { resolveFirst("stale"); }
    export const App = $component(function App() {
      let promise = first;
      return <main>
        <button id="replace" onClick={() => promise = Promise.resolve("fresh")}>Replace</button>
        <Suspense fallback={<p id="replacement-loading">Loading</p>}>
          <section><Await $promise={promise}>{value => <p id="replacement-value">{value}</p>}</Await></section>
        </Suspense>
      </main>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);
  expect(target.querySelector("#replacement-loading")).not.toBeNull();

  target.querySelector<HTMLButtonElement>("#replace")!.click();
  expect(target.querySelector("#replacement-loading")).not.toBeNull();
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("#replacement-value")?.textContent).toBe("fresh");

  (module.settleFirst as () => void)();
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("#replacement-value")?.textContent).toBe("fresh");
  dispose();
});

test("nested and sibling providers select the nearest context value", async () => {
  const module = await loadCompiled(`
    import { $component, $context } from "frontend-framework";
    const context = $context<{ value: string }>();
    const Consumer = $component(function Consumer(props: { id: string }) {
      const data = context.use();
      return <p id={props.id}>{data.value}</p>;
    });
    export const App = $component(function App() {
      const outer = { value: "outer" };
      const inner = { value: "inner" };
      const sibling = { value: "sibling" };
      return <main>
        <context.Provider data={outer}>
          <Consumer id="outer-context" />
          <context.Provider data={inner}><Consumer id="inner-context" /></context.Provider>
        </context.Provider>
        <context.Provider data={sibling}><Consumer id="sibling-context" /></context.Provider>
      </main>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);

  expect(target.querySelector("#outer-context")?.textContent).toBe("outer");
  expect(target.querySelector("#inner-context")?.textContent).toBe("inner");
  expect(target.querySelector("#sibling-context")?.textContent).toBe("sibling");
  dispose();
});

test("nested Suspense owns its work while a parent waits for multiple promises", async () => {
  const module = await loadCompiled(`
    import { $component, Await, Suspense } from "frontend-framework";
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    let resolveNested!: (value: string) => void;
    const first = new Promise<string>(resolve => resolveFirst = resolve);
    const second = new Promise<string>(resolve => resolveSecond = resolve);
    const nested = new Promise<string>(resolve => resolveNested = resolve);
    export function settleFirst() { resolveFirst("first"); }
    export function settleSecond() { resolveSecond("second"); }
    export function settleNested() { resolveNested("nested"); }
    export const App = $component(function App() {
      return <Suspense fallback={<p id="outer-loading">Outer loading</p>}>
        <section id="outer-content">
          <Await $promise={first}>{value => <p id="first-value">{value}</p>}</Await>
          <Await $promise={second}>{value => <p id="second-value">{value}</p>}</Await>
          <Suspense fallback={<p id="nested-loading">Nested loading</p>}>
            <Await $promise={nested}>{value => <p id="nested-value">{value}</p>}</Await>
          </Suspense>
        </section>
      </Suspense>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);
  const settle = async (name: "settleFirst" | "settleSecond" | "settleNested") => {
    (module[name] as () => void)();
    await Promise.resolve();
    await Promise.resolve();
  };

  expect(target.querySelector("#outer-loading")).not.toBeNull();
  await settle("settleFirst");
  expect(target.querySelector("#outer-loading")).not.toBeNull();
  await settle("settleSecond");
  expect(target.querySelector("#outer-content")).not.toBeNull();
  expect(target.querySelector("#first-value")?.textContent).toBe("first");
  expect(target.querySelector("#second-value")?.textContent).toBe("second");
  expect(target.querySelector("#nested-loading")).not.toBeNull();
  await settle("settleNested");
  expect(target.querySelector("#nested-value")?.textContent).toBe("nested");
  dispose();
});

test("async rejections prefer Await, then Suspense, then ErrorBoundary", async () => {
  const module = await loadCompiled(`
    import { $component, Await, ErrorBoundary, Suspense } from "frontend-framework";
    export const App = $component(function App() {
      const localFailure = Promise.reject(new Error("local"));
      const suspenseFailure = Promise.reject(new Error("suspense"));
      const boundaryFailure = Promise.reject(new Error("boundary"));
      return <main>
        <ErrorBoundary fallback={error => <p id="unexpected-local-boundary">{String(error)}</p>}>
          <Suspense fallback={<p>Loading</p>} error={error => <p id="unexpected-local-suspense">{String(error)}</p>}>
            <Await $promise={localFailure} error={error => <p id="local-error">{String(error)}</p>}>
              {value => <p>{value}</p>}
            </Await>
          </Suspense>
        </ErrorBoundary>
        <ErrorBoundary fallback={error => <p id="unexpected-suspense-boundary">{String(error)}</p>}>
          <Suspense fallback={<p>Loading</p>} error={error => <p id="suspense-error">{String(error)}</p>}>
            <Await $promise={suspenseFailure}>{value => <p>{value}</p>}</Await>
          </Suspense>
        </ErrorBoundary>
        <ErrorBoundary fallback={error => <p id="boundary-error">{String(error)}</p>}>
          <Suspense fallback={<p>Loading</p>}>
            <Await $promise={boundaryFailure}>{value => <p>{value}</p>}</Await>
          </Suspense>
        </ErrorBoundary>
      </main>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(target.querySelector("#local-error")?.textContent).toContain("local");
  expect(target.querySelector("#unexpected-local-suspense")).toBeNull();
  expect(target.querySelector("#unexpected-local-boundary")).toBeNull();
  expect(target.querySelector("#suspense-error")?.textContent).toContain("suspense");
  expect(target.querySelector("#unexpected-suspense-boundary")).toBeNull();
  expect(target.querySelector("#boundary-error")?.textContent).toContain("boundary");
  dispose();
});
