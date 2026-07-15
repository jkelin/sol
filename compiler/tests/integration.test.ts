import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { compile } from "../src/index.ts";
import type { Component } from "../../runtime/src/components.ts";
import { $form } from "../../runtime/src/forms.ts";
import { $mutation, $query } from "../../runtime/src/queries.ts";
import { mount } from "../../runtime/src/rendering.ts";
import { renderToStringAsync } from "../../runtime/src/ssr.ts";
import { hydrate } from "../../runtime/src/hydrate.ts";
import { deserializeGraph, serializeGraph } from "../../runtime/src/serialization.ts";

interface SetupCounts {
  app: number;
  child: number;
}

declare global {
  var integrationSetups: SetupCounts;
  var integrationForm: typeof $form;
  var integrationMutation: typeof $mutation;
  var integrationQuery: typeof $query;
  var integrationResolvers: Array<(value: string) => void>;
  var integrationRejectors: Array<(error: unknown) => void>;
  var integrationPortalRef: Element | null;
  var integrationPortalClicks: number;
  var integrationInvalidatePortalTarget: () => void;
  var integrationConditionalRefConnected: boolean;
  var integrationKeyedRefs: Set<number>;
  var integrationPending: Promise<string>;
  var integrationResolve: (value: string) => void;
  var integrationLoads: number;
  var integrationLoad: (id: string) => Promise<unknown>;
  var integrationControllerFactories: Array<() => unknown>;
}

let window: Window;

beforeEach(() => {
  window = new Window();
  delete (window.Element.prototype as { getAnimations?: unknown }).getAnimations;
  globalThis.integrationSetups = { app: 0, child: 0 };
  globalThis.integrationLoads = 0;
  globalThis.integrationLoad = () => Promise.reject(new Error("integrationLoad is not configured"));
  globalThis.integrationControllerFactories = [];
  Object.assign(globalThis, {
    integrationForm: $form,
    integrationMutation: $mutation,
    integrationQuery: $query,
    integrationResolvers: [],
    integrationRejectors: [],
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
  const runtimeModule = ["components.ts", "forms.ts", "portals.ts", "queries.ts", "refs.ts"]
    .map(
      (file) =>
        `export * from ${JSON.stringify(new URL(`../../runtime/src/${file}`, import.meta.url).href)};`,
    )
    .join("\n");
  const runtimeUrl = `data:text/javascript;base64,${Buffer.from(runtimeModule).toString("base64")}`;
  const compilerRuntimeUrl = new URL("../../runtime/src/compiler-runtime.ts", import.meta.url).href;
  const sourceWithRuntime = result.code
    .replaceAll('"@soljs/sol/compiler-runtime"', JSON.stringify(compilerRuntimeUrl))
    .replaceAll('"@soljs/sol"', JSON.stringify(runtimeUrl));
  const javascript =
    ts.transpileModule(sourceWithRuntime, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText + `\n// ${crypto.randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "sol-compiler-test-"));
  const modulePath = join(directory, "compiled.mjs");
  await writeFile(modulePath, javascript);
  try {
    return await import(pathToFileURL(modulePath).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectRejection(promise: PromiseLike<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain(message);
}

function expectBooleanValueParity(target: ParentNode): void {
  expect(target.querySelector<HTMLInputElement>("#literal-false")!.value).toBe("false");
  expect(target.querySelector<HTMLInputElement>("#literal-true")!.value).toBe("true");
  expect(target.querySelector<HTMLInputElement>("#dynamic-value")!.value).toBe("false");
  expect(target.querySelector("#literal-class")!.className).toBe("0");
  expect(target.querySelector("#dynamic-class")!.className).toBe("0");
}

function expectFalseyBooleanAbsence(target: ParentNode): void {
  const quoted = target.querySelector<HTMLButtonElement>("#quoted")!;
  const empty = target.querySelector<HTMLButtonElement>("#empty")!;
  const readonly = target.querySelector<HTMLInputElement>("#readonly")!;
  const media = target.querySelector<HTMLVideoElement>("#media")!;
  expect(quoted.disabled).toBe(true);
  expect(quoted.hasAttribute("disabled")).toBe(true);
  expect(empty.disabled).toBe(false);
  expect(empty.hasAttribute("disabled")).toBe(false);
  expect(readonly.readOnly).toBe(false);
  expect(readonly.hasAttribute("readonly")).toBe(false);
  expect(media.hasAttribute("disablepictureinpicture")).toBe(false);
  expect(media.hasAttribute("disableremoteplayback")).toBe(false);
}

function expectSvgNamespaces(target: ParentNode): void {
  const svgNamespace = "http://www.w3.org/2000/svg";
  expect(target.querySelector("linearGradient")?.namespaceURI).toBe(svgNamespace);
  expect(target.querySelector("linearGradient")?.localName).toBe("linearGradient");
  expect(target.querySelector("textPath")?.namespaceURI).toBe(svgNamespace);
  expect(target.querySelector("textPath")?.localName).toBe("textPath");
  expect(target.querySelector("foreignObject")?.namespaceURI).toBe(svgNamespace);
  expect(target.querySelector("foreignObject")?.localName).toBe("foreignObject");
  expect(target.querySelector("#html-child")?.textContent).toBe("HTML");
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

test("Head mounts reactive owned content into document.head", async () => {
  window.happyDOM.settings.enableJavaScriptEvaluation = true;
  const preserved = document.createElement("meta");
  preserved.setAttribute("name", "preserved");
  const preservedTitle = document.createElement("title");
  preservedTitle.textContent = "Static title";
  document.head.append(preserved, preservedTitle);
  const module = await loadCompiled(`
    import { $component, Head } from "@soljs/sol";
    export const App = $component(function App() {
      let title = "First";
      let description = "Initial description";
      let color = "red";
      return <main>
        <Head>
          <title>Page: {title}</title>
          <meta name="description" content={description} />
          <style>{"body { color: " + color + "; }"}</style>
          <script>{"globalThis.integrationHeadScripts = (globalThis.integrationHeadScripts ?? 0) + 1;"}</script>
        </Head>
        <button id="update-head" onClick={() => {
          title = "Second";
          description = "Updated description";
          color = "blue";
        }}>Update</button>
      </main>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);

  expect(document.title).toBe("Page: First");
  expect(document.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
    "Initial description",
  );
  expect(document.head.querySelector("style")?.textContent).toBe("body { color: red; }");
  expect((window as unknown as { integrationHeadScripts?: number }).integrationHeadScripts).toBe(1);

  target.querySelector<HTMLButtonElement>("#update-head")!.click();
  expect(document.title).toBe("Page: Second");
  expect(document.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
    "Updated description",
  );
  expect(document.head.querySelector("style")?.textContent).toBe("body { color: blue; }");
  expect((window as unknown as { integrationHeadScripts?: number }).integrationHeadScripts).toBe(1);

  dispose();
  expect(document.title).toBe("Static title");
  expect(document.head.querySelector('meta[name="preserved"]')).toBe(preserved);
  expect(document.head.querySelector('meta[name="description"]')).toBeNull();
  expect(document.head.querySelector("style")).toBeNull();
  expect(document.head.querySelector("script")).toBeNull();
});

test("Head keeps reactive script bindings on the executable replacement", async () => {
  window.happyDOM.settings.enableJavaScriptEvaluation = true;
  const module = await loadCompiled(`
    import { $component, Head } from "@soljs/sol";
    export const App = $component(function App() {
      let body = "globalThis.dynamicHeadScripts = (globalThis.dynamicHeadScripts ?? 0) + 1;";
      let nonce = "first";
      let source = "/first.json";
      return <main>
        <Head>
          <script nonce={nonce} data-version={nonce}>{body}</script>
          <script type="application/json" src={source}></script>
        </Head>
        <button onClick={() => {
          body = "globalThis.dynamicHeadScripts = (globalThis.dynamicHeadScripts ?? 0) + 10;";
          nonce = "second";
          source = "/second.json";
        }}>Update scripts</button>
      </main>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);
  const executable = document.head.querySelector<HTMLScriptElement>("script:not([src])")!;
  const dataScript = document.head.querySelector<HTMLScriptElement>("script[src]")!;

  expect((window as unknown as { dynamicHeadScripts?: number }).dynamicHeadScripts).toBe(1);
  expect(executable.getAttribute("nonce")).toBe("first");
  expect(executable.dataset.version).toBe("first");
  expect(dataScript.getAttribute("src")).toBe("/first.json");

  target.querySelector("button")!.click();
  expect(document.head.querySelector("script:not([src])")).toBe(executable);
  expect(document.head.querySelector("script[src]")).toBe(dataScript);
  expect(executable.textContent).toContain("+ 10");
  expect(executable.getAttribute("nonce")).toBe("second");
  expect(executable.dataset.version).toBe("second");
  expect(dataScript.getAttribute("src")).toBe("/second.json");
  expect((window as unknown as { dynamicHeadScripts?: number }).dynamicHeadScripts).toBe(1);

  dispose();
  expect(document.head.querySelector("script")).toBeNull();
  expect((window as unknown as { dynamicHeadScripts?: number }).dynamicHeadScripts).toBe(1);
});

test("SSR serializes Head separately and hydration claims its owned nodes", async () => {
  const staticTitle = document.createElement("title");
  staticTitle.textContent = "Static title";
  document.head.append(staticTitle);
  const module = await loadCompiled(`
    import { $component, Head } from "@soljs/sol";
    export const App = $component(function App() {
      let title = "Server title";
      let description = "Server description";
      return <main>
        <Head>
          <title>Page: {title}</title>
          <meta name="description" content={description} />
          <style>{"body { color: " + title + "; }"}</style>
        </Head>
        <h1>Server body</h1>
        <button onClick={() => { title = "Client title"; description = "Client description"; }}>Update</button>
      </main>;
    });
  `);
  const App = module.App as Component;
  let headHtml = "";
  const bodyHtml = await renderToStringAsync(App, undefined, {
    onHead: (html) => {
      headHtml = html;
    },
  });

  expect(bodyHtml).toContain("Server body");
  expect(bodyHtml).not.toContain("Server title");
  expect(headHtml).toContain("Page: Server title");
  expect(headHtml).toContain('content="Server description"');
  expect(headHtml).toContain("body { color: Server title; }");
  expect(headHtml).toContain("sol:head:start:");

  const headTemplate = document.createElement("template");
  headTemplate.innerHTML = headHtml;
  document.head.prepend(headTemplate.content);
  const serverTitle = document.head.querySelector("title");
  const serverMeta = document.head.querySelector('meta[name="description"]');
  const target = document.createElement("div");
  target.innerHTML = bodyHtml;
  const serverHeading = target.querySelector("h1");
  const dispose = await hydrate(App, target);

  expect(target.querySelector("h1")).toBe(serverHeading);
  expect(document.head.querySelector("title")).toBe(serverTitle);
  expect(document.head.querySelector('meta[name="description"]')).toBe(serverMeta);
  expect(document.title).toBe("Page: Server title");

  target.querySelector("button")!.click();
  expect(document.title).toBe("Page: Client title");
  expect(serverMeta?.getAttribute("content")).toBe("Client description");
  expect(document.head.querySelector("style")?.textContent).toContain("Client title");

  dispose();
  expect(document.title).toBe("Static title");
  expect(document.head.querySelector('meta[name="description"]')).toBeNull();
  expect(document.head.querySelector("style")).toBeNull();
});

test("SSR Head preserves independent ordering and script identity through hydration", async () => {
  const module = await loadCompiled(`
    import { $component, Head } from "@soljs/sol";
    export const App = $component(function App() {
      let showNewer = true;
      return <main>
        <Head><title>Older</title><meta name="shared" content="older" /></Head>
        {showNewer && <Head>
          <title>Newer</title>
          <meta name="shared" content="newer" />
          <script nonce="server-nonce">{"globalThis.ssrHeadScript = (globalThis.ssrHeadScript ?? 0) + 1;"}</script>
        </Head>}
        <button onClick={() => showNewer = false}>Hide newer</button>
      </main>;
    });
  `);
  const App = module.App as Component;
  let headHtml = "";
  const bodyHtml = await renderToStringAsync(App, undefined, {
    onHead: (html) => {
      headHtml = html;
    },
  });
  expect(headHtml.indexOf("Newer")).toBeLessThan(headHtml.indexOf("Older"));
  expect(headHtml).toContain('nonce="server-nonce"');
  expect(headHtml).toContain("globalThis.ssrHeadScript");

  document.head.innerHTML = headHtml;
  const titles = [...document.head.querySelectorAll("title")];
  const script = document.head.querySelector("script");
  const target = document.createElement("div");
  target.innerHTML = bodyHtml;
  const dispose = await hydrate(App, target);

  expect([...document.head.querySelectorAll("title")]).toEqual(titles);
  expect(document.head.querySelector("script")).toBe(script);
  expect(document.title).toBe("Newer");
  expect(
    [...document.head.querySelectorAll('meta[name="shared"]')].map((meta) =>
      meta.getAttribute("content"),
    ),
  ).toEqual(["newer", "older"]);

  target.querySelector("button")!.click();
  expect(document.title).toBe("Older");
  expect(document.head.querySelector("script")).toBeNull();
  dispose();
  expect(document.head.querySelector("title")).toBeNull();
});

test("a later hydration mismatch preserves server-rendered Head nodes", async () => {
  const module = await loadCompiled(`
    import { $component, Head } from "@soljs/sol";
    export const App = $component(function App(props: { label: string }) {
      return <main>
        <Head><title>Preserved {props.label}</title><meta name="preserved-head" content={props.label} /></Head>
        <p>{props.label}</p>
      </main>;
    });
  `);
  const App = module.App as Component<{ label: string }>;
  let headHtml = "";
  const bodyHtml = await renderToStringAsync(
    App,
    { label: "server" },
    {
      onHead: (html) => {
        headHtml = html;
      },
    },
  );
  document.head.innerHTML = headHtml;
  const title = document.head.querySelector("title");
  const meta = document.head.querySelector('meta[name="preserved-head"]');
  const headSnapshot = document.head.innerHTML;
  const target = document.createElement("div");
  target.innerHTML = bodyHtml;

  await expectRejection(hydrate(App, target, { label: "client" }), "hydration mismatch");
  expect(document.head.querySelector("title")).toBe(title);
  expect(document.head.querySelector('meta[name="preserved-head"]')).toBe(meta);
  expect(document.head.innerHTML).toBe(headSnapshot);
});

test("empty Head is inert and scripts outside Head stay inert", async () => {
  window.happyDOM.settings.enableJavaScriptEvaluation = true;
  const before = [...document.head.childNodes];
  const module = await loadCompiled(`
    import { $component, Head } from "@soljs/sol";
    export const App = $component(function App() {
      return <main>
        <Head />
        <script>{"globalThis.bodyScriptRan = true;"}</script>
      </main>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);

  expect([...document.head.childNodes]).toEqual(before);
  expect((window as unknown as { bodyScriptRan?: boolean }).bodyScriptRan).toBeUndefined();
  expect(target.querySelector("script")).not.toBeNull();
  dispose();
  expect([...document.head.childNodes]).toEqual(before);
});

test("raw-text elements render mixed values and update without marker text", async () => {
  const module = await loadCompiled(`
    import { $component } from "@soljs/sol";
    export const App = $component(function App() {
      let count = 1;
      const missing = null;
      const disabled = false;
      return <main>
        <textarea>Count {count}; missing {missing}; disabled {disabled}</textarea>
        <style>{"\\n.rule {\\n  order: " + count + ";\\n}\\n"}</style>
        <button onClick={() => count = 2}>Update raw text</button>
      </main>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);

  expect(target.querySelector("textarea")?.textContent).toBe("Count 1; missing ; disabled ");
  expect(target.querySelector("style")?.textContent).toBe("\n.rule {\n  order: 1;\n}\n");
  expect(target.textContent).not.toContain("sol:");
  target.querySelector("button")!.click();
  expect(target.querySelector("textarea")?.textContent).toBe("Count 2; missing ; disabled ");
  expect(target.querySelector("style")?.textContent).toBe("\n.rule {\n  order: 2;\n}\n");
  dispose();
});

test("conditional and sibling Head blocks retain independent ownership", async () => {
  const staticTitle = document.createElement("title");
  staticTitle.textContent = "Static";
  document.head.append(staticTitle);
  const module = await loadCompiled(`
    import { $component, Head } from "@soljs/sol";
    export const App = $component(function App() {
      let showOptional = true;
      let olderTitle = "Older";
      return <main>
        <Head><title>{olderTitle}</title><meta name="shared" content="always" /></Head>
        {showOptional && <Head><title>Newer</title><meta name="shared" content="optional" /></Head>}
        <button id="update-older" onClick={() => olderTitle = "Older updated"}>Update older</button>
        <button id="hide-newer" onClick={() => showOptional = false}>Hide newer</button>
      </main>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);

  expect(
    [...document.head.querySelectorAll('meta[name="shared"]')].map((meta) =>
      meta.getAttribute("content"),
    ),
  ).toEqual(["optional", "always"]);
  expect(document.title).toBe("Newer");
  target.querySelector<HTMLButtonElement>("#update-older")!.click();
  expect(document.title).toBe("Newer");
  target.querySelector<HTMLButtonElement>("#hide-newer")!.click();
  expect(
    [...document.head.querySelectorAll('meta[name="shared"]')].map((meta) =>
      meta.getAttribute("content"),
    ),
  ).toEqual(["always"]);
  expect(document.title).toBe("Older updated");

  dispose();
  expect(document.title).toBe("Static");
  expect(document.head.querySelector('meta[name="shared"]')).toBeNull();
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
    import { $component, $context, Suspense, Await, ErrorBoundary } from "@soljs/sol";

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

test("query and mutation controllers update compiled DOM and opt into Suspense per request", async () => {
  const module = await loadCompiled(`
    import { $component, Suspense } from "@soljs/sol";

    const DataPanel = $component(function DataPanel() {
      const query = globalThis.integrationQuery({
        queryKey: ["compiled-query", ${JSON.stringify(crypto.randomUUID())}],
        query: () => new Promise<string>((resolve, reject) => {
          globalThis.integrationResolvers.push(resolve);
          globalThis.integrationRejectors.push(reject);
        }),
        cacheTime: 0,
      });
      const mutation = globalThis.integrationMutation({
        mutation: (value: string) => new Promise<string>((resolve, reject) => {
          globalThis.integrationResolvers.push(() => resolve(value));
          globalThis.integrationRejectors.push(reject);
        }),
      });
      function refetch() {
        void query.refetch({ suspense: true }).catch(() => {});
      }
      function mutate() {
        void mutation.mutate({ suspense: true }, "saved").catch(() => {});
      }
      function failWithoutSuspense() {
        void query.refetch({ suspense: false }).catch(() => {});
      }
      return <section id="data-panel">
        <p id="query-data">{query.data ?? "empty"}</p>
        <p id="query-last">{query.lastData ?? "none"}</p>
        <p id="query-failed">{String(query.isFailed)}</p>
        <p id="mutation-data">{mutation.data ?? "empty"}</p>
        <button id="refetch" onClick={refetch}>Refetch</button>
        <button id="mutate" onClick={mutate}>Mutate</button>
        <button id="fail" onClick={failWithoutSuspense}>Fail</button>
      </section>;
    });

    export const App = $component(function App() {
      return <Suspense
        fallback={<p id="controller-loading">Loading</p>}
        error={error => <p id="controller-error">{String(error)}</p>}
      >
        <DataPanel />
      </Suspense>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);

  expect(target.querySelector("#controller-loading")?.textContent).toBe("Loading");
  globalThis.integrationResolvers.shift()!("first");
  globalThis.integrationRejectors.shift();
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("#query-data")?.textContent).toBe("first");

  target.querySelector<HTMLButtonElement>("#refetch")!.click();
  expect(target.querySelector("#controller-loading")?.textContent).toBe("Loading");
  globalThis.integrationResolvers.shift()!("second");
  globalThis.integrationRejectors.shift();
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("#query-data")?.textContent).toBe("second");
  expect(target.querySelector("#query-last")?.textContent).toBe("first");

  target.querySelector<HTMLButtonElement>("#mutate")!.click();
  expect(target.querySelector("#controller-loading")?.textContent).toBe("Loading");
  globalThis.integrationResolvers.shift()!("ignored");
  globalThis.integrationRejectors.shift();
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("#mutation-data")?.textContent).toBe("saved");

  target.querySelector<HTMLButtonElement>("#fail")!.click();
  const failure = new Error("background failure");
  globalThis.integrationRejectors.shift()!(failure);
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("#data-panel")).not.toBeNull();
  expect(target.querySelector("#query-failed")?.textContent).toBe("true");
  expect(target.querySelector("#query-data")?.textContent).toBe("second");

  target.querySelector<HTMLButtonElement>("#refetch")!.click();
  expect(target.querySelector("#controller-loading")?.textContent).toBe("Loading");
  const boundaryFailure = new Error("boundary failure");
  globalThis.integrationRejectors.shift()!(boundaryFailure);
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("#controller-error")?.textContent).toContain("boundary failure");

  dispose();
  expect(target.childNodes).toHaveLength(0);
});

test("creates frame-bound controllers after async setup resumes", async () => {
  const module = await loadCompiled(`
    import { $component, $form, $query, $mutation } from "@soljs/sol";

    export const App = $component(async function App() {
      await Promise.resolve();
      const query = $query({
        queryKey: ["late-controller", ${JSON.stringify(crypto.randomUUID())}],
        query: async () => "ready",
        enabled: false,
        cacheTime: 0,
      });
      const mutation = $mutation({ mutation: async () => "saved" });
      const form = $form({
        schema: (values: { title: string }) => values,
        defaultValues: { title: "draft" },
      }, () => {});
      return <p id="late-controllers">{String(query.isFetching)}:{String(mutation.isMutating)}:{form.values.title}</p>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(target.querySelector("#late-controllers")?.textContent).toBe("false:false:draft");
  dispose();
});

test("rejects frame-bound controller factories retained past setup", async () => {
  const module = await loadCompiled(`
    import { $component, $form, $query, $mutation } from "@soljs/sol";

    export const App = $component(function App() {
      const makeQuery = () => $query({
        queryKey: ["retained", ${JSON.stringify(crypto.randomUUID())}],
        query: async () => "ready",
        enabled: false,
        cacheTime: 0,
      });
      const makeMutation = () => $mutation({ mutation: async () => "saved" });
      const makeForm = () => $form({
        schema: (values: { title: string }) => values,
        defaultValues: { title: "draft" },
      }, () => {});
      globalThis.integrationControllerFactories = [makeQuery, makeMutation, makeForm];
      return <p>ready</p>;
    });
  `);
  const dispose = mount(module.App as Component, document.createElement("main"));

  for (const factory of globalThis.integrationControllerFactories) {
    expect(factory).toThrow("component setup");
  }
  dispose();
});

test("rejects an aliased form helper after async setup loses its active frame", async () => {
  const module = await loadCompiled(`
    import { $component, $form } from "@soljs/sol";

    export const App = $component(async function App() {
      const createForm = $form;
      await Promise.resolve();
      const form = createForm({
        schema: (values: { title: string }) => values,
        defaultValues: { title: "draft" },
      }, () => {});
      return <p>{String(form.isSubmitting)}</p>;
    });
  `);

  await expectRejection(renderToStringAsync(module.App as Component), "component setup");
});

test("hydrates a fulfilled non-suspending initial query from its server loading branch", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      const query = globalThis.integrationQuery({
        queryKey: ["non-suspending-hydration", ${JSON.stringify(crypto.randomUUID())}],
        query: () => {
          globalThis.integrationLoads += 1;
          return Promise.resolve("replayed data");
        },
        cacheTime: 0,
        suspense: { initial: false },
      });
      return <main>
        {query.isFetching
          ? <p id="query-loading">Loading</p>
          : <p id="query-ready">{query.data}</p>}
      </main>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, undefined, {
    url: `https://example.test/${crypto.randomUUID()}`,
  });

  expect(target.querySelector("#query-loading")).not.toBeNull();
  expect(globalThis.integrationLoads).toBe(1);
  const dispose = await hydrate(App, target);

  expect(globalThis.integrationLoads).toBe(1);
  expect(target.querySelector("#query-loading")).toBeNull();
  expect(target.querySelector("#query-ready")?.textContent).toBe("replayed data");
  dispose();
});

test("rejects SSR when a fulfilled suspending query makes its boundary rerender fail", async () => {
  const module = await loadCompiled(`
    import { $component, Suspense } from "@soljs/sol";
    const Data = $component(function Data() {
      const query = globalThis.integrationQuery({
        queryKey: ["failed-server-rerender", ${JSON.stringify(crypto.randomUUID())}],
        query: () => Promise.resolve("ready"),
        cacheTime: 0,
      });
      if (query.data === "ready") throw new Error("server query rerender failed");
      return <p>Waiting</p>;
    });
    export const App = $component(function App() {
      return <Suspense fallback={<p>Timed out</p>} timeoutMs={20}><Data /></Suspense>;
    });
  `);

  await expectRejection(
    renderToStringAsync(module.App as Component),
    "server query rerender failed",
  );
});

test("disposing a suspended query finishes its parent boundary before settlement", async () => {
  const module = await loadCompiled(`
    import { $component, Suspense } from "@soljs/sol";
    const Pending = $component(function Pending() {
      const query = globalThis.integrationQuery({
        queryKey: ["disposed-query", ${JSON.stringify(crypto.randomUUID())}],
        query: () => new Promise<string>(resolve => globalThis.integrationResolvers.push(resolve)),
        cacheTime: 0,
      });
      return <p>{query.data ?? "pending"}</p>;
    });
    export const App = $component(function App() {
      return <Suspense fallback={<p>Loading</p>}><Pending /></Suspense>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);
  expect(target.textContent).toBe("Loading");
  dispose();
  globalThis.integrationResolvers.shift()!("late");
  await Promise.resolve();
  await Promise.resolve();
  expect(target.childNodes).toHaveLength(0);
});

test("a query failure without an async boundary remains in reactive controller state", async () => {
  const module = await loadCompiled(`
    import { $component } from "@soljs/sol";
    export const App = $component(function App() {
      const query = globalThis.integrationQuery({
        queryKey: ["boundary-free-failure", ${JSON.stringify(crypto.randomUUID())}],
        query: () => new Promise<string>((_resolve, reject) => {
          globalThis.integrationRejectors.push(reject);
        }),
        cacheTime: 0,
        suspense: { initial: false },
      });
      return <p id="boundary-free-state">
        {query.isFailed ? String(query.error) : "ready"}
      </p>;
    });
  `);
  const target = document.createElement("div");
  const dispose = mount(module.App as Component, target);
  expect(target.querySelector("#boundary-free-state")?.textContent).toBe("ready");

  globalThis.integrationRejectors.shift()!(new Error("stored without boundary"));
  await Promise.resolve();
  await Promise.resolve();
  expect(target.querySelector("#boundary-free-state")?.textContent).toContain(
    "stored without boundary",
  );
  dispose();
});

test("context optional reads and local Await errors work without Suspense", async () => {
  const module = await loadCompiled(`
    import { $component, $context, Await } from "@soljs/sol";
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

test("preserves context reads after async setup resumes", async () => {
  const module = await loadCompiled(`
    import { $component, $context, Suspense } from "@soljs/sol";
    const shared = $context<{ label: string }>();
    const AsyncChild = $component(async function AsyncChild(props: { context: typeof shared }) {
      const alias = props.context;
      await Promise.resolve();
      const first = alias?.use();
      const second = alias.use?.();
      const third = alias["use"]();
      const fourth = alias.use().label;
      const fifth = alias?.use().label;
      const sixth = alias.use?.().label;
      const use = alias.use;
      const useOptional = alias.useOptional;
      const templateUse = alias[\`use\`];
      const bound = alias?.use.bind(alias);
      const maybe = undefined as typeof shared | undefined;
      const missing = maybe?.use.name;
      const seventh = use();
      const eighth = useOptional();
      const ninth = templateUse();
      const tenth = bound?.();
      const service = { use() { return "ordinary method"; } };
      return <p id="async-context">{first?.label}:{second?.label}:{third.label}:{fourth}:{fifth}:{sixth}:{seventh.label}:{eighth?.label}:{ninth.label}:{tenth?.label}:{String(missing)}:{service.use()}</p>;
    });
    export const App = $component(function App() {
      const value = { label: "provided" };
      return <shared.Provider data={value}>
        <Suspense fallback={<p>Loading</p>}><AsyncChild context={shared} /></Suspense>
      </shared.Provider>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  const paragraph = target.querySelector("#async-context");
  expect(paragraph?.textContent).toBe(
    "provided:provided:provided:provided:provided:provided:provided:provided:provided:provided:undefined:ordinary method",
  );
  const dispose = await hydrate(App, target);
  expect(target.querySelector("#async-context")).toBe(paragraph);
  expect(paragraph?.textContent).toBe(
    "provided:provided:provided:provided:provided:provided:provided:provided:provided:provided:undefined:ordinary method",
  );
  dispose();
});

test("renders immutable primitive setup constants without reactive effects", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      const answer = 42;
      return <p id="stable-answer">{answer}</p>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  const paragraph = target.querySelector("#stable-answer");
  expect(paragraph?.textContent).toBe("42");

  const dispose = await hydrate(App, target);
  expect(target.querySelector("#stable-answer")).toBe(paragraph);
  expect(paragraph?.textContent).toBe("42");
  dispose();
});

test("missing contexts throw and ErrorBoundary catches sync and async render failures", async () => {
  const missingModule = await loadCompiled(`
    import { $component, $context } from "@soljs/sol";
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
    import { $component, ErrorBoundary } from "@soljs/sol";
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
    import { $component, Await, Suspense } from "@soljs/sol";
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
    import { $component, $context } from "@soljs/sol";
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
    import { $component, Await, Suspense } from "@soljs/sol";
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
    import { $component, Await, ErrorBoundary, Suspense } from "@soljs/sol";
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

test("async mount failures reach ErrorBoundary and settle Suspense", async () => {
  const module = await loadCompiled(`
    import { ErrorBoundary, Suspense } from "@soljs/sol";
    const Async = $component(async function Async() {
      await Promise.resolve();
      return <p ref={() => { throw new Error("async mount failed"); }}>Ready</p>;
    });
    export const App = $component(function App() {
      return <ErrorBoundary fallback={error => <p id="async-mount-error">{String((error as Error).cause ?? error)}</p>}>
        <Suspense fallback={<p id="pending">Pending</p>}>
          <Async />
        </Suspense>
      </ErrorBoundary>;
    });
  `);
  const target = document.createElement("main");
  const dispose = mount(module.App as Component, target);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(target.querySelector("#async-mount-error")?.textContent).toContain("async mount failed");
  expect(target.querySelector("#pending")).toBeNull();
  dispose();
});

test("compiled refs and portals preserve ownership across targets and body", async () => {
  const animations = installAnimations();
  const module = await loadCompiled(`
    import { $component, $context, Await, createRef, GlobalPortal, Portal } from "@soljs/sol";
    const context = $context<{ label: string }>();

    const PortalContent = $component(function PortalContent() {
      const shared = context.use();
      return <button
        id="portal-content"
        ref={element => globalThis.integrationPortalRef = element}
        onClick={() => globalThis.integrationPortalClicks += 1}
      >{shared.label}</button>;
    });

    export const App = $component(function App() {
      const first = createRef<HTMLDivElement>();
      const second = createRef<HTMLDivElement>();
      let useSecond = false;
      let invalidTarget = false;
      let showTargeted = true;
      let showGlobal = true;
      const shared = { label: "From context" };
      globalThis.integrationInvalidatePortalTarget = () => invalidTarget = true;
      return <context.Provider data={shared}>
        <main>
          <button id="retarget" onClick={() => useSecond = true}>Retarget</button>
          <button id="hide-targeted" onClick={() => showTargeted = false}>Hide targeted</button>
          <button id="hide-global" onClick={() => showGlobal = false}>Hide global</button>
          <Portal target={invalidTarget ? null as unknown as Element : (useSecond ? second : first).current!}>
            Portal text {2}
            {showTargeted && <>
              <PortalContent />
              <Await $promise={Promise.resolve("Async ready")}>
                {value => <p id="portal-async">{value}</p>}
              </Await>
            </>}
          </Portal>
          <div id="first-target" ref={first} />
          <div id="second-target" ref={second} />
          {showGlobal && <GlobalPortal>
            <aside id="global-content" $transition={{ leave: "transition-leave" }}>Global</aside>
          </GlobalPortal>}
        </main>
      </context.Provider>;
    });
  `);
  const target = document.createElement("div");
  document.body.append(target);
  globalThis.integrationPortalRef = null;
  globalThis.integrationPortalClicks = 0;
  const dispose = mount(module.App as Component, target);

  const portalNode = document.querySelector<HTMLButtonElement>("#portal-content")!;
  expect(portalNode.parentElement?.id).toBe("first-target");
  expect(document.querySelector("#first-target")?.textContent).toContain("Portal text2");
  expect(portalNode.textContent).toBe("From context");
  expect(globalThis.integrationPortalRef as Element | null).toBe(portalNode as Element | null);
  expect(document.querySelector("#global-content")?.parentElement).toBe(document.body);
  portalNode.click();
  expect(globalThis.integrationPortalClicks).toBe(1);
  await Promise.resolve();
  await Promise.resolve();
  expect(document.querySelector("#portal-async")?.textContent).toBe("Async ready");

  target.querySelector<HTMLButtonElement>("#retarget")!.click();
  expect(document.querySelector("#portal-content")).toBe(portalNode);
  expect(portalNode.parentElement?.id).toBe("second-target");
  expect(() => globalThis.integrationInvalidatePortalTarget()).toThrow(
    "Portal target must be a DOM Element",
  );
  expect(portalNode.parentElement?.id).toBe("second-target");

  target.querySelector<HTMLButtonElement>("#hide-targeted")!.click();
  expect(document.querySelector("#portal-content")).toBeNull();
  expect(globalThis.integrationPortalRef).toBeNull();

  target.querySelector<HTMLButtonElement>("#hide-global")!.click();
  expect(document.querySelector("#global-content")).not.toBeNull();
  expect(animations).toHaveLength(1);
  animations[0]!.finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.querySelector("#global-content")).toBeNull();

  dispose();
});

test("defers nested mount phases and activates keyed refs and portals", async () => {
  const module = await loadCompiled(`
    import { $component, createRef, Portal } from "@soljs/sol";
    export const App = $component(function App() {
      const conditionalTarget = createRef<HTMLDivElement>();
      const listTarget = createRef<HTMLDivElement>();
      let visible = true;
      let items = [{ id: 1 }];
      return <main>
        {visible && <Portal target={conditionalTarget.current!}>
          <button id="conditional-portal" ref={element => {
            globalThis.integrationConditionalRefConnected = element?.isConnected ?? false;
          }}>Conditional</button>
        </Portal>}
        <section>
          {items.map(item => <Portal key={item.id} target={listTarget.current!}>
            <button data-keyed-id={item.id} ref={element => {
              if (element) globalThis.integrationKeyedRefs.add(item.id);
              else globalThis.integrationKeyedRefs.delete(item.id);
            }}>{item.id}</button>
          </Portal>)}
        </section>
        <div id="conditional-target" ref={conditionalTarget} />
        <div id="list-target" ref={listTarget} />
        <button id="add-keyed" onClick={() => items.push({ id: 2 })}>Add</button>
        <button id="remove-keyed" onClick={() => items.splice(0, 1)}>Remove</button>
      </main>;
    });
  `);
  globalThis.integrationConditionalRefConnected = false;
  globalThis.integrationKeyedRefs = new Set();
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = mount(module.App as Component, target);

  expect(document.querySelector("#conditional-target > #conditional-portal")).not.toBeNull();
  expect(globalThis.integrationConditionalRefConnected).toBe(true);
  expect(globalThis.integrationKeyedRefs).toEqual(new Set([1]));
  expect(document.querySelectorAll("#list-target > [data-keyed-id]")).toHaveLength(1);

  target.querySelector<HTMLButtonElement>("#add-keyed")!.click();
  expect(globalThis.integrationKeyedRefs).toEqual(new Set([1, 2]));
  expect(document.querySelectorAll("#list-target > [data-keyed-id]")).toHaveLength(2);

  target.querySelector<HTMLButtonElement>("#remove-keyed")!.click();
  await Promise.resolve();
  expect(globalThis.integrationKeyedRefs).toEqual(new Set([2]));
  expect(document.querySelectorAll("#list-target > [data-keyed-id]")).toHaveLength(1);
  dispose();
  expect(globalThis.integrationKeyedRefs).toEqual(new Set());
});

test("server renders compiled primitives and resolved Suspense without a DOM", async () => {
  const module = await loadCompiled(`
    import { Suspense } from "@soljs/sol";
    const Child = $component(async function Child(props: { label: string }) {
      const value = await Promise.resolve(props.label);
      return <strong className={["ready", { active: true }]}>{value}</strong>;
    });
    export const App = $component(function App() {
      const items = ["one", "two"];
      const disabled = false;
      return <>
        <p id="marker-text">data-sol-e="0"</p>
        <main data-title={"<&"} aria-hidden={disabled} data-enabled={disabled}>
        <Suspense fallback={<p id="loading">Loading</p>} timeoutMs={100}>
          <Child label="done" />
          {items.map(item => <span key={item}>{item}</span>)}
        </Suspense>
        </main>
      </>;
    });
  `);
  const activeDocument = globalThis.document;
  Reflect.deleteProperty(globalThis, "document");
  let html: string;
  try {
    html = await renderToStringAsync(module.App as Component, undefined, { timeoutMs: 100 });
  } finally {
    globalThis.document = activeDocument;
  }
  expect(html).toContain('<main data-title="&lt;&amp;"');
  expect(html).toContain('<p id="marker-text">data-sol-e="0"</p>');
  expect(html).toContain('aria-hidden="false"');
  expect(html).toContain('data-enabled="false"');
  expect(html).toContain('<strong class="ready active"');
  expect(html).toContain(">done<!--sol:e:0-->");
  expect(html).toContain(">one<!--sol:e:0-->");
  expect(html).not.toContain('id="loading"');
  expect(html).toContain("data-sol-hydration");
});

test("server rendering keeps hostile raw-text closing tags inside their elements", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      const script = "</script><img id=script-injection>";
      const style = "</style><img id=style-injection>";
      return <><script>{script}</script><style>{style}</style></>;
    });
  `);
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(module.App as Component);

  expect(target.querySelector("#script-injection")).toBeNull();
  expect(target.querySelector("#style-injection")).toBeNull();
  expect(target.querySelector("script")?.textContent).toContain("<\\/script>");
  expect(target.querySelector("style")?.textContent).toContain("<\\/style>");

  const dispose = await hydrate(module.App as Component, target);
  expect(target.querySelector("#script-injection")).toBeNull();
  expect(target.querySelector("#style-injection")).toBeNull();
  expect(target.querySelector("script")?.textContent).toContain("<\\/script>");
  expect(target.querySelector("style")?.textContent).toContain("<\\/style>");
  dispose();
});

test("normalizes NUL in folded templates, attributes, and primitive branches", async () => {
  const module = await loadCompiled(`
    export const WithoutElement = $component(function WithoutElement(props: { visible: boolean }) {
      return <p>{"folded\\0sol:element:0\\0text"}{props.visible ? "branch\\0sol:element:0\\0text" : null}</p>;
    });
    export const WithElement = $component(function WithElement(props: { id: string; visible: boolean }) {
      return <main id={props.id} title={"attribute\\0sol:element:0\\0value"}>
        {props.visible ? "branch\\0sol:element:0\\0text" : null}
      </main>;
    });
  `);
  const expectedFolded = "folded\uFFFDsol:element:0\uFFFDtext";
  const expectedBranch = "branch\uFFFDsol:element:0\uFFFDtext";
  const expectedAttribute = "attribute\uFFFDsol:element:0\uFFFDvalue";
  const cases: Array<[Component<Record<string, unknown>>, string, Record<string, unknown>]> = [
    [module.WithoutElement as Component<Record<string, unknown>>, "p", { visible: true }],
    [
      module.WithElement as Component<Record<string, unknown>>,
      "main",
      { id: "owned", visible: true },
    ],
  ];
  await Promise.all(
    cases.map(async ([candidate, selector, props]) => {
      const html = await renderToStringAsync(candidate, props);
      expect(html).not.toContain("\0");
      const target = document.createElement("div");
      target.innerHTML = html;
      const disposeHydrated = await hydrate(candidate, target, props);
      const hydrated = target.querySelector(selector)!;
      expect(hydrated.textContent).toContain(expectedBranch);
      if (selector === "p") expect(hydrated.textContent).toContain(expectedFolded);
      else expect(hydrated.getAttribute("title")).toBe(expectedAttribute);
      const hydratedText = hydrated.textContent;
      disposeHydrated();

      const mounted = document.createElement("div");
      const disposeMounted = mount(candidate, mounted, props);
      expect(mounted.querySelector(selector)?.textContent).toBe(hydratedText);
      disposeMounted();
    }),
  );
});

test("normalizes lone surrogates across UTF-8 transport and preserves valid pairs", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App(props: {
      high: string;
      low: string;
      pair: string;
    }) {
      return <section title={props.high}>
        <p>{"folded\\uD800text"}{props.low}</p>
        <textarea value={props.high}></textarea>
        <span data-pair={props.pair}>{props.pair}</span>
      </section>;
    });
  `);
  const App = module.App as Component<{ high: string; low: string; pair: string }>;
  const props = {
    high: "dynamic\uD800high",
    low: "dynamic\uDC00low",
    pair: "valid\uD83D\uDE00pair",
  };
  const expectedHigh = "dynamic\uFFFDhigh";
  const expectedText = "folded\uFFFDtextdynamic\uFFFDlow";
  const html = await renderToStringAsync(App, props);
  const transported = new TextDecoder().decode(new TextEncoder().encode(html));
  expect(transported).toContain("valid😀pair");

  const target = document.createElement("div");
  target.innerHTML = transported;
  const disposeHydrated = await hydrate(App, target, props);
  expect(target.querySelector("section")?.getAttribute("title")).toBe(expectedHigh);
  expect(target.querySelector("p")?.textContent).toBe(expectedText);
  expect((target.querySelector("textarea") as HTMLTextAreaElement).value).toBe(expectedHigh);
  expect(target.querySelector("span")?.getAttribute("data-pair")).toBe("valid😀pair");
  expect(target.querySelector("span")?.textContent).toBe("valid😀pair");
  disposeHydrated();

  const mounted = document.createElement("div");
  const disposeMounted = mount(App, mounted, props);
  expect(mounted.querySelector("section")?.getAttribute("title")).toBe(expectedHigh);
  expect(mounted.querySelector("p")?.textContent).toBe(expectedText);
  expect((mounted.querySelector("textarea") as HTMLTextAreaElement).value).toBe(expectedHigh);
  expect(mounted.querySelector("span")?.getAttribute("data-pair")).toBe("valid😀pair");
  expect(mounted.querySelector("span")?.textContent).toBe("valid😀pair");
  disposeMounted();
});

test("preserves surrogate pairs split across adjacent raw-text values", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App(props: {
      high: string;
      low: string;
      lone: string;
    }) {
      return <main>
        <textarea id="pair-textarea">{props.high}{props.low}</textarea>
        <title id="pair-title">{"\\uD83D"}{props.low}</title>
        <script id="pair-script">/*{props.high}{props.low}*/</script>
        <style id="pair-style">/*{props.high}{props.low}*/</style>
        <textarea id="lone-textarea">{props.lone}</textarea>
      </main>;
    });
  `);
  const App = module.App as Component<{ high: string; low: string; lone: string }>;
  const props = { high: "\uD83D", low: "\uDE00", lone: "\uD83D" };
  const expectedPair = props.high + props.low;
  const html = await renderToStringAsync(App, props);
  const transported = new TextDecoder().decode(new TextEncoder().encode(html));
  const assertRawText = (target: ParentNode): void => {
    expect(target.querySelector("#pair-textarea")?.textContent).toBe(expectedPair);
    expect(target.querySelector("#pair-title")?.textContent).toBe(expectedPair);
    expect(target.querySelector("#pair-script")?.textContent).toBe(`/*${expectedPair}*/`);
    expect(target.querySelector("#pair-style")?.textContent).toBe(`/*${expectedPair}*/`);
    expect(target.querySelector("#lone-textarea")?.textContent).toBe("\uFFFD");
  };

  const target = document.createElement("div");
  target.innerHTML = transported;
  const disposeHydrated = await hydrate(App, target, props);
  assertRawText(target);
  disposeHydrated();

  const mounted = document.createElement("div");
  const disposeMounted = mount(App, mounted, props);
  assertRawText(mounted);
  disposeMounted();
});

test("normalizes NUL in controlled textarea values without colliding with element slots", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App(props: { note: string }) {
      let bound = props.note;
      return <section>
        <textarea id="literal" value={"literal\\0sol:element:0\\0value"}></textarea>
        <textarea id="dynamic" value={props.note}></textarea>
        <textarea id="bound" $bind={bound}></textarea>
      </section>;
    });
  `);
  const App = module.App as Component<{ note: string }>;
  const props = { note: "dynamic\0sol:element:0\0value" };
  const expectedLiteral = "literal\uFFFDsol:element:0\uFFFDvalue";
  const expectedDynamic = "dynamic\uFFFDsol:element:0\uFFFDvalue";
  const html = await renderToStringAsync(App, props);
  expect(html).not.toContain("\0");

  const target = document.createElement("div");
  target.innerHTML = html;
  const disposeHydrated = await hydrate(App, target, props);
  expect((target.querySelector("#literal") as HTMLTextAreaElement).value).toBe(expectedLiteral);
  expect((target.querySelector("#dynamic") as HTMLTextAreaElement).value).toBe(expectedDynamic);
  expect((target.querySelector("#bound") as HTMLTextAreaElement).value).toBe(expectedDynamic);
  disposeHydrated();

  const mounted = document.createElement("div");
  const disposeMounted = mount(App, mounted, props);
  expect((mounted.querySelector("#literal") as HTMLTextAreaElement).value).toBe(expectedLiteral);
  expect((mounted.querySelector("#dynamic") as HTMLTextAreaElement).value).toBe(expectedDynamic);
  expect((mounted.querySelector("#bound") as HTMLTextAreaElement).value).toBe(expectedDynamic);
  disposeMounted();
});

test("normalizes NUL in dynamic attributes across rendering modes", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App(props: { value: string }) {
      return <p title={props.value} className={props.value} aria-label={props.value} data-note={props.value}>Ready</p>;
    });
  `);
  const App = module.App as Component<{ value: string }>;
  const props = { value: "before\0after" };
  const expected = "before\uFFFDafter";
  const assertAttributes = (target: ParentNode): void => {
    const element = target.querySelector("p")!;
    expect(element.getAttribute("title")).toBe(expected);
    expect(element.getAttribute("class")).toBe(expected);
    expect(element.getAttribute("aria-label")).toBe(expected);
    expect(element.getAttribute("data-note")).toBe(expected);
  };

  const html = await renderToStringAsync(App, props);
  expect(html).not.toContain("\0");
  const target = document.createElement("div");
  target.innerHTML = html;
  assertAttributes(target);
  const disposeHydrated = await hydrate(App, target, props);
  assertAttributes(target);
  disposeHydrated();

  const mounted = document.createElement("div");
  const disposeMounted = mount(App, mounted, props);
  assertAttributes(mounted);
  disposeMounted();
});

test("server rendering selects options whose values are dynamic", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      let selected = "b";
      const first = "a";
      const second = "b";
      return <select $bind={selected}>
        <option value={first}>First</option>
        <option value={second}>Second</option>
      </select>;
    });
  `);
  const html = await renderToStringAsync(module.App as Component);

  expect(html).toMatch(/<option[^>]*value="b"[^>]*selected/);
  const target = document.createElement("main");
  target.innerHTML = html;
  const dispose = await hydrate(module.App as Component, target);
  expect(target.querySelector("select")!.value).toBe("b");
  dispose();
});

test("server rendering keeps parent region slots distinct from nested region markers", async () => {
  const module = await loadCompiled(`
    const First = $component(function First() {
      const left = "left";
      const right = "right";
      return <section><span>{left}</span><span>{right}</span></section>;
    });
    const Second = $component(function Second() { return <p id="second">Second</p>; });
    export const App = $component(function App() { return <main><First /><Second /></main>; });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  expect(target.querySelector("#second")?.textContent).toBe("Second");
  expect(target.querySelector("section")?.textContent).toBe("leftright");
  const second = target.querySelector("#second");
  const dispose = await hydrate(App, target);
  expect(target.querySelector("#second")).toBe(second);
  dispose();
});

test("server renders a timed-out Suspense fallback and rejects root timeouts", async () => {
  const module = await loadCompiled(`
    import { ErrorBoundary, Suspense } from "@soljs/sol";
    const Pending = $component(async function Pending() {
      await new Promise(() => {});
      return <p>never</p>;
    });
    const BrokenFallback = $component(function BrokenFallback() {
      globalThis.integrationLoads += 1;
      if (globalThis.integrationLoads > 1) throw new Error("broken timeout fallback");
      return <p>Initial fallback</p>;
    });
    export const Bounded = $component(function Bounded() {
      return <Suspense fallback={<p id="loading">Loading</p>} timeoutMs={0}><Pending /></Suspense>;
    });
    export const BoundedDefault = $component(function BoundedDefault() {
      return <Suspense fallback={<p id="default-loading">Default loading</p>}><Pending /></Suspense>;
    });
    export const Unbounded = $component(async function Unbounded() {
      await new Promise(() => {});
      return <p>never</p>;
    });
    export const BrokenBounded = $component(function BrokenBounded() {
      return <Suspense fallback={<BrokenFallback />} timeoutMs={0}><Pending /></Suspense>;
    });
    export const CaughtBrokenBounded = $component(function CaughtBrokenBounded() {
      return <ErrorBoundary fallback={error => <p id="caught-fallback">{String(error)}</p>}>
        <Suspense fallback={<BrokenFallback />} timeoutMs={0}><Pending /></Suspense>
      </ErrorBoundary>;
    });
  `);
  const html = await renderToStringAsync(module.Bounded as Component, undefined, { timeoutMs: 20 });
  expect(html).toContain('id="loading"');
  expect(html).not.toContain(">never<");
  const defaultHtml = await renderToStringAsync(module.BoundedDefault as Component, undefined, {
    timeoutMs: 0,
  });
  expect(defaultHtml).toContain('id="default-loading"');
  await expectRejection(
    renderToStringAsync(module.Unbounded as Component, undefined, { timeoutMs: 1 }),
    "timed out",
  );
  globalThis.integrationLoads = 0;
  await expectRejection(
    renderToStringAsync(module.BrokenBounded as Component, undefined, { timeoutMs: 20 }),
    "broken timeout fallback",
  );
  globalThis.integrationLoads = 0;
  const caught = await renderToStringAsync(module.CaughtBrokenBounded as Component, undefined, {
    timeoutMs: 20,
  });
  expect(caught).toContain('id="caught-fallback"');
  expect(caught).toContain("broken timeout fallback");
});

test("hydrates server DOM in place and replays async component data", async () => {
  globalThis.integrationSetups.app = 0;
  const module = await loadCompiled(`
    import { Suspense } from "@soljs/sol";
    const Child = $component(async function Child() {
      const value = await Promise.resolve().then(() => {
        globalThis.integrationSetups.app += 1;
        return "ready";
      });
      let count = 0;
      async function increment() {
        count = await Promise.resolve(count + 1);
      }
      return <button id="hydrated" onClick={increment}>{value}:{count}</button>;
    });
    export const App = $component(function App() {
      return <Suspense fallback={<p>Loading</p>}><Child /></Suspense>;
    });
  `);
  const App = module.App as Component;
  const html = await renderToStringAsync(App, undefined, { timeoutMs: 100 });
  expect(globalThis.integrationSetups.app).toBe(1);
  const target = document.createElement("div");
  target.innerHTML = html;
  const serverButton = target.querySelector("#hydrated");
  const dispose = await hydrate(App, target);
  expect(target.querySelector("#hydrated")).toBe(serverButton);
  expect(globalThis.integrationSetups.app).toBe(1);
  (serverButton as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
  expect(serverButton?.textContent).toBe("ready:1");
  dispose();
  expect(target.childNodes).toHaveLength(0);
});

test("hydrates refs and mounts browser-only portals after claiming server DOM", async () => {
  const module = await loadCompiled(`
    import { $component, createRef, Portal } from "@soljs/sol";
    export const App = $component(function App() {
      const target = createRef<HTMLDivElement>();
      return <main>
        <p id="server-node" ref={element => globalThis.integrationPortalRef = element}>Server</p>
        <Portal target={target.current!}><button id="hydrated-portal">Portal</button></Portal>
        <div id="portal-target" ref={target} />
      </main>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  const serverNode = target.querySelector("#server-node");
  expect(target.querySelector("#hydrated-portal")).toBeNull();
  globalThis.integrationPortalRef = null;

  const dispose = await hydrate(App, target);

  expect(target.querySelector("#server-node")).toBe(serverNode);
  expect(globalThis.integrationPortalRef as Element | null).toBe(serverNode as Element | null);
  expect(target.querySelector("#portal-target > #hydrated-portal")?.textContent).toBe("Portal");
  dispose();
  expect(globalThis.integrationPortalRef).toBeNull();
  expect(target.childNodes).toHaveLength(0);
});

test("hydrates primitive conditional blocks without duplicating their nodes", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      let ready = true;
      let optional = false;
      const label = "ready";
      return <main>
        <button id="toggle-primitive" onClick={() => ready = !ready}>Toggle</button>
        <button id="toggle-empty" onClick={() => optional = !optional}>Toggle empty</button>
        <p id="primitive-value">{ready ? label : "loading"}</p>
        <p id="empty-value">{optional && label}</p>
      </main>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  const paragraph = target.querySelector("#primitive-value")!;
  const serverText = [...paragraph.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
  expect(serverText).toBeDefined();
  const dispose = await hydrate(App, target);
  expect(paragraph.textContent).toBe("ready");
  expect([...paragraph.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)).toEqual([
    serverText!,
  ]);
  target.querySelector<HTMLButtonElement>("#toggle-primitive")!.click();
  expect(paragraph.textContent).toBe("loading");
  const empty = target.querySelector("#empty-value")!;
  expect(empty.textContent).toBe("");
  target.querySelector<HTMLButtonElement>("#toggle-empty")!.click();
  expect(empty.textContent).toBe("ready");
  dispose();
});

test("reorders and disposes hydrated keyed rows in place", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
      return <main>
        <button id="reverse-hydrated" onClick={() => items.reverse()}>Reverse</button>
        <button id="remove-hydrated" onClick={() => items.splice(1, 1)}>Remove middle</button>
        <ul>{items.map(item => <li key={item.id} data-id={item.id}>{item.id}</li>)}</ul>
      </main>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  const serverRows = [...target.querySelectorAll("li")];

  const dispose = await hydrate(App, target);
  expect([...target.querySelectorAll("li")]).toEqual(serverRows);
  target.querySelector<HTMLButtonElement>("#reverse-hydrated")!.click();
  expect([...target.querySelectorAll("li")]).toEqual([
    serverRows[2]!,
    serverRows[1]!,
    serverRows[0]!,
  ]);

  target.querySelector<HTMLButtonElement>("#remove-hydrated")!.click();
  expect([...target.querySelectorAll("li")]).toEqual([serverRows[2]!, serverRows[0]!]);
  expect(serverRows[1]!.isConnected).toBe(false);
  dispose();
  expect(target.childNodes).toHaveLength(0);
});

test("hydrates a timed-out fallback and resumes only its pending work", async () => {
  globalThis.integrationSetups.app = 0;
  globalThis.integrationPending = new Promise((resolve) => {
    globalThis.integrationResolve = resolve;
  });
  const module = await loadCompiled(`
    import { Suspense } from "@soljs/sol";
    const Child = $component(async function Child() {
      const value = await (() => {
        globalThis.integrationSetups.app += 1;
        return globalThis.integrationPending;
      })();
      return <p id="resumed">{value}</p>;
    });
    export const App = $component(function App() {
      return <Suspense fallback={<p id="timed-out">Waiting</p>} timeoutMs={0}><Child /></Suspense>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, undefined, { timeoutMs: 20 });
  const fallback = target.querySelector("#timed-out");
  expect(globalThis.integrationSetups.app).toBe(1);
  const dispose = await hydrate(App, target);
  expect(target.querySelector("#timed-out")).toBe(fallback);
  expect(globalThis.integrationSetups.app).toBe(2);
  globalThis.integrationResolve("continued");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(target.querySelector("#resumed")?.textContent).toBe("continued");
  expect(target.querySelector("#timed-out")).toBeNull();
  dispose();
});

test("rejects hydration mismatches without replacing server DOM", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() { return <main><p>Stable</p></main>; });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  const original = target.firstChild;
  (target.querySelector("main") as HTMLElement).outerHTML = "<section><p>Changed</p></section>";
  await expectRejection(hydrate(App, target), "hydration mismatch");
  expect(target.firstChild).toBe(original);
  expect(target.querySelector("section")?.textContent).toBe("Changed");

  target.innerHTML = await renderToStringAsync(App);
  const signedStart = target.firstChild as Comment;
  signedStart.data = "sol:block:start:tstale";
  await expectRejection(hydrate(App, target), "template payload order mismatch");
  expect((target.firstChild as Comment).data).toBe("sol:block:start:tstale");

  const dynamicModule = await loadCompiled(`
    export const App = $component(function App(props: { label: string }) {
      return <main data-label={props.label}>{props.label}</main>;
    });
  `);
  const dynamicApp = dynamicModule.App as Component<{ label: string }>;
  const dynamicHtml = await renderToStringAsync(dynamicApp, { label: "server" });
  target.innerHTML = dynamicHtml;
  target.querySelector("main")!.removeAttribute("data-sol-e");
  const missingElementMarker = target.innerHTML;
  await expectRejection(
    hydrate(dynamicApp, target, { label: "server" }),
    "expected element marker 0",
  );
  expect(target.innerHTML).toBe(missingElementMarker);

  target.innerHTML = dynamicHtml;
  target.querySelector("main")!.setAttribute("data-sol-e", "1");
  const wrongElementMarker = target.innerHTML;
  await expectRejection(
    hydrate(dynamicApp, target, { label: "server" }),
    "expected element marker 0",
  );
  expect(target.innerHTML).toBe(wrongElementMarker);
});

test("does not let ErrorBoundary swallow hydration mismatches", async () => {
  const module = await loadCompiled(`
    import { ErrorBoundary, Suspense } from "@soljs/sol";
    export const App = $component(function App(props: { label: string }) {
      return <ErrorBoundary fallback={error => <p id="boundary-fallback">{String(error)}</p>}>
        <Suspense fallback={<p>Loading</p>} error={error => <p id="suspense-error">{String(error)}</p>}>
          <main data-label={props.label}>{props.label}</main>
        </Suspense>
      </ErrorBoundary>;
    });
  `);
  const App = module.App as Component<{ label: string }>;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, { label: "server" });
  const serverMain = target.querySelector("main");
  const serverHtml = target.innerHTML;

  await expectRejection(hydrate(App, target, { label: "client" }), "hydration mismatch");
  expect(target.innerHTML).toBe(serverHtml);
  expect(target.querySelector("main")).toBe(serverMain);
  expect(target.querySelector("#boundary-fallback")).toBeNull();
  expect(target.querySelector("#suspense-error")).toBeNull();
});

test("rejects dynamic hydration prop mismatches without mutating server DOM", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App(props: { label: string; tone: string }) {
      return <main data-tone={props.tone}>{props.label}</main>;
    });
  `);
  const App = module.App as Component<{ label: string; tone: string }>;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, { label: "server", tone: "calm" });
  const main = target.querySelector("main")!;
  await expectRejection(hydrate(App, target, { label: "client", tone: "loud" }), "mismatch");
  expect(target.querySelector("main")).toBe(main);
  expect(main.getAttribute("data-tone")).toBe("calm");
  expect(main.textContent).toBe("server");
});

test("server form bindings parse correctly and hydration validates instead of mutating", async () => {
  const module = await loadCompiled(`
    const Child = $component(function Child() { return <p id="binding-child">Stable</p>; });
    export const App = $component(function App(props: { selected: string; note: string }) {
      let selected = props.selected;
      let note = props.note;
      return <main>
        <select id="bound-select" $bind={selected}>
          <option value="first">First</option>
          <option>Second</option>
        </select>
        <textarea id="bound-note" $bind={note}></textarea>
        <Child />
      </main>;
    });
  `);
  const App = module.App as Component<{ selected: string; note: string }>;
  const props = { selected: "Second", note: "server note" };
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, props);
  const select = target.querySelector<HTMLSelectElement>("#bound-select")!;
  const note = target.querySelector<HTMLTextAreaElement>("#bound-note")!;
  expect(select.value).toBe("Second");
  expect(note.value).toBe("server note");
  const dispose = await hydrate(App, target, props);
  expect(target.querySelector("#bound-select")).toBe(select);
  expect(target.querySelector("#bound-note")).toBe(note);
  dispose();

  target.innerHTML = await renderToStringAsync(App, props);
  const mismatchedSelect = target.querySelector<HTMLSelectElement>("#bound-select")!;
  const mismatchedNote = target.querySelector<HTMLTextAreaElement>("#bound-note")!;
  await expectRejection(
    hydrate(App, target, { selected: "first", note: "client note" }),
    "bound value differs",
  );
  expect(mismatchedSelect.value).toBe("Second");
  expect(mismatchedNote.value).toBe("server note");
});

test("rejects competing controlled select and option selection owners", async () => {
  await expectRejection(
    loadCompiled(`
      export const App = $component(function App(props: { forceB: boolean }) {
        return <select value="a">
          <option value="a">A</option>
          <optgroup><option value="b" selected={props.forceB}>B</option></optgroup>
        </select>;
      });
    `),
    "Controlled select cannot contain an option selected attribute",
  );
});

test("hydrates dynamic textarea and select values as DOM properties", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App(props: { selected: string; note: string }) {
      return <main>
        <select id="dynamic-select" value={props.selected}>
          <option value="first">First</option>
          <option value="second">Second</option>
        </select>
        <textarea id="dynamic-note" value={props.note}></textarea>
      </main>;
    });
  `);
  const App = module.App as Component<{ selected: string; note: string }>;
  const props = { selected: "second", note: "server note" };
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, props);
  const select = target.querySelector<HTMLSelectElement>("#dynamic-select")!;
  const note = target.querySelector<HTMLTextAreaElement>("#dynamic-note")!;
  expect(select.value).toBe("second");
  expect(note.value).toBe("server note");

  const dispose = await hydrate(App, target, props);
  expect(target.querySelector("#dynamic-select")).toBe(select);
  expect(target.querySelector("#dynamic-note")).toBe(note);
  dispose();

  target.innerHTML = await renderToStringAsync(App, props);
  const serverHtml = target.innerHTML;
  const mismatchedSelect = target.querySelector<HTMLSelectElement>("#dynamic-select")!;
  const mismatchedNote = target.querySelector<HTMLTextAreaElement>("#dynamic-note")!;
  await expectRejection(
    hydrate(App, target, { selected: "first", note: "client note" }),
    "dynamic attribute value differs",
  );
  expect(target.innerHTML).toBe(serverHtml);
  expect(target.querySelector("#dynamic-select")).toBe(mismatchedSelect);
  expect(target.querySelector("#dynamic-note")).toBe(mismatchedNote);
  expect(mismatchedSelect.value).toBe("second");
  expect(mismatchedNote.value).toBe("server note");
});

test("mounts and hydrates static textarea and select values as DOM properties", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      return <main>
        <select id="static-select" value="second">
          <option value="first">First</option>
          <option value="second">Second</option>
        </select>
        <textarea id="static-note" value="server note"></textarea>
      </main>;
    });
  `);
  const App = module.App as Component;
  const mounted = document.createElement("div");
  const disposeMount = mount(App, mounted);
  expect(mounted.querySelector<HTMLSelectElement>("#static-select")!.value).toBe("second");
  expect(mounted.querySelector<HTMLTextAreaElement>("#static-note")!.value).toBe("server note");
  disposeMount();

  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  expect(target.querySelector<HTMLSelectElement>("#static-select")!.value).toBe("second");
  expect(target.querySelector<HTMLTextAreaElement>("#static-note")!.value).toBe("server note");
  const disposeHydration = await hydrate(App, target);
  expect(target.querySelector<HTMLSelectElement>("#static-select")!.value).toBe("second");
  expect(target.querySelector<HTMLTextAreaElement>("#static-note")!.value).toBe("server note");
  disposeHydration();
});

test("binds mixed-case checkbox types through their checked property", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App(props: { initial: boolean }) {
      let checked = props.initial;
      return <main>
        <input id="mixed-checkbox" Type="CHECKBOX" $bind={checked} />
        <output>{checked ? "checked" : "clear"}</output>
      </main>;
    });
  `);
  const App = module.App as Component<{ initial: boolean }>;

  const assertBound = (target: Element) => {
    const input = target.querySelector<HTMLInputElement>("#mixed-checkbox")!;
    expect(input.checked).toBe(true);
    expect(target.querySelector("output")?.textContent).toBe("checked");
    input.checked = false;
    input.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    expect(target.querySelector("output")?.textContent).toBe("clear");
  };

  const mounted = document.createElement("div");
  const disposeMount = mount(App, mounted, { initial: true });
  assertBound(mounted);
  disposeMount();

  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, { initial: true });
  expect(target.querySelector<HTMLInputElement>("#mixed-checkbox")!.checked).toBe(true);
  const disposeHydration = await hydrate(App, target, { initial: true });
  assertBound(target);
  disposeHydration();
});

test("keeps boolean input values and numeric zero classes consistent across rendering modes", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App(props: { value: boolean; classValue: number }) {
      return <main>
        <input id="literal-false" value={false} />
        <input id="literal-true" value={true} />
        <input id="dynamic-value" value={props.value} />
        <p id="literal-class" class={0}>Literal</p>
        <p id="dynamic-class" class={props.classValue}>Dynamic</p>
      </main>;
    });
  `);
  const App = module.App as Component<{ value: boolean; classValue: number }>;
  const props = { value: false, classValue: 0 };

  const mounted = document.createElement("div");
  const disposeMount = mount(App, mounted, props);
  expectBooleanValueParity(mounted);
  disposeMount();

  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, props);
  expectBooleanValueParity(target);
  const disposeHydration = await hydrate(App, target, props);
  expectBooleanValueParity(target);
  disposeHydration();

  target.innerHTML = await renderToStringAsync(App, props);
  const serverInput = target.querySelector<HTMLInputElement>("#dynamic-value")!;
  await expectRejection(
    hydrate(App, target, { value: true, classValue: 0 }),
    "dynamic attribute value differs",
  );
  expect(target.querySelector("#dynamic-value")).toBe(serverInput);
  expect(serverInput.value).toBe("false");
});

test("omits falsey mixed-case and media boolean attributes in every rendering mode", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      return <main>
        <button id="quoted" disabled="">Quoted</button>
        <button id="empty" DISABLED={""}>Empty</button>
        <input id="readonly" READONLY={0} />
        <video id="media" disablePictureInPicture={0} disableRemotePlayback={0}></video>
      </main>;
    });
  `);
  const App = module.App as Component;

  const mounted = document.createElement("div");
  const disposeMount = mount(App, mounted);
  expectFalseyBooleanAbsence(mounted);
  disposeMount();

  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  expectFalseyBooleanAbsence(target);
  const disposeHydration = await hydrate(App, target);
  expectFalseyBooleanAbsence(target);
  disposeHydration();
});

test("mounts and hydrates camel-case SVG intrinsics in their native namespaces", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      return <svg id="graphic">
        <defs><linearGradient id="fade"></linearGradient></defs>
        <text><textPath href="#curve">Label</textPath></text>
        <foreignObject><div id="html-child">HTML</div></foreignObject>
      </svg>;
    });
  `);
  const App = module.App as Component;

  const mounted = document.createElement("div");
  const disposeMount = mount(App, mounted);
  expectSvgNamespaces(mounted);
  disposeMount();

  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  expectSvgNamespaces(target);
  const disposeHydration = await hydrate(App, target);
  expectSvgNamespaces(target);
  disposeHydration();
});

test("hydration rejects a Link destination mismatch without rewriting href", async () => {
  const module = await loadCompiled(`
    import { Link } from "@soljs/sol";
    import { route as runtimeRoute } from "@soljs/sol/compiler-runtime";
    const Page = $component(function Page() { return <main>Page</main>; });
    const destination = runtimeRoute(
      { path: "/item/:id" },
      Page,
      {
        pattern: "^/item/([^/]+)$",
        parameterNames: ["id"],
        pathnameParameterNames: ["id"],
        queryParameters: [],
        specificity: [1, 0],
      },
    );
    export const App = $component(function App(props: { id: string }) {
      const params = { id: props.id };
      return <Link route={destination} params={params}><a id="bound-link">Open</a></Link>;
    });
  `);
  const App = module.App as Component<{ id: string }>;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, { id: "server" });
  const anchor = target.querySelector<HTMLAnchorElement>("#bound-link")!;
  expect(anchor.getAttribute("href")).toBe("/item/server");
  await expectRejection(hydrate(App, target, { id: "client" }), "Link href differs");
  expect(target.querySelector("#bound-link")).toBe(anchor);
  expect(anchor.getAttribute("href")).toBe("/item/server");
});

test("rejects reordered template payload entries", async () => {
  const module = await loadCompiled(`
    const Child = $component(function Child() { return <p>Child</p>; });
    export const App = $component(function App() { return <main><Child /></main>; });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  const script = target.querySelector<HTMLScriptElement>("script[data-sol-hydration]")!;
  const payload = deserializeGraph(script.textContent) as { templates: string[] };
  payload.templates.reverse();
  script.textContent = serializeGraph(payload);
  const original = target.firstChild;
  await expectRejection(hydrate(App, target), "template payload order mismatch");
  expect(target.firstChild).toBe(original);
});

test("rejects missing and reordered hydration region comments", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() {
      const label = "dynamic";
      return <main>{label}</main>;
    });
  `);
  const App = module.App as Component;
  const html = await renderToStringAsync(App);
  const target = document.createElement("div");

  target.innerHTML = html.replace("<!--sol:s:0-->", "");
  const missingMarkup = target.innerHTML;
  await expectRejection(hydrate(App, target), "hydration mismatch");
  expect(target.innerHTML).toBe(missingMarkup);

  target.innerHTML = html.replace(
    "<!--sol:s:0-->dynamic<!--sol:e:0-->",
    "<!--sol:e:0-->dynamic<!--sol:s:0-->",
  );
  const reorderedMarkup = target.innerHTML;
  await expectRejection(hydrate(App, target), "hydration mismatch");
  expect(target.innerHTML).toBe(reorderedMarkup);

  target.innerHTML = html.replace("<!--sol:e:0-->", "<!--sol:e:999-->");
  const wrongIdentityMarkup = target.innerHTML;
  await expectRejection(hydrate(App, target), "expected <!--sol:e:0-->");
  expect(target.innerHTML).toBe(wrongIdentityMarkup);
});

test("rejects extra replay entries and nested async-site mismatches", async () => {
  const staticModule = await loadCompiled(`
    export const App = $component(function App() { return <main>Static</main>; });
  `);
  const staticApp = staticModule.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(staticApp);
  let script = target.querySelector<HTMLScriptElement>("script[data-sol-hydration]")!;
  const extraPayload = deserializeGraph(script.textContent) as {
    async: { site: string; status: "pending" }[];
  };
  extraPayload.async.push({ site: "await:extra", status: "pending" });
  script.textContent = serializeGraph(extraPayload);
  const staticRoot = target.firstChild;
  await expectRejection(hydrate(staticApp, target), "consume every async entry");
  expect(target.firstChild).toBe(staticRoot);

  const asyncModule = await loadCompiled(`
    const Child = $component(async function Child() {
      const value = await Promise.resolve("nested");
      return <p>{value}</p>;
    });
    export const App = $component(function App() { return <main><Child /></main>; });
  `);
  const asyncApp = asyncModule.App as Component;
  target.innerHTML = await renderToStringAsync(asyncApp);
  script = target.querySelector<HTMLScriptElement>("script[data-sol-hydration]")!;
  const stalePayload = deserializeGraph(script.textContent) as {
    async: { site: string }[];
  };
  stalePayload.async[0]!.site = "await:stale";
  script.textContent = serializeGraph(stalePayload);
  const asyncRoot = target.firstChild;
  await expectRejection(hydrate(asyncApp, target), "async mismatch");
  expect(target.firstChild).toBe(asyncRoot);
});

test("validates SSR and hydration public interfaces and payloads", async () => {
  const module = await loadCompiled(`
    export const App = $component(function App() { return <main>Valid</main>; });
  `);
  const App = module.App as Component;
  await expectRejection(renderToStringAsync(null as never), "compiled Sol component");
  await expectRejection(renderToStringAsync(App, 1 as never), "props must be an object");
  await expectRejection(renderToStringAsync(App, [] as never), "props must be an object");
  await expectRejection(
    renderToStringAsync(App, undefined, null as never),
    "options must be an object",
  );
  await Promise.all(
    [-1, NaN, Infinity].map((timeoutMs) =>
      expectRejection(renderToStringAsync(App, undefined, { timeoutMs }), "finite non-negative"),
    ),
  );
  await expectRejection(
    renderToStringAsync(App, undefined, { onHead: "invalid" } as never),
    "onHead must be a function",
  );
  const headModule = await loadCompiled(`
    import { Head } from "@soljs/sol";
    export const App = $component(function App() { return <><Head><title>Required callback</title></Head><main /></>; });
  `);
  await expectRejection(
    renderToStringAsync(headModule.App as Component),
    "without an onHead callback",
  );

  const lateFailureModule = await loadCompiled(`
    import { Head } from "@soljs/sol";
    export const App = $component(async function App() {
      const value = await Promise.resolve(() => undefined);
      return <><Head><title>Must not leak</title></Head><main>{String(value)}</main></>;
    });
  `);
  const publishedHead: string[] = [];
  await expectRejection(
    renderToStringAsync(lateFailureModule.App as Component, undefined, {
      onHead: (html) => publishedHead.push(html),
    }),
    "Cannot serialize async site",
  );
  expect(publishedHead).toEqual([]);

  const suspenseModule = await loadCompiled(`
    import { Suspense } from "@soljs/sol";
    export const App = $component(function App(props: { timeoutMs: number }) {
      return <Suspense fallback={<p>Loading</p>} timeoutMs={props.timeoutMs}><main>Ready</main></Suspense>;
    });
  `);
  const SuspenseApp = suspenseModule.App as Component<{ timeoutMs: number }>;
  for (const timeoutMs of [-1, NaN, Infinity]) {
    expect(() => mount(SuspenseApp, document.createElement("div"), { timeoutMs })).toThrow(
      "finite non-negative",
    );
  }

  const target = document.createElement("div");
  await expectRejection(hydrate(null as never, target), "compiled Sol component");
  await expectRejection(hydrate(App, { nodeType: 1 } as never), "DOM Element target");
  await expectRejection(hydrate(App, target, [] as never), "props must be an object");
  await expectRejection(hydrate(App, target), "payload is missing");
  target.innerHTML =
    '<script type="application/json" data-sol-hydration>{</script>' +
    '<script type="application/json" data-sol-hydration>{}</script>';
  await expectRejection(hydrate(App, target), "exactly once");
  target.innerHTML = `<script data-sol-hydration>${serializeGraph({
    version: 1,
    templates: [],
    async: [],
    boundaries: [],
  })}</script>`;
  await expectRejection(hydrate(App, target), 'type="application/json"');
  target.innerHTML = `<script type="text/javascript" data-sol-hydration>${serializeGraph({
    version: 1,
    templates: [],
    async: [],
    boundaries: [],
  })}</script>`;
  await expectRejection(hydrate(App, target), 'type="application/json"');
  target.innerHTML = '<script type="application/json" data-sol-hydration>{</script>';
  await expectRejection(hydrate(App, target), "payload JSON");
  target.innerHTML = `<script type="application/json" data-sol-hydration>${serializeGraph({
    version: 999,
    templates: [],
    async: [],
    boundaries: [],
  })}</script>`;
  await expectRejection(hydrate(App, target), "protocol 999");
  target.innerHTML = `<script type="application/json" data-sol-hydration>${serializeGraph({
    version: 1,
    templates: [],
    async: [{ site: 1, status: "fulfilled", value: "bad" }],
    boundaries: [],
  })}</script>`;
  await expectRejection(hydrate(App, target), "async payload");
  target.innerHTML = `<script type="application/json" data-sol-hydration>${serializeGraph({
    version: 1,
    templates: [],
    async: [{ site: "await:test:0", status: "pending", value: "unexpected" }],
    boundaries: [],
  })}</script>`;
  await expectRejection(hydrate(App, target), "async payload");
  target.innerHTML = `<script type="application/json" data-sol-hydration>${serializeGraph({
    version: 1,
    templates: [],
    async: [{ site: "await:test:0", status: "fulfilled", value: "ok", extra: true }],
    boundaries: [],
  })}</script>`;
  await expectRejection(hydrate(App, target), "async payload");
  target.innerHTML = `<script type="application/json" data-sol-hydration>${serializeGraph({
    version: 1,
    templates: [],
    async: [],
    boundaries: [],
    extra: true,
  })}</script>`;
  await expectRejection(hydrate(App, target), "payload fields");
});

test("reports the await site when replay data cannot be serialized", async () => {
  const module = await loadCompiled(`
    export const App = $component(async function App() {
      await Promise.resolve(() => undefined);
      return <main>Rendered</main>;
    });
  `);
  await expectRejection(
    renderToStringAsync(module.App as Component),
    "async site await:Integration.tsx:0",
  );
});

test("preserves undefined root rejections", async () => {
  const module = await loadCompiled(`
    export const App = $component(async function App() {
      await Promise.reject(undefined);
      return <main>Unexpected</main>;
    });
  `);
  let rejected = false;
  let reason: unknown = "not rejected";
  try {
    await renderToStringAsync(module.App as Component);
  } catch (error) {
    rejected = true;
    reason = error;
  }
  expect(rejected).toBe(true);
  expect(reason).toBeUndefined();
});

test("does not capture fire-and-forget helper awaits", async () => {
  globalThis.integrationSetups.app = 0;
  const module = await loadCompiled(`
    export const App = $component(async function App() {
      async function sideEffect() {
        await Promise.resolve();
        globalThis.integrationSetups.app += 1;
      }
      void sideEffect();
      const value = await Promise.resolve("ready");
      return <main>{value}</main>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  expect(globalThis.integrationSetups.app).toBe(1);
  const payload = deserializeGraph(
    target.querySelector<HTMLScriptElement>("script[data-sol-hydration]")!.textContent,
  ) as { async: unknown[] };
  expect(payload.async).toHaveLength(1);
  const dispose = await hydrate(App, target);
  expect(globalThis.integrationSetups.app).toBe(2);
  dispose();
});

test("captures awaited and fire-and-forget invocations of one helper independently", async () => {
  globalThis.integrationLoad = async (id) => {
    globalThis.integrationLoads += 1;
    return `${id} result`;
  };
  const module = await loadCompiled(`
    export const App = $component(async function App() {
      async function load(id: string) {
        return await globalThis.integrationLoad(id);
      }
      void load("background");
      const value = await load("render");
      return <p id="invocation-result">{value}</p>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  expect(globalThis.integrationLoads).toBe(2);
  const payload = deserializeGraph(
    target.querySelector<HTMLScriptElement>("script[data-sol-hydration]")!.textContent,
  ) as { async: { status: string }[] };
  expect(payload.async).toHaveLength(1);
  expect(payload.async[0]?.status).toBe("fulfilled");
  const paragraph = target.querySelector("#invocation-result");
  const dispose = await hydrate(App, target);
  expect(globalThis.integrationLoads).toBe(3);
  expect(target.querySelector("#invocation-result")).toBe(paragraph);
  expect(paragraph?.textContent).toBe("render result");
  dispose();
});

test("replays repeated same-site component awaits resolved out of order", async () => {
  const resolvers = new Map<string, (value: unknown) => void>();
  globalThis.integrationLoad = (id) => {
    globalThis.integrationLoads += 1;
    return new Promise((resolve) => resolvers.set(id, resolve));
  };
  const module = await loadCompiled(`
    const Child = $component(async function Child(props: { id: string }) {
      const value = await globalThis.integrationLoad(props.id);
      return <p data-id={props.id}>{String(value)}</p>;
    });
    export const App = $component(function App() {
      return <main><Child id="first" /><Child id="second" /></main>;
    });
  `);
  const App = module.App as Component;
  const rendering = renderToStringAsync(App);
  expect(globalThis.integrationLoads).toBe(2);
  resolvers.get("second")!("second result");
  await Promise.resolve();
  resolvers.get("first")!("first result");
  const target = document.createElement("div");
  target.innerHTML = await rendering;
  const first = target.querySelector('[data-id="first"]');
  const second = target.querySelector('[data-id="second"]');
  const payload = deserializeGraph(
    target.querySelector<HTMLScriptElement>("script[data-sol-hydration]")!.textContent,
  ) as { async: { site: string }[] };
  expect(payload.async.map((entry) => entry.site)).toEqual([
    "await:Integration.tsx:0",
    "await:Integration.tsx:0",
  ]);
  const dispose = await hydrate(App, target);
  expect(globalThis.integrationLoads).toBe(2);
  expect(target.querySelector('[data-id="first"]')).toBe(first);
  expect(target.querySelector('[data-id="second"]')).toBe(second);
  expect(first?.textContent).toBe("first result");
  expect(second?.textContent).toBe("second result");
  dispose();
});

test("replays nested helper Promise.all data driving branches and lists", async () => {
  globalThis.integrationLoad = async (id) => {
    globalThis.integrationLoads += 1;
    return id === "visible" ? true : ["one", "two"];
  };
  const module = await loadCompiled(`
    export const App = $component(async function App() {
      async function loadPage() {
        return await Promise.all([
          globalThis.integrationLoad("visible"),
          globalThis.integrationLoad("items"),
        ]);
      }
      const data = await loadPage() as [boolean, string[]];
      return <main>
        {data[0] && <h1 id="async-branch">Visible</h1>}
        <ul>{data[1].map(item => <li key={item}>{item}</li>)}</ul>
      </main>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App);
  expect(globalThis.integrationLoads).toBe(2);
  const payload = deserializeGraph(
    target.querySelector<HTMLScriptElement>("script[data-sol-hydration]")!.textContent,
  ) as { async: { site: string }[] };
  expect(payload.async.map((entry) => entry.site)).toEqual(["await:Integration.tsx:0"]);
  const branch = target.querySelector("#async-branch");
  const rows = [...target.querySelectorAll("li")];
  const dispose = await hydrate(App, target);
  expect(globalThis.integrationLoads).toBe(2);
  expect(target.querySelector("#async-branch")).toBe(branch);
  expect([...target.querySelectorAll("li")]).toEqual(rows);
  expect(rows.map((row) => row.textContent)).toEqual(["one", "two"]);
  dispose();
});

test("replays eagerly initialized promises and Promise.all helper sites", async () => {
  globalThis.integrationLoad = async (id) => {
    globalThis.integrationLoads += 1;
    return `${id} result`;
  };
  const eagerModule = await loadCompiled(`
    export const App = $component(async function App() {
      const request = globalThis.integrationLoad("eager");
      const value = await (request satisfies Promise<string>);
      return <p id="eager-result">{String(value)}</p>;
    });
  `);
  const eagerApp = eagerModule.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(eagerApp);
  expect(globalThis.integrationLoads).toBe(1);
  const eagerParagraph = target.querySelector("#eager-result");
  const disposeEager = await hydrate(eagerApp, target);
  expect(globalThis.integrationLoads).toBe(1);
  expect(target.querySelector("#eager-result")).toBe(eagerParagraph);
  expect(eagerParagraph?.textContent).toBe("eager result");
  disposeEager();

  globalThis.integrationLoads = 0;
  const allModule = await loadCompiled(`
    export const App = $component(async function App() {
      async function one() { return await globalThis.integrationLoad("one"); }
      async function two() { return await globalThis.integrationLoad("two"); }
      const values = await Promise.all([one(), two()]);
      return <p id="all-result">{values.join(":")}</p>;
    });
  `);
  const allApp = allModule.App as Component;
  target.innerHTML = await renderToStringAsync(allApp);
  expect(globalThis.integrationLoads).toBe(2);
  const allParagraph = target.querySelector("#all-result");
  const payload = deserializeGraph(
    target.querySelector<HTMLScriptElement>("script[data-sol-hydration]")!.textContent,
  ) as { async: { site: string }[] };
  expect(payload.async.map((entry) => entry.site)).toEqual([
    "await:Integration.tsx:0",
    "await:Integration.tsx:1",
  ]);
  const disposeAll = await hydrate(allApp, target);
  expect(globalThis.integrationLoads).toBe(2);
  expect(target.querySelector("#all-result")).toBe(allParagraph);
  expect(allParagraph?.textContent).toBe("one result:two result");
  disposeAll();
});

test("SSR preserves Await promise-like validation", async () => {
  const module = await loadCompiled(`
    import { Await } from "@soljs/sol";
    export const App = $component(function App() {
      const invalid = 123 as unknown as Promise<number>;
      return <Await $promise={invalid}>{value => <main>{value}</main>}</Await>;
    });
  `);
  await expectRejection(renderToStringAsync(module.App as Component), "promise-like");

  const callableModule = await loadCompiled(`
    import { Await } from "@soljs/sol";
    export const App = $component(function App() {
      const callable = Object.assign(() => {}, {
        then(resolve: (value: string) => unknown) {
          resolve("callable result");
        },
      }) as unknown as PromiseLike<string>;
      return <Await $promise={callable}>{value => <main>{value}</main>}</Await>;
    });
  `);
  expect(await renderToStringAsync(callableModule.App as Component)).toContain(">callable result<");
});

test("SSR and hydration preserve Await, Suspense, and ErrorBoundary failures", async () => {
  globalThis.integrationSetups.app = 0;
  const module = await loadCompiled(`
    import { Await, ErrorBoundary, Suspense } from "@soljs/sol";
    const SuspenseFailure = $component(async function SuspenseFailure() {
      await Promise.reject(new Error("suspense failed"));
      return <p>unexpected</p>;
    });
    export const App = $component(function App() {
      return <main>
        <Await $promise={(() => {
          globalThis.integrationSetups.app += 1;
          return Promise.reject(new Error("await failed"));
        })()} error={error => <p id="await-error">{String(error)}</p>}>
          {value => <p>{value}</p>}
        </Await>
        <Suspense fallback={<p>Loading</p>} error={error => <p id="suspense-error">{String(error)}</p>}>
          <SuspenseFailure />
        </Suspense>
        <ErrorBoundary fallback={error => <p id="sync-error">{String(error)}</p>}>
          {(() => { throw new Error("sync failed"); })()}
        </ErrorBoundary>
      </main>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, undefined, { timeoutMs: 100 });
  expect(target.querySelector("#await-error")?.textContent).toContain("await failed");
  expect(target.querySelector("#suspense-error")?.textContent).toContain("suspense failed");
  expect(target.querySelector("#sync-error")?.textContent).toContain("sync failed");
  expect(globalThis.integrationSetups.app).toBe(1);
  const awaitNode = target.querySelector("#await-error");
  const suspenseNode = target.querySelector("#suspense-error");
  const syncNode = target.querySelector("#sync-error");
  const dispose = await hydrate(App, target);
  expect(target.querySelector("#await-error")).toBe(awaitNode);
  expect(target.querySelector("#suspense-error")).toBe(suspenseNode);
  expect(target.querySelector("#sync-error")).toBe(syncNode);
  expect(globalThis.integrationSetups.app).toBe(1);
  dispose();
});

test("nested SSR Suspense owns its timeout while its parent resolves", async () => {
  globalThis.integrationPending = new Promise((resolve) => {
    globalThis.integrationResolve = resolve;
  });
  const module = await loadCompiled(`
    import { Suspense } from "@soljs/sol";
    const Pending = $component(async function Pending() {
      const value = await globalThis.integrationPending;
      return <p id="nested-ready">{value}</p>;
    });
    const Ready = $component(async function Ready() {
      const value = await Promise.resolve("sibling");
      return <p id="sibling">{value}</p>;
    });
    export const App = $component(function App() {
      return <Suspense fallback={<p id="outer-loading">Outer</p>} timeoutMs={100}>
        <Suspense fallback={<p id="inner-loading">Inner</p>} timeoutMs={0}><Pending /></Suspense>
        <Ready />
      </Suspense>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, undefined, { timeoutMs: 100 });
  expect(target.querySelector("#outer-loading")).toBeNull();
  expect(target.querySelector("#inner-loading")?.textContent).toBe("Inner");
  expect(target.querySelector("#sibling")?.textContent).toBe("sibling");
  const inner = target.querySelector("#inner-loading");
  const dispose = await hydrate(App, target);
  expect(target.querySelector("#inner-loading")).toBe(inner);
  globalThis.integrationResolve("nested");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(target.querySelector("#nested-ready")?.textContent).toBe("nested");
  dispose();
});

test("an outer Suspense timeout retires pending descendant boundaries", async () => {
  const module = await loadCompiled(`
    import { Suspense } from "@soljs/sol";
    const Pending = $component(async function Pending() {
      await new Promise(() => {});
      return <p>Never</p>;
    });
    export const App = $component(function App() {
      return <Suspense fallback={<p id="outer-retired">Outer fallback</p>} timeoutMs={0}>
        <Suspense fallback={<p>Inner fallback</p>} timeoutMs={100}><Pending /></Suspense>
        <Pending />
      </Suspense>;
    });
  `);
  const App = module.App as Component;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let html: string;
  try {
    html = await Promise.race([
      renderToStringAsync(App, undefined, { timeoutMs: 200 }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("descendant boundary was not retired")), 50);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
  const target = document.createElement("div");
  target.innerHTML = html;
  expect(target.querySelector("#outer-retired")?.textContent).toBe("Outer fallback");
  const payload = deserializeGraph(
    target.querySelector<HTMLScriptElement>("script[data-sol-hydration]")!.textContent,
  ) as { boundaries: string[] };
  expect(payload.boundaries).toEqual(["timeout", "timeout"]);
});

test("keeps late settlements from timed-out boundaries uncaptured", async () => {
  globalThis.integrationLoad = (id) => {
    globalThis.integrationLoads += 1;
    const delay = id === "resolved" ? 1 : id === "late" ? 30 : 50;
    return new Promise((resolve) => setTimeout(() => resolve(`${id} result`), delay));
  };
  const module = await loadCompiled(`
    import { Suspense } from "@soljs/sol";
    const Child = $component(async function Child(props: { id: string }) {
      const value = await globalThis.integrationLoad(props.id);
      return <p data-id={props.id}>{String(value)}</p>;
    });
    export const App = $component(function App() {
      return <main>
        <Suspense fallback={<p id="late-fallback">Late fallback</p>} timeoutMs={15}>
          <Child id="resolved" />
          <Child id="late" />
        </Suspense>
        <Suspense fallback={<p>Slow fallback</p>} timeoutMs={100}>
          <Child id="blocker" />
        </Suspense>
      </main>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, undefined, { timeoutMs: 120 });
  expect(globalThis.integrationLoads).toBe(3);
  const payload = deserializeGraph(
    target.querySelector<HTMLScriptElement>("script[data-sol-hydration]")!.textContent,
  ) as { async: { status: string }[] };
  expect(payload.async.map((entry) => entry.status)).toEqual(["fulfilled", "pending", "fulfilled"]);
  const fallback = target.querySelector("#late-fallback");

  const dispose = await hydrate(App, target);
  expect(globalThis.integrationLoads).toBe(4);
  expect(target.querySelector("#late-fallback")).toBe(fallback);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(target.querySelector('[data-id="late"]')?.textContent).toBe("late result");
  dispose();
});

test("a timed-out outer boundary resumes nested boundary payloads", async () => {
  globalThis.integrationPending = new Promise((resolve) => {
    globalThis.integrationResolve = resolve;
  });
  const module = await loadCompiled(`
    import { Suspense } from "@soljs/sol";
    const Ready = $component(async function Ready() {
      const value = await Promise.resolve("nested ready");
      return <p id="nested-resume-ready">{value}</p>;
    });
    const Pending = $component(async function Pending() {
      const value = await globalThis.integrationPending;
      return <p id="outer-resume-ready">{value}</p>;
    });
    export const App = $component(function App() {
      return <Suspense fallback={<p id="outer-resume-fallback">Outer fallback</p>} timeoutMs={0}>
        <Suspense fallback={<p>Nested fallback</p>}><Ready /></Suspense>
        <Pending />
      </Suspense>;
    });
  `);
  const App = module.App as Component;
  const target = document.createElement("div");
  target.innerHTML = await renderToStringAsync(App, undefined, { timeoutMs: 20 });
  const fallback = target.querySelector("#outer-resume-fallback");
  const dispose = await hydrate(App, target);
  expect(target.querySelector("#outer-resume-fallback")).toBe(fallback);
  globalThis.integrationResolve("outer ready");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(target.querySelector("#nested-resume-ready")?.textContent).toBe("nested ready");
  expect(target.querySelector("#outer-resume-ready")?.textContent).toBe("outer ready");
  dispose();
});
