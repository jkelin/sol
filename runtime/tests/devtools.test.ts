// oxlint-disable eslint/no-underscore-dangle -- exercises the documented __sol global.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  DEVTOOLS_HOOK,
  devtoolsComponentPropsUpdated,
  type DevtoolsHook,
} from "../src/devtools-hook.ts";
import { installDevtools } from "../src/devtools.ts";
import { awaitBlock } from "../src/async.ts";
import { formInFrame } from "../src/forms.ts";
import { $signal, disposeOwner, reactive, runtimeEffect } from "../src/reactivity.ts";
import {
  block,
  blockLifecycle,
  component,
  mount,
  rootFrame,
  type Block,
} from "../src/rendering.ts";

declare global {
  var __sol: import("../src/devtools.ts").SolDevtools | undefined;
}

let window: Window;
let registeredTools: Array<{ name: string; execute(input: Record<string, unknown>): unknown }>;

function modelContext() {
  return {
    registerTool(tool: { name: string; execute(input: Record<string, unknown>): unknown }) {
      registeredTools.push(tool);
    },
  };
}

beforeEach(() => {
  window = new Window({ url: "https://example.test/projects/42?view=active" });
  registeredTools = [];
  Object.defineProperty(window.document, "modelContext", {
    configurable: true,
    value: modelContext(),
  });
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
  });
  delete globalThis.__sol;
  delete (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK];
});

afterEach(() => {
  delete globalThis.__sol;
  delete (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK];
  window.close();
});

test("installs the development global, panel, and WebMCP tools", () => {
  const api = installDevtools();

  expect(api).toBe(globalThis.__sol);
  expect(api?.version).toBe("0.1");
  expect(document.querySelector("sol-devtools")?.shadowRoot).not.toBeNull();
  expect(registeredTools.map((tool) => tool.name)).toEqual([
    "sol_get_diagnostics",
    "sol_inspect_element",
  ]);
});

test("disposes forms created after async component setup resumes", async () => {
  const api = installDevtools()!;
  const AsyncForm = component(async (_props, frame) => {
    await Promise.resolve();
    formInFrame(
      frame,
      {
        schema: (values: { title: string }) => values,
        defaultValues: { title: "draft" },
      },
      () => {},
    );
    return block(document.createDocumentFragment());
  });
  const dispose = mount(AsyncForm, document.createElement("main"));

  await Promise.resolve();
  await Promise.resolve();
  expect(api.forms).toHaveLength(1);

  dispose();
  expect(api.forms).toHaveLength(0);

  const owner: Array<() => void> = [];
  const disposedFrame = { ...rootFrame(), owner };
  disposeOwner(owner);
  expect(() =>
    formInFrame(
      disposedFrame,
      {
        schema: (values: { title: string }) => values,
        defaultValues: { title: "late" },
      },
      () => {},
    ),
  ).toThrow("owner has been disposed");
  expect(api.forms).toHaveLength(0);
});

test("toggles the panel from the launcher and restores its persisted layout", () => {
  window.localStorage.setItem(
    "sol.devtools.layout",
    JSON.stringify({ left: 24, top: 32, width: 720, height: 480, listWidth: 260 }),
  );
  installDevtools();
  const root = document.querySelector("sol-devtools")!.shadowRoot!;
  const launcher = root.querySelector<HTMLButtonElement>(".launcher")!;
  const panel = root.querySelector<HTMLElement>(".panel")!;

  expect(panel.style.left).toBe("24px");
  expect(panel.style.top).toBe("32px");
  expect(panel.style.width).toBe("720px");
  expect(panel.style.getPropertyValue("--list-width")).toBe("260px");
  launcher.click();
  expect(panel.hidden).toBeFalse();
  expect(launcher.getAttribute("aria-label")).toBe("Close Sol devtools");
  launcher.click();
  expect(panel.hidden).toBeTrue();
  expect(launcher.getAttribute("aria-label")).toBe("Open Sol devtools");
});

test("clamps moved panel geometry inside the viewport after resizing", () => {
  installDevtools();
  const root = document.querySelector("sol-devtools")!.shadowRoot!;
  const panel = root.querySelector<HTMLElement>(".panel")!;
  Object.defineProperty(panel, "getBoundingClientRect", {
    value: () => ({ left: 900, top: 700, right: 1620, bottom: 1180, width: 720, height: 480 }),
  });

  panel.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

  expect(panel.style.left).toBe(`${window.innerWidth - 728}px`);
  expect(panel.style.top).toBe(`${window.innerHeight - 488}px`);
  const stored = JSON.parse(window.localStorage.getItem("sol.devtools.layout")!);
  expect(stored).toMatchObject({
    left: window.innerWidth - 728,
    top: window.innerHeight - 488,
    width: 720,
    height: 480,
  });
});

test("falls back to the legacy navigator WebMCP surface", () => {
  delete (document as { modelContext?: unknown }).modelContext;
  Object.defineProperty(navigator, "modelContext", {
    configurable: true,
    value: modelContext(),
  });

  installDevtools();

  expect(registeredTools.map((tool) => tool.name)).toEqual([
    "sol_get_diagnostics",
    "sol_inspect_element",
  ]);
});

test("publishes component, request, router, and form diagnostics through one snapshot", () => {
  const api = installDevtools()!;
  const hook = (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK]!;
  const element = document.createElement("button");
  element.id = "save";
  document.body.append(element);

  const componentId = hook.componentCreated(
    { name: "SaveButton", file: "/src/SaveButton.tsx", line: 7 },
    { label: "Save" },
  );
  const childId = hook.componentCreated(
    { name: "SaveIcon", file: "/src/SaveIcon.tsx", line: 3 },
    {},
    componentId,
  );
  hook.componentRendered(componentId, () => [element]);
  const queryId = hook.queryCreated('["project",42]', [42], {
    file: "/src/SaveButton.tsx",
    line: 9,
    column: 16,
  });
  hook.queryUpdated(queryId, { hasData: true, data: { id: 42 }, isFetching: false });
  const mutationId = hook.mutationCreated({ file: "/src/SaveButton.tsx", line: 14, column: 18 });
  hook.mutationUpdated(mutationId, { hasData: true, data: { saved: true } });
  const loaderId = hook.loaderCreated("ProjectPage setup", [{ id: 42 }]);
  hook.loaderUpdated(loaderId, { hasData: true, data: { nodes: 3 }, isLoading: false });
  const formId = hook.formCreated("onBlur", {
    values: { title: "Draft" },
    errors: { title: ["Too short"] },
    formErrors: [],
    isSubmitting: false,
  });
  hook.routerUpdated({ pathname: "/projects/42", status: "ready", params: { id: 42 } });

  expect(api.inspectElement("#save")?.name).toBe("SaveButton");
  expect(api.components[0]?.elements).toContain("button#save");
  expect(api.components[1]).toMatchObject({ id: childId, parentId: componentId });
  expect(api.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "query",
        status: "success",
        source: { file: "/src/SaveButton.tsx", line: 9, column: 16 },
      }),
      expect.objectContaining({
        kind: "mutation",
        source: { file: "/src/SaveButton.tsx", line: 14, column: 18 },
      }),
      expect.objectContaining({ kind: "loader", status: "success" }),
    ]),
  );
  expect(api.forms[0]).toMatchObject({ id: formId, strategy: "onBlur" });
  expect(api.router).toMatchObject({ pathname: "/projects/42", status: "ready" });
  expect(registeredTools[0]!.execute({ area: "components" })).toEqual(api.components);
});

test("renders mounted components as a collapsible ownership tree", () => {
  const api = installDevtools()!;
  const hook = (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK]!;
  const element = document.createElement("section");
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({ left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 }),
  });
  document.body.append(element);
  const parentId = hook.componentCreated({ name: "Parent", file: "Parent.tsx", line: 1 }, {});
  hook.componentRendered(parentId, () => [element]);
  hook.componentCreated({ name: "Child", file: "Child.tsx", line: 2 }, {}, parentId);
  api.open("components");
  const root = document.querySelector("sol-devtools")!.shadowRoot!;

  expect(root.querySelector("header nav")).not.toBeNull();
  expect(root.querySelector("header")?.textContent).not.toContain("RUNTIME FIELD UNIT");
  expect(root.querySelector(".tree-id")).toBeNull();
  expect(root.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
  expect(root.querySelector('[role="tree"]')?.getAttribute("aria-label")).toBe(
    "Mounted component tree",
  );
  const parent = root.querySelector<HTMLButtonElement>('.tree-node[title="Parent.tsx:1"]')!;
  parent.dispatchEvent(new MouseEvent("mouseenter"));
  const highlight = document.querySelector<HTMLElement>("[data-sol-highlight]");
  expect(highlight?.style.left).toBe("10px");
  expect(highlight?.style.top).toBe("20px");
  expect(highlight?.style.width).toBe("100px");
  expect(highlight?.style.height).toBe("50px");
  parent.dispatchEvent(new MouseEvent("mouseleave"));
  expect(document.querySelector("[data-sol-highlight]")).toBeNull();
  root.querySelector<HTMLButtonElement>('.tree-toggle[aria-label="Toggle Parent"]')!.click();
  expect(root.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
});

test("keeps component ownership live when rendered root nodes change", () => {
  const api = installDevtools()!;
  const hook = (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK]!;
  const first = document.createElement("section");
  first.id = "first";
  const second = document.createElement("article");
  second.id = "second";
  Object.defineProperty(second, "getBoundingClientRect", {
    value: () => ({ left: 20, top: 30, right: 140, bottom: 90, width: 120, height: 60 }),
  });
  document.body.append(first, second);
  let nodes: readonly Node[] = [first];
  const id = hook.componentCreated({ name: "SwitchingRoot", file: "Switch.tsx", line: 1 }, {});
  hook.componentRendered(id, () => nodes);

  expect(api.inspectElement(first)?.id).toBe(id);
  nodes = [second];
  expect(api.inspectElement(first)).toBeNull();
  expect(api.inspectElement(second)?.id).toBe(id);
  expect(api.components[0]?.elements).toEqual(["article#second"]);

  api.open("components");
  const root = document.querySelector("sol-devtools")!.shadowRoot!;
  root
    .querySelector<HTMLButtonElement>('.tree-node[title="Switch.tsx:1"]')!
    .dispatchEvent(new MouseEvent("mouseenter"));
  const highlight = document.querySelector<HTMLElement>("[data-sol-highlight]");
  expect(highlight?.style.left).toBe("20px");
  expect(highlight?.style.width).toBe("120px");
});

test("renders requests and routes as selectable master-detail views", () => {
  const api = installDevtools()!;
  const hook = (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK]!;
  const queryId = hook.queryCreated("notes", [], {
    file: "queries.sol.tsx",
    line: 12,
    column: 5,
  });
  hook.queryUpdated(queryId, { hasData: true, data: { page: 1 }, isFetching: false });
  hook.mutationCreated({ file: "queries.sol.tsx", line: 18, column: 5 });
  api.open("requests");
  const root = document.querySelector("sol-devtools")!.shadowRoot!;

  expect(root.querySelector(".request-explorer .splitter")).not.toBeNull();
  expect(root.querySelectorAll(".request-explorer .record")).toHaveLength(2);
  root.querySelector<HTMLButtonElement>(".request-explorer .record:last-child")!.click();
  expect(root.querySelector(".request-detail-pane")?.textContent).toContain("queries.sol.tsx:12:5");
  expect(root.querySelector(".request-detail-pane")?.textContent).toContain('"page": 1');

  hook.routerUpdated({
    pathname: "/notes",
    route: { path: "/notes" },
    status: "ready",
    routes: [
      { path: "/", pattern: "^/$" },
      { path: "/notes", pattern: "^/notes$" },
    ],
  });
  api.open("router");
  expect(root.querySelector(".router-explorer .splitter")).not.toBeNull();
  expect(root.querySelectorAll(".route-record")).toHaveLength(2);
  expect(root.querySelector(".route-record:not(.selected) .route-matcher")?.textContent).toBe(
    "^/$",
  );
  expect(root.querySelector("style")?.textContent).toContain(
    ".route-matcher { min-width:0; overflow:hidden; text-align:right;",
  );
  expect(root.querySelector(".route-active")?.textContent).toBe("ACTIVE");
  expect(root.querySelector(".router-detail-pane")?.textContent).toContain("ACTIVE LOCATION");
});

test("validates public and WebMCP inputs", () => {
  const api = installDevtools()!;

  expect(() => api.getSnapshot("invalid" as "router")).toThrow("valid area");
  expect(() => api.subscribe(null as unknown as () => void)).toThrow("expects a function");
  expect(() => registeredTools[1]!.execute({ selector: "" })).toThrow("non-empty string");
  expect(() => registeredTools[0]!.execute({ extra: true })).toThrow("Unexpected WebMCP");
});

test("renders newlines and tabs inside props without changing the diagnostic snapshot", () => {
  const api = installDevtools()!;
  const hook = (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK]!;
  const description = "first line\n\tsecond line";
  hook.componentCreated({ name: "Multiline", file: "Multiline.tsx", line: 1 }, { description });
  api.open("components");
  const root = document.querySelector("sol-devtools")!.shadowRoot!;
  const rendered = root.querySelector("pre")!.textContent!;

  expect(rendered).toContain('"description": "first line\n  \tsecond line"');
  expect(rendered).not.toContain("first line\\n\\tsecond line");
  expect(api.components[0]?.props).toEqual({ description });
});

test("preserves router errors and hides the panel while picking", () => {
  const api = installDevtools()!;
  const hook = (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK]!;
  const host = document.querySelector("sol-devtools")!;
  const panel = host.shadowRoot!.querySelector<HTMLElement>(".panel")!;

  hook.routerUpdated({ pathname: "/broken", status: "error", error: new Error("Bad route") });
  api.open("router");
  api.startElementPicker();

  expect(api.router.error).toEqual({ name: "Error", message: "Bad route" });
  expect(panel.hidden).toBeTrue();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(panel.hidden).toBeFalse();
});

test("takes reactive prop snapshots outside the active dependency tracker", async () => {
  installDevtools();
  const hook = (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK]!;
  const source = $signal("first");
  const props = reactive({ value: "" });
  hook.componentCreated({ name: "Child", file: "Child.tsx", line: 1 }, props);
  let runs = 0;
  const dispose = runtimeEffect(() => {
    runs += 1;
    props.value = source.value;
    devtoolsComponentPropsUpdated(props);
  });

  await Promise.resolve();
  source.value = "second";
  await Promise.resolve();

  expect(runs).toBe(2);
  dispose();
});

test("removes cancelled async components and records their loader", async () => {
  const api = installDevtools()!;
  let resolve!: (value: Block) => void;
  const pending = new Promise<Block>((done) => {
    resolve = done;
  });
  const AsyncPanel = component(async () => pending, {
    name: "AsyncPanel",
    file: "AsyncPanel.tsx",
    line: 1,
  });
  const dispose = mount(AsyncPanel, document.createElement("main"));

  expect(api.components).toEqual([
    expect.objectContaining({ name: "AsyncPanel", file: "AsyncPanel.tsx" }),
  ]);
  expect(api.requests).toEqual([
    expect.objectContaining({ kind: "loader", key: "AsyncPanel setup", status: "pending" }),
  ]);

  dispose();
  expect(api.components).toEqual([]);
  expect(api.requests).toEqual([expect.objectContaining({ kind: "loader", status: "cancelled" })]);

  resolve(block(document.createDocumentFragment()));
  await Promise.resolve();
  await Promise.resolve();
  expect(api.components).toEqual([]);
});

test("diagnoses Await replacement, success, and disposal", async () => {
  const api = installDevtools()!;
  let resolveSecond!: (value: string) => void;
  const first = new Promise<string>(() => undefined);
  const second = new Promise<string>((resolve) => {
    resolveSecond = resolve;
  });
  const third = new Promise<string>(() => undefined);
  const source = $signal<Promise<string>>(first);
  const parent = document.createElement("main");
  const start = document.createComment("await:start");
  const end = document.createComment("await:end");
  parent.append(start, end);
  const cleanups: Array<() => void> = [];
  const lifecycle = blockLifecycle();
  awaitBlock(
    { start, end },
    () => source.value,
    (value) => {
      const fragment = document.createDocumentFragment();
      fragment.append(value);
      return block(fragment);
    },
    undefined,
    cleanups,
    { owner: cleanups, contexts: new Map(), mounts: lifecycle.coordinator },
    "project-data",
  );

  expect(api.requests.at(-1)).toMatchObject({
    kind: "loader",
    key: "Await project-data",
    status: "pending",
  });
  source.value = second;
  await Promise.resolve();
  expect(api.requests.slice(-2)).toEqual([
    expect.objectContaining({ status: "cancelled" }),
    expect.objectContaining({ status: "pending" }),
  ]);

  resolveSecond("ready");
  await Promise.resolve();
  await Promise.resolve();
  expect(api.requests.at(-1)).toMatchObject({ status: "success", data: "ready" });

  source.value = third;
  await Promise.resolve();
  for (const cleanup of cleanups.toReversed()) cleanup();
  expect(api.requests.at(-1)).toMatchObject({ status: "cancelled" });
});
