import { describe, expect, test } from "bun:test";
import { compile } from "../src/compiler.ts";

describe("compiler", () => {
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
    expect(result.code).toContain("const doubled = __ff_computed(() => (count.value * 2))");
    expect(result.code).toContain("count.value++");
    expect(result.code).toContain("__ff_event");
    expect(result.code).toContain("__ff_attribute");
    expect(result.code).toContain("__ff_text");
    expect(result.code).not.toContain("$component(function");
    expect(result.map?.sources).toContain("Counter.tsx");
    expect(result.map?.sourcesContent).toEqual([source]);
  });

  test("compiles inferred bindings, conditionals, components, and keyed maps", () => {
    const result = compile(`
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
    `, "App.tsx");

    expect(result.code).toContain('__ff_bind(__ff_view.elements[0], "checked"');
    expect(result.code).toContain('__ff_bind(__ff_view.elements[0], "value"');
    expect(result.code).toContain("__ff_when");
    expect(result.code).toContain("__ff_list");
    expect(result.code).toContain("__ff_child");
  });

  test("supports explicit reactive overrides and every class alias", () => {
    const result = compile(`
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
    `, "Aliases.tsx");

    expect(result.code).toContain("__ff_signal(1)");
    expect(result.code).toContain("__ff_computed(() => count.value * 2)");
    expect(result.code).toContain('<p class="static">');
    expect(result.code.match(/__ff_attribute\(/g)?.length).toBe(2);
  });

  test("infers value and checked bindings for every supported form control", () => {
    const result = compile(`
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
    `, "Form.tsx");

    expect(result.code.match(/__ff_bind\([^\n]+"value"/g)?.length).toBe(2);
    expect(result.code.match(/__ff_bind\([^\n]+"checked"/g)?.length).toBe(1);
  });

  test("resolves component declarations independently of capitalization", () => {
    const result = compile(`
      import { $component } from "frontend-framework";
      const row = $component(function row() { return <span>Row</span>; });
      const app = $component(function app() { return <row />; });
    `, "Lowercase.tsx");

    expect(result.code).toContain("const row = __ff_component");
    expect(result.code).toContain("__ff_child");
    expect(result.code).not.toContain("<row>");
  });

  test("reports invalid component, binding, class, and list interfaces with locations", () => {
    expect(() => compile(`
      import { signal } from "frontend-framework";
      export const value = signal(1);
    `, "Invalid.tsx")).toThrow("signal() was renamed to $signal()");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App({ name }: { name: string }) {
        return <p>{name}</p>;
      });
    `, "Invalid.tsx")).toThrow("Component props must use one identifier");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App(props: { values: string[] }) {
        return <ul>{props.values.map(value => <li>{value}</li>)}</ul>;
      });
    `, "Invalid.tsx")).toThrow("Every JSX .map() row requires a key attribute");

    expect(() => compile(`
      function App() { return <p>Not compiled</p>; }
    `, "Invalid.tsx")).toThrow(/Invalid\.tsx:2:.*\$component/s);

    expect(() => compile(`
      import type { Missing } from "./types";
      import { $component } from "frontend-framework";
      const App = $component(function App() { return <Missing />; });
    `, "Invalid.tsx")).toThrow("JSX component Missing must be declared with $component() or imported");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        let value = false;
        let kind = "checkbox";
        return <input type={kind} $bind={value} />;
      });
    `, "Invalid.tsx")).toThrow("$bind requires a static input type");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        return <input $bind={"snapshot"} />;
      });
    `, "Invalid.tsx")).toThrow("$bind requires writable component state");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        let value = "";
        return <input bind:value={value} />;
      });
    `, "Invalid.tsx")).toThrow("bind:* was removed");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        return <p class="one" className="two">Duplicate</p>;
      });
    `, "Invalid.tsx")).toThrow("Use only one of class, className, or classNames");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        let source = 1;
        const doubled = source * 2;
        function invalid() { doubled = 3; }
        return <p>{doubled}</p>;
      });
    `, "Invalid.tsx")).toThrow("Computed component value doubled is readonly");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        const later = source + 1;
        let source = 1;
        return <p>{later}</p>;
      });
    `, "Invalid.tsx")).toThrow("cannot reference later binding source");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        const value = value + 1;
        return <p>{value}</p>;
      });
    `, "Invalid.tsx")).toThrow("cannot reference itself");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        let values = [1];
        const length = values.push(2);
        return <p>{length}</p>;
      });
    `, "Invalid.tsx")).toThrow("must not call mutating collection methods");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App() {
        let source = 1;
        const doubled = source * 2;
        return <input $bind={doubled} />;
      });
    `, "Invalid.tsx")).toThrow("$bind cannot target a computed value");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App(props: { value: string }) {
        return <input $bind={props.value} />;
      });
    `, "Invalid.tsx")).toThrow("readonly component prop");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const Child = $component(function Child() { return <p>Child</p>; });
      const App = $component(function App() {
        let value = "";
        return <Child $bind={value} />;
      });
    `, "Invalid.tsx")).toThrow("$bind is only valid on intrinsic form elements");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      function makeComponent() {
        return $component(function Nested() { return null as never; });
      }
    `, "Invalid.tsx")).toThrow("direct top-level const initializer");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App(props: { ready: boolean }) {
        if (!props.ready) return <p>Waiting</p>;
        return <p>Ready</p>;
      });
    `, "Invalid.tsx")).toThrow("Early component returns are not supported");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(function App(props: { value: string }) {
        return <div {...props}>{props.value}</div>;
      });
    `, "Invalid.tsx")).toThrow("JSX spread attributes are not supported");

    expect(() => compile(`
      import { $component } from "frontend-framework";
      const App = $component(() => <p>Arrow</p>);
    `, "Invalid.tsx")).toThrow("exactly one named function expression");
  });

  test("enforces component and expression boundary diagnostics", () => {
    const cases = [
      {
        source: `const App = $component(async function App() { return <p>Async</p>; });`,
        message: "Components must be synchronous functions",
      },
      {
        source: `const App = $component(function* App() { return <p>Generator</p>; });`,
        message: "Components must be synchronous functions",
      },
      {
        source: `const App = $component(function App() { return <p>One</p>; }), other = 1;`,
        message: "sole initializer",
      },
      {
        source: `const App = $component(function App() { function read() { return \"\"; } return <input $bind={read()} />; });`,
        message: "$bind requires writable component state",
      },
      {
        source: `const App = $component(function App() { const state = { value: \"\" }; return <input $bind={state?.value} />; });`,
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
      expect(() => compile(fixture.source, "Boundary.tsx")).toThrow(fixture.message);
    }
  });
});
