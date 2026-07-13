import { describe, expect, test } from "bun:test";
import { compile } from "../src/compiler.ts";

describe("compiler", () => {
  test("turns TSX into a static template and fine-grained operations", () => {
    const source = `
      import { signal } from "frontend-framework";
      export function Counter(props: { label: string }) {
        const count = signal(0);
        return <button className="counter" onClick={() => count.value++} onDoubleClick={() => count.value += 2} disabled={count.value > 2}>
          {props.label}: {count.value}
        </button>;
      }
    `;
    const result = compile(source, "Counter.tsx");

    expect(result.code).toContain("__ff_template(`");
    expect(result.code).toContain("__ff_event");
    expect(result.code).toContain("__ff_attribute");
    expect(result.code).toContain("__ff_text");
    expect(result.code).toContain('"dblclick"');
    expect(result.code).not.toContain("return <button");
    expect(result.map?.sources).toContain("Counter.tsx");
    expect(result.map?.sourcesContent).toEqual([source]);
  });

  test("compiles bindings, conditionals, components, and keyed maps", () => {
    const result = compile(`
      import { signal } from "frontend-framework";
      function Row(props: { todo: { id: number; done: boolean } }) {
        return <li><input type="checkbox" bind:checked={props.todo.done} /></li>;
      }
      function App() {
        const draft = signal("");
        const todos = signal([{ id: 1, done: false }]);
        return <main>
          <input bind:value={draft} />
          {todos.value.length ? <ul>{todos.value.map(todo => <Row key={todo.id} todo={todo} />)}</ul> : <p>Empty</p>}
        </main>;
      }
    `, "App.tsx");

    expect(result.code).toContain("__ff_bind");
    expect(result.code).toContain("__ff_when");
    expect(result.code).toContain("__ff_list");
    expect(result.code).toContain("__ff_child");
  });

  test("reports invalid component and list interfaces with locations", () => {
    expect(() => compile(`
      function App({ name }: { name: string }) {
        return <p>{name}</p>;
      }
    `, "Invalid.tsx")).toThrow("Component props must use one identifier");

    expect(() => compile(`
      function App(props: { values: string[] }) {
        return <ul>{props.values.map(value => <li>{value}</li>)}</ul>;
      }
    `, "Invalid.tsx")).toThrow("Every JSX .map() row requires a key attribute");

    expect(() => compile(`
      function App() { return <p>Compiled</p>; }
      const Other = () => <p>Not compiled</p>;
    `, "Invalid.tsx")).toThrow(/Invalid\.tsx:3:.*JSX survived compilation.*const Other/s);

    expect(() => compile(`
      function App() { return <input type="text" bind:checked={signal(false)} />; }
    `, "Invalid.tsx")).toThrow("bind:checked is not valid");

    expect(() => compile(`
      function App(props: { values: string[] }) {
        return <ul>{props.values.map(value => { const label = value.toUpperCase(); return <li key={value}>{label}</li>; })}</ul>;
      }
    `, "Invalid.tsx")).toThrow("JSX .map() setup statements are not supported");

    expect(() => compile(`
      function App(props: { ready: boolean }) {
        if (!props.ready) return null;
        return <p>Ready</p>;
      }
    `, "Invalid.tsx")).toThrow("Early component returns are not supported");

    expect(() => compile(`
      function App(props: { value: string }) {
        return <div {...props}>{props.value}</div>;
      }
    `, "Invalid.tsx")).toThrow("JSX spread attributes are not supported");

    expect(() => compile(`
      function App(props: { value: string }) {
        return <input bind:value={props.value.trim()} />;
      }
    `, "Invalid.tsx")).toThrow("Bindings require a signal identifier or assignable member expression");
  });
});
