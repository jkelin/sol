import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SourceMapConsumer } from "source-map-js";
import { build, type IndexHtmlTransformResult, type ResolvedConfig } from "vite";
import { compile } from "../src/index.ts";
import { solix } from "../src/vite.ts";

function linkSource(link: string): string {
  return `
    import { $component, Link } from "solix";
    import { detail } from "./detail.route";
    const App = $component(function App() { return ${link}; });
  `;
}

function componentSource(jsx: string, imports = ""): string {
  return `
    import { $component${imports} } from "solix";
    const Child = $component(function Child() { return <p>Child</p>; });
    const App = $component(function App() { return ${jsx}; });
  `;
}

function injectedDevtools(command: "serve" | "build", enabled?: boolean): IndexHtmlTransformResult {
  const plugin = enabled === undefined ? solix() : solix({ devtools: enabled });
  const resolve = plugin.configResolved as unknown as (config: ResolvedConfig) => void;
  const transform = plugin.transformIndexHtml as unknown as {
    handler(): IndexHtmlTransformResult;
  };
  resolve({ command, root: "/project" } as ResolvedConfig);
  return transform.handler();
}

describe("compiler", () => {
  test("compiles exported route declarations and path parameters", () => {
    const result = compile(
      `
      import { $component, $route } from "solix";
      const Blog = $component(function Blog() { return <main>Blog</main>; });
      export const blog = $route({ path: "/blog/:id?copy=:id&filter=:filter" }, Blog);
    `,
      "blog.route.tsx",
    );

    expect(result.code).toContain("export const blog = __solix_route");
    expect(result.code).toContain('"pattern":"^/blog/([^/]+)$"');
    expect(result.code).toContain('"parameterNames":["id","filter"]');
    expect(result.code).toContain('"pathnameParameterNames":["id"]');
    expect(result.code).toContain(
      '"queryParameters":[{"key":"copy","name":"id"},{"key":"filter","name":"filter"}]',
    );
    expect(result.code).toContain('"specificity":[1,0]');

    for (const extension of ["js", "jsx", "ts", "tsx"]) {
      const routeModule = compile(
        `import { Page } from "./Page";
         export const page = $route({ path: "/page" }, Page);`,
        `page.route.${extension}`,
      );
      expect(routeModule.code).toContain("export const page = __solix_route");
    }
  });

  test("preserves route schemas and compiles Link into its anchor child", () => {
    const result = compile(
      `
      import { $component, $route, Link as RouteLink } from "solix";
      const schema = { parse: value => value };
      const Blog = $component(function Blog() { return <main>Blog</main>; });
      export const blog = $route({ path: "/blog/:id", schema }, Blog);
      export const Navigation = $component(function Navigation() {
        const params = { id: "first" };
        return <RouteLink route={blog} params={params}><a class="entry">Open</a></RouteLink>;
      });
    `,
      "blog.route.tsx",
    );

    expect(result.code).toContain('__solix_route({\n  path: "/blog/:id",\n  schema\n}');
    expect(result.code).toContain("__solix_link(__solix_view.elements[0]");
    expect(result.code).toContain('class="entry"');
    expect(result.code).not.toContain("<RouteLink");
  });

  test("validates the compiler-specialized Link interface", () => {
    expect(() => compile(linkSource(`<Link><a>Open</a></Link>`), "App.tsx")).toThrow(
      "requires a route property",
    );
    expect(() =>
      compile(linkSource(`<Link route={detail}><button>Open</button></Link>`), "App.tsx"),
    ).toThrow("child must be an intrinsic anchor");
    expect(() =>
      compile(linkSource(`<Link route={detail}><a href="/bad">Open</a></Link>`), "App.tsx"),
    ).toThrow("provides its anchor href");
    expect(() =>
      compile(linkSource(`<Link route={detail}><a>One</a><a>Two</a></Link>`), "App.tsx"),
    ).toThrow("exactly one anchor child");
    expect(() =>
      compile(linkSource(`<Link route={detail} class="bad"><a>Open</a></Link>`), "App.tsx"),
    ).toThrow("Unsupported Link property class");
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
    ).toThrow("Invalid route query parameter draft=1");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog?from=:from&from=:other" }, Blog);`,
        "blog.route.tsx",
      ),
    ).toThrow("Duplicate route query key from");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog" }, Missing);`,
        "blog.route.tsx",
      ),
    ).toThrow("must reference a compiled component");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog", extra: true }, Blog);`,
        "blog.route.tsx",
      ),
    ).toThrow("may contain only path and schema");
  });

  test("compiles $component setup into inferred signals, computeds, and DOM effects", () => {
    const source = `
      import { $component } from "solix";
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

    expect(result.code).toContain("const Counter = __solix_component");
    expect(result.code).toContain('{ name: "Counter", file: "Counter.tsx", line: 3 }');
    expect(result.code).toContain("const count = __solix_signal(0)");
    expect(result.code).toContain(
      "const doubled = __solix_computed(() => (count.value * 2), __solix_frame)",
    );
    expect(result.code).toContain("count.value++");
    expect(result.code).toContain("__solix_event");
    expect(result.code).toContain("__solix_attribute");
    expect(result.code).toContain("__solix_text");
    expect(result.code).not.toContain("$component(function");
    expect(result.map?.sources).toContain("Counter.tsx");
    expect(result.map?.sourcesContent).toEqual([source]);
  });

  test("maps generated setup and DOM effects to their authored locations", () => {
    const source = [
      'import { $component } from "solix";',
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

    expect(originalFor("const count = __solix_signal").line).toBe(3);
    expect(originalFor("function increment").line).toBe(4);
    expect(originalFor("__solix_event(__solix_view").line).toBe(5);
    expect(originalFor("__solix_text(__solix_view").line).toBe(5);
  });

  test("compiles inferred bindings, conditionals, components, and keyed maps", () => {
    const result = compile(
      `
      import { $component } from "solix";
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

    expect(result.code).toContain('__solix_bind(__solix_view.elements[0], "checked"');
    expect(result.code).toContain('__solix_bind(__solix_view.elements[0], "value"');
    expect(result.code).toContain("__solix_when");
    expect(result.code).toContain("__solix_list");
    expect(result.code).toContain("__solix_child");
  });

  test("compiles intrinsic transition directives and rejects invalid placements", () => {
    const result = compile(
      `
      const fade = { enter: "fade-in duration-100" };
      const App = $component(function App() { return <main $transition={fade}>Ready</main>; });
    `,
      "Transitions.tsx",
    );

    expect(result.code).toContain("__solix_transition(__solix_view.elements[0], () => (fade))");
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

  test("compiles intrinsic refs and portal builtins", () => {
    const result = compile(
      `
      import { $component, createRef as makeRef, GlobalPortal as BodyPortal, Portal as TargetPortal } from "solix";
      const App = $component(function App() {
        const target = makeRef<HTMLDivElement>();
        const callback = (element: HTMLButtonElement | null) => void element;
        return <main>
          <div ref={target} />
          <TargetPortal target={target.current!}><button ref={callback}>Targeted</button><span>Sibling</span></TargetPortal>
          <BodyPortal><aside>Global</aside></BodyPortal>
        </main>;
      });
    `,
      "Portals.tsx",
    );

    expect(result.code).toContain("__solix_block_lifecycle(__solix_frame)");
    expect(result.code).toContain("const target = makeRef<HTMLDivElement>();");
    expect(result.code).not.toContain("__solix_signal(makeRef())");
    expect(result.code).toContain("__solix_ref(__solix_view.elements[0]");
    expect(result.code).toContain("__solix_portal(() => (target.current!)");
    expect(result.code).toContain("__solix_global_portal(");
    expect(result.code).toContain('<button data-solix-e="0">Targeted</button><span>Sibling</span>');
    expect(result.code).not.toContain("<TargetPortal");
    expect(result.code).not.toContain("<BodyPortal");
  });

  test("maps ref and portal operations to their authored JSX", () => {
    const source = [
      'import { $component, createRef, GlobalPortal, Portal } from "solix";',
      "const App = $component(function App() {",
      "  const target = createRef<HTMLDivElement>();",
      "  const callback = (element: HTMLDivElement | null) => void element;",
      "  return <main>",
      "    <div ref={callback} />",
      "    <Portal target={target.current!}><p>Targeted</p></Portal>",
      "    <GlobalPortal><p>Global</p></GlobalPortal>",
      "  </main>;",
      "});",
    ].join("\n");
    const result = compile(source, "MappedPortals.tsx");
    const consumer = new SourceMapConsumer(JSON.parse(result.map!.toString()));
    const originalLine = (needle: string): number | null => {
      const offset = result.code.indexOf(needle);
      const prefix = result.code.slice(0, offset);
      const lines = prefix.split("\n");
      return consumer.originalPositionFor({
        line: lines.length,
        column: lines.at(-1)!.length,
      }).line;
    };

    expect(originalLine("__solix_ref(__solix_view")).toBe(6);
    expect(originalLine("__solix_portal(() =>")).toBe(7);
    expect(originalLine("__solix_global_portal(")).toBe(8);
  });

  test("validates ref and portal compiler boundaries", () => {
    expect(() => compile(componentSource('<input ref="field" />'), "InvalidRef.tsx")).toThrow(
      "requires an expression",
    );
    expect(() => compile(componentSource("<Child ref={() => {}} />"), "ComponentRef.tsx")).toThrow(
      "ref is only valid on intrinsic elements",
    );
    expect(() => compile(componentSource("<Portal />", ", Portal"), "MissingTarget.tsx")).toThrow(
      "target is required",
    );
    expect(() =>
      compile(componentSource('<Portal target="body" />', ", Portal"), "StaticTarget.tsx"),
    ).toThrow("requires an expression");
    expect(() =>
      compile(
        componentSource("<GlobalPortal target={document.body} />", ", GlobalPortal"),
        "GlobalTarget.tsx",
      ),
    ).toThrow("Unexpected target property");
    expect(() =>
      compile(
        componentSource(
          "<>{[document.body].map(target => <Portal key={target} target={target}><p>Row</p></Portal>)}</>",
          ", Portal",
        ),
        "KeyedPortal.tsx",
      ),
    ).not.toThrow();
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

    expect(result.code).toContain("__solix_item_0.value.name");
    expect(result.code).toContain("__solix_item_1.value.label");
    expect(result.code).toContain("(__solix_item_0, __solix_index_0, __solix_frame)");
    expect(result.code).toContain("(__solix_item_1, __solix_index_1, __solix_frame)");
  });

  test("supports explicit reactive overrides and every class alias", () => {
    const result = compile(
      `
      import { $component, $computed, $signal } from "solix";
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

    expect(result.code).toContain("__solix_signal(1)");
    expect(result.code).toContain("__solix_computed(() => count.value * 2, __solix_frame)");
    expect(result.code).toContain('<p class="static">');
    expect(result.code.match(/__solix_attribute\(/g)?.length).toBe(2);
  });

  test("infers value and checked bindings for every supported form control", () => {
    const result = compile(
      `
      import { $component } from "solix";
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

    expect(result.code.match(/__solix_bind\([^\n]+"value"/g)?.length).toBe(2);
    expect(result.code.match(/__solix_bind\([^\n]+"checked"/g)?.length).toBe(1);
    expect(
      result.code.match(/"kind":"bind","target":"element","index":\d+,"name":"value"/g)?.length,
    ).toBe(2);
    expect(result.code).toMatch(/"kind":"bind","target":"element","index":\d+,"name":"checked"/);
  });

  test("connects form controllers through the $form element property", () => {
    const result = compile(
      `
      import { $component, $form } from "solix";
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
      import { $component } from "solix";
      const row = $component(function row() { return <span>Row</span>; });
      const app = $component(function app() { return <row />; });
    `,
      "Lowercase.tsx",
    );

    expect(result.code).toContain("const row = __solix_component");
    expect(result.code).toContain("__solix_child");
    expect(result.code).not.toContain("<row>");
  });

  test("compiles contexts, async components, suspense, await, and error boundaries", () => {
    const result = compile(
      `
      import { $component, $context, Suspense, Await, ErrorBoundary } from "solix";
      const messageContext = $context<{ message: string }>();
      const AsyncChild = $component(async function AsyncChild() {
        const context = messageContext.use();
        const service = { use() { return "ordinary"; } };
        const ordinary = service.use();
        const data = await Promise.resolve({ text: "ready" });
        return <p data-state={data.text}>{context.message}: {data.text}: {ordinary}</p>;
      });
      const Ordinary = $component(function Ordinary() {
        const messageContext = { use() { return "shadowed"; } };
        return <p>{messageContext.use()}</p>;
      });
      const App = $component(function App() {
        const shared = { message: "hello" };
        const promise = Promise.resolve({ text: "awaited" });
        return <messageContext.Provider data={shared}>
          <ErrorBoundary fallback={error => <p>{String(error)}</p>}>
            <Suspense fallback={<p>Loading</p>} error={error => <p>{String(error)}</p>} timeoutMs={250}>
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

    expect(result.code).toContain("__solix_component(async (");
    expect(result.code).toContain("__solix_context_provider");
    expect(result.code).toContain("__solix_context_use(messageContext, __solix_frame, false)");
    expect(result.code).toContain("__solix_context_use(service.value, __solix_frame, false)");
    expect(result.code).toContain(
      "__solix_context_use(messageContext.value, __solix_frame, false)",
    );
    expect(result.code).toContain("__solix_error_boundary");
    expect(result.code).toContain("__solix_suspense");
    expect(result.code).toContain("__solix_await");
    expect(result.code).toContain('__solix_async_value(__solix_frame, "await:AsyncContext.tsx:0"');
    expect(result.code).toContain("__solix_frame, 250)");
    expect(result.code).toMatch(/__solix_template\(`[^`]*`, "t[a-z0-9]+", \{/);
    expect(result.code).toContain('"elements":["p"]');
    expect(result.code).toContain('"regions":[0,1]');
    expect(result.code).toMatch(/"operations":\[\{"id":"o[a-z0-9]+","kind":"attribute"/);
    expect(result.code).toMatch(
      /"kind":"attribute","target":"element","index":0,"name":"data-state"/,
    );
  });

  test("passes the render frame to imported context candidates", () => {
    const result = compile(
      `
      import { sharedContext } from "./shared-context.ts";
      const App = $component(function App() {
        const value = sharedContext.use();
        return <p>{value.label}</p>;
      });
    `,
      "ImportedContext.tsx",
    );

    expect(result.code).toContain("__solix_context_use(sharedContext, __solix_frame, false)");
  });

  test("reserves private hydration element markers", () => {
    expect(() =>
      compile(
        `const App = $component(function App() { return <main data-solix-e="authored">Bad</main>; });`,
        "PrivateMarker.tsx",
      ),
    ).toThrow("data-solix-e is reserved for hydration metadata");
  });

  test("captures component awaits without instrumenting fire-and-forget helper work", () => {
    const result = compile(
      `
      const App = $component(async function App() {
        async function sideEffect() { await Promise.resolve("side effect"); }
        async function load() { return await Promise.resolve("nested"); }
        void sideEffect();
        const nested = await load();
        const value = await Promise.resolve("captured");
        return <p>{nested}: {value}</p>;
      });
    `,
      "AsyncSideEffect.tsx",
    );

    expect(result.code.match(/__solix_async_value/g)).toHaveLength(3);
    expect(result.code.match(/__solix_async_value\(__solix_frame/g)).toHaveLength(2);
    expect(result.code).toContain('await Promise.resolve("side effect")');
    expect(result.code).toContain(
      '__solix_capture_enabled ? __solix_async_value(__solix_frame, "await:AsyncSideEffect.tsx:0"',
    );
    expect(result.code).toContain(
      "const nested = __solix_signal(await __solix_async_capture_call(() => load(), true))",
    );
  });

  test("does not capture helper calls nested in an awaited callback", () => {
    const result = compile(
      `
      const App = $component(async function App() {
        async function sideEffect() { await Promise.resolve("side effect"); }
        const value = await new Promise(resolve => {
          void sideEffect();
          resolve("ready");
        });
        return <p>{value}</p>;
      });
    `,
      "AwaitedCallback.tsx",
    );

    expect(result.code.match(/__solix_async_value\(__solix_frame/g)).toHaveLength(1);
    expect(result.code).toContain('await Promise.resolve("side effect")');
    expect(result.code).toContain("void sideEffect()");
    expect(result.code).not.toContain("__solix_async_capture_call(() => sideEffect()");
  });

  test("namespaces async sites by compiled module", () => {
    const source = `const App = $component(async function App() { const value = await Promise.resolve("value"); return <p>{value}</p>; });`;
    const first = compile(source, "FirstModule.tsx");
    const second = compile(source, "SecondModule.tsx");

    expect(first.code).toContain('"await:FirstModule.tsx:0"');
    expect(second.code).toContain('"await:SecondModule.tsx:0"');
    expect(second.code).not.toContain('"await:FirstModule.tsx:0"');
  });

  test("resolves awaited helpers by lexical binding when names are shadowed", () => {
    const result = compile(
      `
      const App = $component(async function App() {
        async function load() { return await Promise.resolve("outer"); }
        {
          async function load() { await Promise.resolve("shadow"); }
          void load();
        }
        const value = await load();
        return <p>{value}</p>;
      });
    `,
      "ShadowedHelper.tsx",
    );

    expect(result.code).toContain('await Promise.resolve("shadow")');
    expect(result.code).toContain(
      '__solix_capture_enabled ? __solix_async_value(__solix_frame, "await:ShadowedHelper.tsx:0", () => Promise.resolve("outer"))',
    );
    expect(result.code).toContain(
      "const value = __solix_signal(await __solix_async_capture_call(() => load(), true))",
    );
  });

  test("compiles Head children and raw-text elements", () => {
    const result = compile(
      `
      import { $component, Head as DocumentHead } from "solix";
      const App = $component(function App() {
        let title = "First";
        const description = "Reactive description";
        return <main>
          <DocumentHead>
            <title>Page: {title}</title>
            <meta name="description" content={description} />
            <style>{"body { color: red; }"}</style>
            <script>{"globalThis.headScriptRan = true;"}</script>
          </DocumentHead>
          <textarea>Draft: {title}</textarea>
        </main>;
      });
    `,
      "Head.tsx",
    );

    expect(result.code).toContain("__solix_head");
    expect(result.code).toContain("__solix_raw_text");
    expect(result.code).not.toContain("<DocumentHead");
    expect(result.code).not.toContain("<!--solix:s:");
  });

  test("validates the compiler-specialized Head interface", () => {
    const cases = [
      {
        source: `import { $component, Head } from "solix"; const App = $component(function App() { return <Head title="Invalid" />; });`,
        message: "Unexpected title property",
      },
      {
        source: `import { $component, Head } from "solix"; const props = {}; const App = $component(function App() { return <Head {...props} />; });`,
        message: "JSX spread attributes are not supported in v1",
      },
      {
        source: `import { $component, Head } from "solix"; const App = $component(function App() { return <Head><title><span>Invalid</span></title></Head>; });`,
        message: "Raw-text element children must be text or expressions",
      },
    ];

    for (const fixture of cases) {
      expect(() => compile(fixture.source, "Head.tsx")).toThrow(fixture.message);
    }
  });

  test("treats empty Head blocks as no-ops and respects lexical shadowing", () => {
    const empty = compile(
      `import { $component, Head } from "solix"; const App = $component(function App() { return <Head />; });`,
      "EmptyHead.tsx",
    );
    expect(empty.code.match(/__solix_head\(/g) ?? []).toHaveLength(0);

    expect(() =>
      compile(
        `
        import { $component, Head as DocumentHead } from "solix";
        const Local = $component(function Local() { return <p>Local</p>; });
        const App = $component(function App() {
          const DocumentHead = Local;
          return <DocumentHead title="Not a builtin" />;
        });
      `,
        "ShadowedHead.tsx",
      ),
    ).toThrow("JSX component DocumentHead must be declared with $component() or imported");
  });

  test("rejects JSX nested anywhere inside raw-text expressions", () => {
    const expressions = [
      `ready ? "Ready" : <span>Pending</span>`,
      `ready && <span>Ready</span>`,
      `["Ready", <span>Pending</span>]`,
    ];
    for (const expression of expressions) {
      expect(() =>
        compile(
          `import { $component } from "solix"; const App = $component(function App() { const ready = true; return <title>{${expression}}</title>; });`,
          "RawText.tsx",
        ),
      ).toThrow("Raw-text element children must be text or expressions");
    }
  });

  test("validates async boundary and context provider JSX contracts", () => {
    const cases = [
      {
        source: `import { $component, Suspense } from "solix"; const App = $component(function App() { return <Suspense><p>Child</p></Suspense>; });`,
        message: "JSX property fallback is required",
      },
      {
        source: `import { $component, Await } from "solix"; const App = $component(function App() { return <Await $promise={Promise.resolve(1)} />; });`,
        message: "Await requires exactly one inline data-renderer child",
      },
      {
        source: `import { $component, ErrorBoundary } from "solix"; const App = $component(function App() { return <ErrorBoundary fallback={<p>Error</p>}><p>Child</p></ErrorBoundary>; });`,
        message: "Error and data renderers must be inline functions",
      },
      {
        source: `import { $component, $context } from "solix"; const context = $context<{ value: string }>(); const App = $component(function App() { return <context.Provider><p>Child</p></context.Provider>; });`,
        message: "JSX property data is required",
      },
      {
        source: `import { $component, Await } from "solix"; const App = $component(function App() { return <Await $promise={123}>{value => <p>{value}</p>}</Await>; });`,
        message: "Await $promise must be a promise expression",
      },
      {
        source: `import { $component, Suspense } from "solix"; const App = $component(function App() { return <Suspense fallback={<p>Wait</p>} timeoutMs><p>Child</p></Suspense>; });`,
        message: "Suspense timeoutMs must be a number expression",
      },
      {
        source: `import { $component, $context } from "solix"; const context = $context<{ value: string }>(); const App = $component(function App() { return <context.Provider data={123}><p>Child</p></context.Provider>; });`,
        message: "Context Provider data must be an object expression",
      },
    ];

    for (const fixture of cases) {
      expect(() => compile(fixture.source, "AsyncBoundary.tsx")).toThrow(fixture.message);
    }

    expect(() =>
      compile(
        `import { $component, $context } from "solix"; const context = $context<RegExp>(); const App = $component(function App() { return <context.Provider data={/valid object/}><p>Child</p></context.Provider>; });`,
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
      import { signal } from "solix";
      export const value = signal(1);
    `,
        "Invalid.tsx",
      ),
    ).toThrow("signal() was renamed to $signal()");

    expect(() =>
      compile(
        `
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
      const App = $component(function App() { return <Missing />; });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("JSX component Missing must be declared with $component() or imported");

    expect(() =>
      compile(
        `
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      import { $component } from "solix";
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
      const __solix_signal = 1;
      const App = $component(function App() { return <p>{__solix_signal}</p>; });
    `,
        "ReservedModule.tsx",
      ),
    ).toThrow("reserved compiler prefix __solix_");

    expect(() =>
      compile(
        `
      const App = $component(function App() {
        let __solix_view = 1;
        return <p>{__solix_view}</p>;
      });
    `,
        "ReservedComponent.tsx",
      ),
    ).toThrow("reserved compiler prefix __solix_");

    expect(() =>
      compile(
        `
      import { $component, Fragment } from "solix";
      const App = $component(function App() { return <Fragment />; });
    `,
        "FrameworkImport.tsx",
      ),
    ).toThrow("must be declared with $component() or imported");

    const externalComponent = compile(
      `
      import { $component } from "solix";
      import { Row } from "./Row";
      const App = $component(function App() { return <Row />; });
    `,
      "ExternalComponent.tsx",
    );
    expect(externalComponent.code).toContain("__solix_child");
  });

  test("validates binding roots, readonly props, and event spelling", () => {
    const valid = compile(
      `
      import { $component } from "solix";
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
    expect(valid.code.match(/__solix_bind/g)?.length).toBeGreaterThanOrEqual(2);

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
        import { $component } from "solix";
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
        import { $component } from "solix";
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

test("the Vite plugin enables devtools only for development by default", () => {
  expect(injectedDevtools("serve")).toEqual([
    {
      tag: "script",
      attrs: {
        type: "module",
        src: "/@id/solix/devtools",
        "data-solix-devtools": "",
      },
      injectTo: "head-prepend",
    },
  ]);
  expect(injectedDevtools("build")).toEqual([]);
  expect(injectedDevtools("build", true)).toEqual([
    {
      tag: "script",
      attrs: {
        type: "module",
        src: "/@solix/devtools",
        "data-solix-devtools": "",
      },
      injectTo: "head-prepend",
    },
  ]);
  expect(injectedDevtools("serve", false)).toEqual([]);
  expect(() => solix({ devtools: "yes" as never })).toThrow("must be a boolean");
});

test("emits authored source metadata for query and mutation diagnostics", () => {
  const result = compile(
    `
      import { $component, $query as query, $mutation } from "solix";
      const Requests = $component(function Requests() {
        const project = query({ queryKey: ["project"], query: async () => 1 });
        const save = $mutation({ mutation: async () => 1 });
        return <button onClick={() => save.mutate({})}>{project.data}</button>;
      });
    `,
    "Requests.tsx",
  );

  expect(result.code).toMatch(
    /query\(__solix_request_source\(\{[\s\S]*?file: "Requests\.tsx",[\s\S]*?line: 4,[\s\S]*?column: 24/,
  );
  expect(result.code).toMatch(
    /\$mutation\(__solix_request_source\(\{[\s\S]*?file: "Requests\.tsx",[\s\S]*?line: 5,[\s\S]*?column: 21/,
  );
});

test("an explicitly enabled production build bundles devtools", async () => {
  const result = await build({
    root: join(import.meta.dir, "fixtures/devtools-build"),
    logLevel: "silent",
    plugins: [solix({ devtools: true })],
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
    if (!("output" in item)) throw new Error("Expected a completed Vite build");
    return item.output;
  });
  const bundled = outputs
    .map((output) => (output.type === "chunk" ? output.code : String(output.source)))
    .join("\n");

  expect(bundled).toContain("solix_get_diagnostics");
  expect(bundled).not.toContain("/@id/solix/devtools");
});
