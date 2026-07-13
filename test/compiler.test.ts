import { describe, expect, test } from "bun:test";
import { SourceMapConsumer } from "source-map-js";
import { compile } from "../src/compiler.ts";

describe("compiler", () => {
  test("compiles exported route declarations and path parameters", () => {
    const result = compile(
      `
      import { $component, $route } from "frontend-framework";
      const Blog = $component(function Blog() { return <main>Blog</main>; });
      export const blog = $route({ path: "/blog/:id" }, Blog);
    `,
      "blog.route.tsx",
    );

    expect(result.code).toContain("export const blog = __ff_route");
    expect(result.code).toContain('"pattern":"^/blog/([^/]+)$"');
    expect(result.code).toContain('"parameterNames":["id"]');
    expect(result.code).toContain('"specificity":[1,0]');

    for (const extension of ["js", "jsx", "ts", "tsx"]) {
      const routeModule = compile(
        `import { Page } from "./Page";
         export const page = $route({ path: "/page" }, Page);`,
        `page.route.${extension}`,
      );
      expect(routeModule.code).toContain("export const page = __ff_route");
    }
  });

  test("validates the compile-time route boundary", () => {
    const component = `
      const Blog = $component(function Blog() { return <main>Blog</main>; });
    `;
    expect(() =>
      compile(`${component} export const blog = $route({ path: "/blog/:id" }, Blog);`, "Blog.tsx"),
    ).toThrow("only valid in *.route.[jt]sx? files");
    expect(() =>
      compile(`${component} const blog = $route({ path: "/blog/:id" }, Blog);`, "blog.route.tsx"),
    ).toThrow("must be exported");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "blog/:id" }, Blog);`,
        "blog.route.tsx",
      ),
    ).toThrow("start with exactly one slash");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog/:id/:id" }, Blog);`,
        "blog.route.tsx",
      ),
    ).toThrow("Duplicate route parameter id");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog/" }, Blog);`,
        "blog.route.tsx",
      ),
    ).toThrow("empty or trailing segments");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog?draft=1" }, Blog);`,
        "blog.route.tsx",
      ),
    ).toThrow("must not contain a query string or hash");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog" }, Missing);`,
        "blog.route.tsx",
      ),
    ).toThrow("must reference a compiled component");
  });

  test("compiles $component setup into inferred signals, computeds, and DOM effects", () => {
    const source = `
      import { $component } from "frontend-framework";
      export const Counter = $component(function Counter(props: { label: string }) {
        let count = 0;
        const doubled = count * 2;
        function increment() { count++; }
        return <button className={["counter", { active: count > 0 }]} onClick={increment} disabled={count > 2}>
          {props.label}: {count} / {doubled}
        </button>;
      });
    `;
    const result = compile(source, "Counter.tsx");

    expect(result.code).toContain("const Counter = __ff_component");
    expect(result.code).toContain("const count = __ff_signal(0)");
    expect(result.code).toContain(
      "const doubled = __ff_computed(() => (count.value * 2), __ff_frame)",
    );
    expect(result.code).toContain("count.value++");
    expect(result.code).toContain("__ff_event");
    expect(result.code).toContain("__ff_attribute");
    expect(result.code).toContain("__ff_text");
    expect(result.code).not.toContain("$component(function");
    expect(result.map?.sources).toContain("Counter.tsx");
    expect(result.map?.sourcesContent).toEqual([source]);
  });

  test("maps generated setup and DOM effects to their authored locations", () => {
    const source = [
      'import { $component } from "frontend-framework";',
      "const Counter = $component(function Counter() {",
      "  let count = 0;",
      "  function increment() { count++; }",
      "  return <button onClick={increment}>{count}</button>;",
      "});",
    ].join("\n");
    const result = compile(source, "Mapped.tsx");
    const consumer = new SourceMapConsumer(JSON.parse(result.map!.toString()));
    const originalFor = (needle: string) => {
      const offset = result.code.indexOf(needle);
      expect(offset).toBeGreaterThanOrEqual(0);
      const prefix = result.code.slice(0, offset);
      const lines = prefix.split("\n");
      return consumer.originalPositionFor({
        line: lines.length,
        column: lines.at(-1)!.length,
      });
    };

    expect(originalFor("const count = __ff_signal").line).toBe(3);
    expect(originalFor("function increment").line).toBe(4);
    expect(originalFor("__ff_event(__ff_view").line).toBe(5);
    expect(originalFor("__ff_text(__ff_view").line).toBe(5);
  });

  test("compiles inferred bindings, conditionals, components, and keyed maps", () => {
    const result = compile(
      `
      import { $component } from "frontend-framework";
      const Row = $component(function Row(props: { todo: { id: number; done: boolean } }) {
        return <li><input type="checkbox" $bind={props.todo.done} /></li>;
      });
      const App = $component(function App() {
        let draft = "";
        const todos = [{ id: 1, done: false }];
        return <main>
          <input $bind={draft} />
          {todos.length ? <ul>{todos.map(todo => <Row key={todo.id} todo={todo} />)}</ul> : <p>Empty</p>}
        </main>;
      });
    `,
      "App.tsx",
    );

    expect(result.code).toContain('__ff_bind(__ff_view.elements[0], "checked"');
    expect(result.code).toContain('__ff_bind(__ff_view.elements[0], "value"');
    expect(result.code).toContain("__ff_when");
    expect(result.code).toContain("__ff_list");
    expect(result.code).toContain("__ff_child");
  });

  test("compiles intrinsic transition directives and rejects invalid placements", () => {
    const result = compile(
      `
      const fade = { enter: "fade-in duration-100" };
      const App = $component(function App() { return <main $transition={fade}>Ready</main>; });
    `,
      "Transitions.tsx",
    );

    expect(result.code).toContain("__ff_transition(__ff_view.elements[0], () => (fade))");
    expect(result.code).not.toContain('$transition="');
    expect(() =>
      compile(
        `const Child = $component(function Child() { return <p>Child</p>; });
         const App = $component(function App() { return <Child $transition={{}} />; });`,
        "InvalidTransition.tsx",
      ),
    ).toThrow("$transition is only valid on intrinsic elements");
    expect(() =>
      compile(
        `const App = $component(function App() { return <p $transition="fade">Child</p>; });`,
        "InvalidTransition.tsx",
      ),
    ).toThrow("requires an expression");
  });

  test("keeps outer row state distinct in nested keyed lists", () => {
    const result = compile(
      `
      const App = $component(function App() {
        const groups = [{ id: 1, name: "First", items: [{ id: 2, label: "Item" }] }];
        return <main>{groups.map(group =>
          <section key={group.id}>{group.items.map(item =>
            <p key={item.id}>{group.name}: {item.label}</p>
          )}</section>
        )}</main>;
      });
    `,
      "NestedLists.tsx",
    );

    expect(result.code).toContain("__ff_item_0.value.name");
    expect(result.code).toContain("__ff_item_1.value.label");
    expect(result.code).toContain("(__ff_item_0, __ff_index_0)");
    expect(result.code).toContain("(__ff_item_1, __ff_index_1)");
  });

  test("supports explicit reactive overrides and every class alias", () => {
    const result = compile(
      `
      import { $component, $computed, $signal } from "frontend-framework";
      const App = $component(function App() {
        const count = $signal(1);
        const doubled = $computed(() => count * 2);
        return <main>
          <p class="static">{count}</p>
          <p className={{ active: count > 0 }}>{doubled}</p>
          <p classNames={["row", { done: false }]}>{count}</p>
        </main>;
      });
    `,
      "Aliases.tsx",
    );

    expect(result.code).toContain("__ff_signal(1)");
    expect(result.code).toContain("__ff_computed(() => count.value * 2, __ff_frame)");
    expect(result.code).toContain('<p class="static">');
    expect(result.code.match(/__ff_attribute\(/g)?.length).toBe(2);
  });

  test("infers value and checked bindings for every supported form control", () => {
    const result = compile(
      `
      import { $component } from "frontend-framework";
      const Form = $component(function Form() {
        let text = "";
        let selected = "all";
        let checked = false;
        return <form>
          <textarea $bind={text}></textarea>
          <select $bind={selected}><option value="all">All</option></select>
          <input type="radio" $bind={checked} />
        </form>;
      });
    `,
      "Form.tsx",
    );

    expect(result.code.match(/__ff_bind\([^\n]+"value"/g)?.length).toBe(2);
    expect(result.code.match(/__ff_bind\([^\n]+"checked"/g)?.length).toBe(1);
  });

  test("connects form controllers through the $form element property", () => {
    const result = compile(
      `
      import { $component, $form } from "frontend-framework";
      const Form = $component(function Form() {
        const controller = $form({ schema: value => value, defaultValues: { title: "" } }, () => {});
        return <form $form={controller}><input name="title" $bind={controller.values.title} /></form>;
      });
    `,
      "Form.tsx",
    );

    expect(result.code).toContain('"submit", () => ((controller.value).submit)');
    expect(result.code).toContain('"input", () => ((controller.value).handleInput)');
    expect(result.code).toContain('"focusout", () => ((controller.value).handleBlur)');
    expect(result.code).not.toContain('$form="');
  });

  test("resolves component declarations independently of capitalization", () => {
    const result = compile(
      `
      import { $component } from "frontend-framework";
      const row = $component(function row() { return <span>Row</span>; });
      const app = $component(function app() { return <row />; });
    `,
      "Lowercase.tsx",
    );

    expect(result.code).toContain("const row = __ff_component");
    expect(result.code).toContain("__ff_child");
    expect(result.code).not.toContain("<row>");
  });

  test("compiles contexts, async components, suspense, await, and error boundaries", () => {
    const result = compile(
      `
      import { $component, $context, Suspense, Await, ErrorBoundary } from "frontend-framework";
      const messageContext = $context<{ message: string }>();
      const AsyncChild = $component(async function AsyncChild() {
        const context = messageContext.use();
        const data = await Promise.resolve({ text: "ready" });
        return <p>{context.message}: {data.text}</p>;
      });
      const App = $component(function App() {
        const shared = { message: "hello" };
        const promise = Promise.resolve({ text: "awaited" });
        return <messageContext.Provider data={shared}>
          <ErrorBoundary fallback={error => <p>{String(error)}</p>}>
            <Suspense fallback={<p>Loading</p>} error={error => <p>{String(error)}</p>}>
              <AsyncChild />
              <Await $promise={promise} error={error => <p>{String(error)}</p>}>
                {data => <p>{data.text}</p>}
              </Await>
            </Suspense>
          </ErrorBoundary>
        </messageContext.Provider>;
      });
    `,
      "AsyncContext.tsx",
    );

    expect(result.code).toContain("__ff_component(async (");
    expect(result.code).toContain("__ff_context_provider");
    expect(result.code).toContain("__ff_error_boundary");
    expect(result.code).toContain("__ff_suspense");
    expect(result.code).toContain("__ff_await");
  });

  test("validates async boundary and context provider JSX contracts", () => {
    const cases = [
      {
        source: `import { $component, Suspense } from "frontend-framework"; const App = $component(function App() { return <Suspense><p>Child</p></Suspense>; });`,
        message: "JSX property fallback is required",
      },
      {
        source: `import { $component, Await } from "frontend-framework"; const App = $component(function App() { return <Await $promise={Promise.resolve(1)} />; });`,
        message: "Await requires exactly one inline data-renderer child",
      },
      {
        source: `import { $component, ErrorBoundary } from "frontend-framework"; const App = $component(function App() { return <ErrorBoundary fallback={<p>Error</p>}><p>Child</p></ErrorBoundary>; });`,
        message: "Error and data renderers must be inline functions",
      },
      {
        source: `import { $component, $context } from "frontend-framework"; const context = $context<{ value: string }>(); const App = $component(function App() { return <context.Provider><p>Child</p></context.Provider>; });`,
        message: "JSX property data is required",
      },
      {
        source: `import { $component, Await } from "frontend-framework"; const App = $component(function App() { return <Await $promise={123}>{value => <p>{value}</p>}</Await>; });`,
        message: "Await $promise must be a promise expression",
      },
      {
        source: `import { $component, $context } from "frontend-framework"; const context = $context<{ value: string }>(); const App = $component(function App() { return <context.Provider data={123}><p>Child</p></context.Provider>; });`,
        message: "Context Provider data must be an object expression",
      },
    ];

    for (const fixture of cases) {
      expect(() => compile(fixture.source, "AsyncBoundary.tsx")).toThrow(fixture.message);
    }

    expect(() =>
      compile(
        `import { $component, $context } from "frontend-framework"; const context = $context<RegExp>(); const App = $component(function App() { return <context.Provider data={/valid object/}><p>Child</p></context.Provider>; });`,
        "RegexContext.tsx",
      ),
    ).not.toThrow();
  });

  test("reports invalid component, binding, class, and list interfaces with locations", () => {
    expect(() =>
      compile(
        `
      const App = $component(function App() {
        let controller = {};
        return <input $form={controller} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$form is only valid on form elements");

    expect(() =>
      compile(
        `
      const App = $component(function App() {
        let controller = {};
        return <form $form={controller} onSubmit={() => {}}></form>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$form already handles onSubmit");

    expect(() =>
      compile(
        `
      import { signal } from "frontend-framework";
      export const value = signal(1);
    `,
        "Invalid.tsx",
      ),
    ).toThrow("signal() was renamed to $signal()");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App({ name }: { name: string }) {
        return <p>{name}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("Component props must use one identifier");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App(props: { values: string[] }) {
        return <ul>{props.values.map(value => <li>{value}</li>)}</ul>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("Every JSX .map() row requires a key attribute");

    expect(() =>
      compile(
        `
      function App() { return <p>Not compiled</p>; }
    `,
        "Invalid.tsx",
      ),
    ).toThrow(/Invalid\.tsx:2:.*\$component/s);

    expect(() =>
      compile(
        `
      import type { Missing } from "./types";
      import { $component } from "frontend-framework";
      const App = $component(function App() { return <Missing />; });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("JSX component Missing must be declared with $component() or imported");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        let value = false;
        let kind = "checkbox";
        return <input type={kind} $bind={value} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$bind requires a static input type");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        return <input $bind={"snapshot"} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$bind requires writable component state");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        let value = "";
        return <input bind:value={value} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("bind:* was removed");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        return <p class="one" className="two">Duplicate</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("Use only one of class, className, or classNames");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        let source = 1;
        const doubled = source * 2;
        function invalid() { doubled = 3; }
        return <p>{doubled}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("Computed component value doubled is readonly");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        const later = source + 1;
        let source = 1;
        return <p>{later}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("cannot reference later binding source");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        const value = value + 1;
        return <p>{value}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("cannot reference itself");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        let values = [1];
        const length = values.push(2);
        return <p>{length}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("must not call mutating collection methods");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        let source = 1;
        const doubled = source * 2;
        return <input $bind={doubled} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$bind cannot target a computed value");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App(props: { value: string }) {
        return <input $bind={props.value} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("readonly component prop");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const Child = $component(function Child() { return <p>Child</p>; });
      const App = $component(function App() {
        let value = "";
        return <Child $bind={value} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$bind is only valid on intrinsic form elements");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      function makeComponent() {
        return $component(function Nested() { return null as never; });
      }
    `,
        "Invalid.tsx",
      ),
    ).toThrow("direct top-level const initializer");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App(props: { ready: boolean }) {
        if (!props.ready) return <p>Waiting</p>;
        return <p>Ready</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("Early component returns are not supported");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(function App(props: { value: string }) {
        return <div {...props}>{props.value}</div>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("JSX spread attributes are not supported");

    expect(() =>
      compile(
        `
      import { $component } from "frontend-framework";
      const App = $component(() => <p>Arrow</p>);
    `,
        "Invalid.tsx",
      ),
    ).toThrow("exactly one named function expression");
  });

  test("enforces component and expression boundary diagnostics", () => {
    const cases = [
      {
        source: `const App = $component(async function App() { return <p>Async</p>; });`,
        message: "__accept_async__",
      },
      {
        source: `const App = $component(function* App() { return <p>Generator</p>; });`,
        message: "Components must not be generator functions",
      },
      {
        source: `const App = $component(function App() { return <p>One</p>; }), other = 1;`,
        message: "sole initializer",
      },
      {
        source: `const App = $component(function App() { function read() { return ""; } return <input $bind={read()} />; });`,
        message: "$bind requires writable component state",
      },
      {
        source: `const App = $component(function App() { const state = { value: "" }; return <input $bind={state?.value} />; });`,
        message: "$bind requires writable component state",
      },
      {
        source: `const App = $component(function App() { let values = [1]; const copy = values.slice(); function mutate() { copy.push(2); } return <p>{copy.length}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App(props: { Row: unknown }) { return <props.Row />; });`,
        message: "Dynamic and namespaced JSX tag names are not supported",
      },
    ];

    for (const fixture of cases) {
      if (fixture.message === "__accept_async__") {
        expect(() => compile(fixture.source, "Boundary.tsx")).not.toThrow();
      } else {
        expect(() => compile(fixture.source, "Boundary.tsx")).toThrow(fixture.message);
      }
    }
  });

  test("protects compiler identifiers and component import classification", () => {
    expect(() =>
      compile(
        `
      const __ff_signal = 1;
      const App = $component(function App() { return <p>{__ff_signal}</p>; });
    `,
        "ReservedModule.tsx",
      ),
    ).toThrow("reserved compiler prefix __ff_");

    expect(() =>
      compile(
        `
      const App = $component(function App() {
        let __ff_view = 1;
        return <p>{__ff_view}</p>;
      });
    `,
        "ReservedComponent.tsx",
      ),
    ).toThrow("reserved compiler prefix __ff_");

    expect(() =>
      compile(
        `
      import { $component, Fragment } from "frontend-framework";
      const App = $component(function App() { return <Fragment />; });
    `,
        "FrameworkImport.tsx",
      ),
    ).toThrow("must be declared with $component() or imported");

    const externalComponent = compile(
      `
      import { $component } from "frontend-framework";
      import { Row } from "./Row";
      const App = $component(function App() { return <Row />; });
    `,
      "ExternalComponent.tsx",
    );
    expect(externalComponent.code).toContain("__ff_child");
  });

  test("validates binding roots, readonly props, and event spelling", () => {
    const valid = compile(
      `
      import { $component } from "frontend-framework";
      const App = $component(function App(props: { todo: { done: boolean } }) {
        let todos = [{ id: 1, done: false }];
        function updateNestedProp() { props.todo.done = true; }
        return <main onClick={updateNestedProp}>
          <input type="checkbox" $bind={props.todo.done} />
          {todos.map(todo => <input key={todo.id} type="checkbox" $bind={todo.done} />)}
        </main>;
      });
    `,
      "ValidBoundaries.tsx",
    );
    expect(valid.code.match(/__ff_bind/g)?.length).toBeGreaterThanOrEqual(2);

    expect(() =>
      compile(
        `
      const App = $component(function App(props: { done: boolean }) {
        const rows = [{ id: 1, done: false }];
        const derived = rows.length;
        return <main>
          {rows.map(props => <input key={props.id} type="checkbox" $bind={props.done} />)}
          {rows.map(derived => <input key={derived.id} type="checkbox" $bind={derived.done} />)}
        </main>;
      });
    `,
        "ShadowedRowBindings.tsx",
      ),
    ).not.toThrow();

    expect(() =>
      compile(
        `
      const App = $component(function App(props: { value: number }) {
        function updateShadow(props: { value: number }) { props.value = 2; }
        return <button onClick={() => updateShadow({ value: 1 })}>{props.value}</button>;
      });
    `,
        "ShadowedProps.tsx",
      ),
    ).not.toThrow();

    for (const expression of ["external.value", "Math.value"]) {
      expect(() =>
        compile(
          `
        import { $component } from "frontend-framework";
        const external = { value: "" };
        const App = $component(function App() { return <input $bind={${expression}} />; });
      `,
          "InvalidBindingRoot.tsx",
        ),
      ).toThrow("must be rooted in component state");
    }

    for (const statement of [
      "props.value = 2;",
      "delete props.value;",
      "Object.defineProperty(props, 'value', { value: 2 });",
      "Reflect.defineProperty(props, 'value', { value: 2 });",
      "Object.setPrototypeOf(props, null);",
      "Reflect.setPrototypeOf(props, null);",
      "Object.preventExtensions(props);",
      "Reflect.preventExtensions(props);",
    ]) {
      expect(() =>
        compile(
          `
        import { $component } from "frontend-framework";
        const App = $component(function App(props: { value: number }) {
          function mutate() { ${statement} }
          return <button onClick={mutate}>{props.value}</button>;
        });
      `,
          "ReadonlyProps.tsx",
        ),
      ).toThrow("Component props are readonly");
    }

    expect(() =>
      compile(
        `
      const App = $component(function App(props: { value: number }) {
        function helper(Object: { defineProperty: (...args: unknown[]) => void }) {
          Object.defineProperty(props, "value", { value: 2 });
        }
        return <button onClick={() => helper({ defineProperty() {} })}>{props.value}</button>;
      });
    `,
        "ShadowedObject.tsx",
      ),
    ).not.toThrow();

    expect(() =>
      compile(
        `
      const App = $component(function App(props: { value: number }) {
        return <button onClick={() => props.value++}>{props.value}</button>;
      });
    `,
        "InlineReadonlyProps.tsx",
      ),
    ).toThrow("Component props are readonly");

    for (const eventName of ["onclick", "on-click", "on1Click", "OnClick"]) {
      expect(() =>
        compile(
          `
        const App = $component(function App() { return <button ${eventName}={() => {}}>Run</button>; });
      `,
          "InvalidEvent.tsx",
        ),
      ).toThrow("React-style onEvent capitalization");
    }

    expect(() =>
      compile(
        `
      const App = $component(function App() {
        let values = [1];
        return <ul>{values.map(value => { const label = value; return <li key={value}>{label}</li>; })}</ul>;
      });
    `,
        "LegacyWording.tsx",
      ),
    ).toThrow("component or $computed()");
  });
});
