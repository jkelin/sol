// oxlint-disable eslint/no-underscore-dangle -- __solix is the documented development global.
import {
  DEVTOOLS_HOOK,
  type ComponentMetadata,
  type DevtoolsArea,
  type DevtoolsHook,
  type SourceMetadata,
} from "./devtools-hook.ts";

type Status = "idle" | "pending" | "success" | "error" | "cancelled";

export interface SolixComponentSnapshot extends ComponentMetadata {
  readonly id: number;
  readonly parentId?: number;
  readonly props: unknown;
  readonly elements: readonly string[];
}

export interface SolixRequestSnapshot {
  readonly id: number;
  readonly kind: "loader" | "query" | "mutation";
  readonly key?: string;
  readonly name?: string;
  readonly status: Status;
  readonly args?: unknown;
  readonly data?: unknown;
  readonly error?: unknown;
  readonly duration?: number;
  readonly source?: SourceMetadata;
}

export interface SolixFormSnapshot {
  readonly id: number;
  readonly strategy: string;
  readonly values: unknown;
  readonly errors: unknown;
  readonly formErrors: unknown;
  readonly isSubmitting: boolean;
}

export interface SolixSnapshot {
  readonly components: readonly SolixComponentSnapshot[];
  readonly requests: readonly SolixRequestSnapshot[];
  readonly router: Readonly<Record<string, unknown>>;
  readonly forms: readonly SolixFormSnapshot[];
}

export interface SolixDevtools {
  readonly version: "0.1";
  readonly components: readonly SolixComponentSnapshot[];
  readonly requests: readonly SolixRequestSnapshot[];
  readonly router: Readonly<Record<string, unknown>>;
  readonly forms: readonly SolixFormSnapshot[];
  getSnapshot(area?: DevtoolsArea): SolixSnapshot | SolixSnapshot[DevtoolsArea];
  inspectElement(target: Element | string): SolixComponentSnapshot | null;
  open(tab?: DevtoolsArea): void;
  close(): void;
  startElementPicker(): void;
  subscribe(listener: () => void): () => void;
}

interface WebMcpContext {
  registerTool(
    tool: {
      name: string;
      description: string;
      annotations?: { readOnlyHint?: boolean };
      inputSchema?: Record<string, unknown>;
      execute(input: Record<string, unknown>): unknown;
    },
    options?: { signal?: AbortSignal },
  ): void;
}

declare global {
  var __solix: SolixDevtools | undefined;

  interface Document {
    readonly modelContext?: WebMcpContext;
  }

  interface Navigator {
    readonly modelContext?: WebMcpContext;
  }
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type ComponentRecord = Mutable<SolixComponentSnapshot> & {
  getNodes: () => readonly Node[];
  rawProps: object;
};
type RequestRecord = Mutable<SolixRequestSnapshot> & { startedAt?: number };
type PanelLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
  listWidth: number;
};

const areas: readonly DevtoolsArea[] = ["components", "requests", "router", "forms"];

function isArea(value: unknown): value is DevtoolsArea {
  return typeof value === "string" && areas.includes(value as DevtoolsArea);
}

function errorValue(error: unknown): unknown {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return snapshotValue(error);
}

function snapshotValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (depth >= 4) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => snapshotValue(item, seen, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 50)) {
    try {
      output[key] = snapshotValue((value as Record<string, unknown>)[key], seen, depth + 1);
    } catch (error) {
      output[key] = `[unavailable: ${String(error)}]`;
    }
  }
  return output;
}

function elementLabel(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  const classes = [...element.classList]
    .slice(0, 2)
    .map((name) => `.${name}`)
    .join("");
  return `${element.localName}${id}${classes}`;
}

function componentElements(nodes: readonly Node[]): string[] {
  return nodes.flatMap((node) =>
    node instanceof Element
      ? [elementLabel(node), ...[...node.querySelectorAll("*")].map(elementLabel)]
      : [],
  );
}

function createText<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string,
  value: string,
): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function displayString(value: string, indentation: number): string {
  const continuation = " ".repeat(indentation);
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let output = '"';
  for (const character of normalized) {
    if (character === "\n") output += `\n${continuation}`;
    else if (character === "\t") output += "\t";
    else output += JSON.stringify(character).slice(1, -1);
  }
  return `${output}"`;
}

function displayValue(value: unknown, indentation = 0): string {
  if (typeof value === "string") return displayString(value, indentation);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const nested = indentation + 2;
    const entries = value.map((item) => `${" ".repeat(nested)}${displayValue(item, nested)}`);
    return `[\n${entries.join(",\n")}\n${" ".repeat(indentation)}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const nested = indentation + 2;
    const properties = entries.map(
      ([key, item]) => `${" ".repeat(nested)}${JSON.stringify(key)}: ${displayValue(item, nested)}`,
    );
    return `{\n${properties.join(",\n")}\n${" ".repeat(indentation)}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

class DevtoolsRegistry implements DevtoolsHook {
  readonly components = new Map<number, ComponentRecord>();
  readonly requests = new Map<number, RequestRecord>();
  readonly forms = new Map<number, SolixFormSnapshot>();
  router: Record<string, unknown> = {};
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    if (typeof listener !== "function")
      throw new TypeError("__solix.subscribe() expects a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  componentCreated(metadata: ComponentMetadata, props: object, parentId?: number): number {
    const id = this.nextId++;
    this.components.set(id, {
      ...metadata,
      id,
      parentId,
      props: snapshotValue(props),
      rawProps: props,
      elements: [],
      getNodes: () => [],
    });
    this.changed();
    return id;
  }

  componentRendered(id: number, getNodes: () => readonly Node[]): void {
    const record = this.components.get(id);
    if (!record) return;
    record.getNodes = getNodes;
    record.elements = componentElements(getNodes());
    this.changed();
  }

  componentUpdated(id: number, props: object): void {
    const record = id
      ? this.components.get(id)
      : [...this.components.values()].find((candidate) => candidate.rawProps === props);
    if (!record) return;
    record.props = snapshotValue(props);
    this.changed();
  }

  componentDisposed(id: number): void {
    if (this.components.delete(id)) this.changed();
  }

  loaderCreated(key: string, args: readonly unknown[]): number {
    const id = this.nextId++;
    this.requests.set(id, {
      id,
      kind: "loader",
      key,
      args: snapshotValue(args),
      status: "idle",
    });
    this.pruneRequests();
    this.changed();
    return id;
  }

  loaderUpdated(id: number, state: Record<string, unknown>): void {
    this.updateRequest(
      id,
      state,
      Boolean(state.isLoading),
      Boolean(state.isFailed),
      Boolean(state.isCancelled),
    );
  }

  queryCreated(
    key: string,
    args: readonly unknown[],
    source?: SourceMetadata,
    name?: string,
  ): number {
    const id = this.nextId++;
    this.requests.set(id, {
      id,
      kind: "query",
      key,
      name,
      args: snapshotValue(args),
      status: "idle",
      source,
    });
    this.pruneRequests();
    this.changed();
    return id;
  }

  queryUpdated(id: number, state: Record<string, unknown>): void {
    this.updateRequest(id, state, Boolean(state.isFetching), Boolean(state.isFailed));
  }

  queryDisposed(id: number): void {
    if (this.requests.delete(id)) this.changed();
  }

  mutationCreated(source?: SourceMetadata, name?: string): number {
    const id = this.nextId++;
    this.requests.set(id, { id, kind: "mutation", name, status: "idle", source });
    this.pruneRequests();
    this.changed();
    return id;
  }

  mutationUpdated(id: number, state: Record<string, unknown>): void {
    this.updateRequest(id, state, Boolean(state.isMutating), Boolean(state.isFailed));
  }

  mutationDisposed(id: number): void {
    if (this.requests.delete(id)) this.changed();
  }

  private updateRequest(
    id: number,
    state: Record<string, unknown>,
    pending: boolean,
    failed: boolean,
    cancelled = false,
  ): void {
    const record = this.requests.get(id);
    if (!record) return;
    if (pending && record.status !== "pending") record.startedAt = performance.now();
    if (!pending && record.startedAt !== undefined) {
      record.duration = Math.round((performance.now() - record.startedAt) * 10) / 10;
      record.startedAt = undefined;
    }
    record.status = cancelled
      ? "cancelled"
      : pending
        ? "pending"
        : failed
          ? "error"
          : state.hasData
            ? "success"
            : "idle";
    record.args = snapshotValue(state.args ?? record.args);
    record.data = snapshotValue(state.data);
    record.error = errorValue(state.error);
    this.changed();
  }

  private pruneRequests(): void {
    while (this.requests.size > 100) this.requests.delete(this.requests.keys().next().value!);
  }

  formCreated(strategy: string, state: Record<string, unknown>): number {
    const id = this.nextId++;
    this.forms.set(id, this.formSnapshot(id, strategy, state));
    this.changed();
    return id;
  }

  formUpdated(id: number, state: Record<string, unknown>): void {
    const previous = this.forms.get(id);
    if (!previous) return;
    this.forms.set(id, this.formSnapshot(id, previous.strategy, state));
    this.changed();
  }

  formDisposed(id: number): void {
    if (this.forms.delete(id)) this.changed();
  }

  private formSnapshot(
    id: number,
    strategy: string,
    state: Record<string, unknown>,
  ): SolixFormSnapshot {
    return {
      id,
      strategy,
      values: snapshotValue(state.values),
      errors: snapshotValue(state.errors),
      formErrors: snapshotValue(state.formErrors),
      isSubmitting: Boolean(state.isSubmitting),
    };
  }

  routerUpdated(state: Record<string, unknown>): void {
    const snapshot = snapshotValue(state) as Record<string, unknown>;
    if ("error" in state) snapshot.error = errorValue(state.error);
    this.router = snapshot;
    this.changed();
  }

  snapshot(): SolixSnapshot {
    return {
      components: [...this.components.values()].map((record) => this.componentSnapshot(record)),
      requests: [...this.requests.values()].map(({ startedAt: _startedAt, ...item }) => item),
      router: { ...this.router },
      forms: [...this.forms.values()],
    };
  }

  inspect(target: Element): SolixComponentSnapshot | null {
    const candidates = [...this.components.values()].filter((record) =>
      record
        .getNodes()
        .some((node) => node === target || (node instanceof Element && node.contains(target))),
    );
    const record = candidates.at(-1);
    if (!record) return null;
    return this.componentSnapshot(record);
  }

  private componentSnapshot(record: ComponentRecord): SolixComponentSnapshot {
    const { getNodes, rawProps: _props, elements: _elements, ...snapshot } = record;
    return { ...snapshot, elements: componentElements(getNodes()) };
  }
}

class DevtoolsPanel {
  private readonly host: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs = new Map<DevtoolsArea, HTMLButtonElement>();
  private active: DevtoolsArea = "components";
  private selectedComponent?: number;
  private selectedRequest?: number;
  private selectedRoute?: string;
  private readonly collapsedComponents = new Set<number>();
  private componentHighlight?: HTMLElement;
  private pickerCleanup?: () => void;

  constructor(private readonly registry: DevtoolsRegistry) {
    this.host = document.createElement("solix-devtools");
    this.host.dataset.solixDevtools = "";
    const root = this.host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${styles}</style>`;
    const launcher = createText("button", "launcher", "S");
    launcher.setAttribute("aria-label", "Open Solix devtools");
    launcher.addEventListener("click", () => (this.panel.hidden ? this.open() : this.close()));
    this.panel = document.createElement("section");
    this.panel.className = "panel";
    this.panel.id = "solix-devtools-panel";
    this.panel.hidden = true;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Solix developer tools");
    launcher.setAttribute("aria-controls", this.panel.id);
    launcher.setAttribute("aria-expanded", "false");
    this.panel.innerHTML = `<header><div class="brand"><span class="pulse"></span><strong>SOLIX</strong></div><div class="actions"></div></header>`;
    const header = this.panel.querySelector("header")!;
    header.addEventListener("mousedown", (event) => this.startPanelDrag(event));
    const actions = this.panel.querySelector(".actions")!;
    const picker = createText("button", "tool", "⌖ Pick");
    picker.addEventListener("click", () => this.startPicker());
    const close = createText("button", "tool close", "×");
    close.setAttribute("aria-label", "Close Solix devtools");
    close.addEventListener("click", () => this.close());
    actions.append(picker, close);
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "Devtools areas");
    nav.setAttribute("role", "tablist");
    for (const area of areas) {
      const button = createText("button", "tab", area);
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => this.open(area));
      this.tabs.set(area, button);
      nav.append(button);
    }
    header.insertBefore(nav, actions);
    this.body = document.createElement("main");
    this.body.setAttribute("role", "tabpanel");
    this.panel.append(this.body);
    root.append(this.panel, launcher);
    document.documentElement.append(this.host);
    this.restorePanelLayout();
    this.panel.addEventListener("mouseup", () => this.savePanelLayout());
    this.registry.subscribe(() => {
      launcher.classList.toggle(
        "busy",
        [...registry.requests.values()].some((item) => item.status === "pending"),
      );
      if (!this.panel.hidden) this.render();
    });
  }

  open(area: DevtoolsArea = this.active): void {
    if (!isArea(area)) throw new TypeError("__solix.open() expects a valid devtools tab");
    this.active = area;
    this.panel.hidden = false;
    const launcher = this.host.shadowRoot?.querySelector(".launcher");
    launcher?.setAttribute("aria-expanded", "true");
    launcher?.setAttribute("aria-label", "Close Solix devtools");
    this.render();
  }

  close(): void {
    this.clearComponentHighlight();
    this.panel.hidden = true;
    const launcher = this.host.shadowRoot?.querySelector(".launcher");
    launcher?.setAttribute("aria-expanded", "false");
    launcher?.setAttribute("aria-label", "Open Solix devtools");
  }

  private render(): void {
    this.clearComponentHighlight();
    for (const [area, button] of this.tabs)
      button.setAttribute("aria-selected", String(area === this.active));
    this.body.replaceChildren();
    const snapshot = this.registry.snapshot();
    if (this.active === "components") this.renderComponents(snapshot.components);
    else if (this.active === "requests") this.renderRequests(snapshot.requests);
    else if (this.active === "router") this.renderRouter(snapshot.router);
    else this.renderForms(snapshot.forms);
  }

  private empty(message: string): void {
    this.body.append(createText("p", "empty", message));
  }

  private renderComponents(items: readonly SolixComponentSnapshot[]): void {
    if (items.length === 0) return this.empty("No mounted components observed yet.");
    const ids = new Set(items.map((component) => component.id));
    if (!this.selectedComponent || !ids.has(this.selectedComponent)) {
      this.selectedComponent = items[0]!.id;
    }
    const children = new Map<number | undefined, SolixComponentSnapshot[]>();
    for (const component of items) {
      const parent =
        component.parentId && ids.has(component.parentId) ? component.parentId : undefined;
      const siblings = children.get(parent) ?? [];
      siblings.push(component);
      children.set(parent, siblings);
    }

    const explorer = document.createElement("div");
    explorer.className = "split-view component-explorer";
    const tree = document.createElement("div");
    tree.className = "component-tree";
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", "Mounted component tree");
    const renderBranch = (component: SolixComponentSnapshot, depth: number): void => {
      const descendants = children.get(component.id) ?? [];
      const branch = document.createElement("div");
      branch.className = "tree-branch";
      branch.setAttribute("role", "treeitem");
      branch.setAttribute("aria-level", String(depth + 1));
      if (descendants.length > 0) {
        branch.setAttribute("aria-expanded", String(!this.collapsedComponents.has(component.id)));
      }
      const row = document.createElement("div");
      row.className = "tree-row";
      row.style.setProperty("--tree-depth", String(depth));
      const toggle = createText(
        "button",
        `tree-toggle${descendants.length === 0 ? " leaf" : ""}`,
        this.collapsedComponents.has(component.id) ? "▸" : "▾",
      );
      toggle.setAttribute(
        "aria-label",
        `${descendants.length ? "Toggle" : "Leaf"} ${component.name}`,
      );
      toggle.disabled = descendants.length === 0;
      toggle.addEventListener("click", () => {
        if (this.collapsedComponents.has(component.id))
          this.collapsedComponents.delete(component.id);
        else this.collapsedComponents.add(component.id);
        this.render();
      });
      const select = createText("button", "tree-node", component.name);
      select.classList.toggle("selected", component.id === this.selectedComponent);
      select.setAttribute("aria-current", String(component.id === this.selectedComponent));
      select.title = `${component.file}:${component.line}`;
      select.addEventListener("click", () => {
        this.selectedComponent = component.id;
        this.render();
      });
      select.addEventListener("mouseenter", () => this.highlightComponent(component.id));
      select.addEventListener("mouseleave", () => this.clearComponentHighlight());
      select.addEventListener("focus", () => this.highlightComponent(component.id));
      select.addEventListener("blur", () => this.clearComponentHighlight());
      row.append(toggle, select);
      branch.append(row);
      tree.append(branch);
      if (!this.collapsedComponents.has(component.id)) {
        for (const child of descendants) renderBranch(child, depth + 1);
      }
    };
    for (const root of children.get(undefined) ?? []) renderBranch(root, 0);

    const detail = document.createElement("aside");
    detail.className = "component-detail-pane";
    const selected = items.find((component) => component.id === this.selectedComponent)!;
    const heading = document.createElement("div");
    heading.className = "detail-heading";
    heading.append(
      createText("strong", "detail-title", selected.name),
      createText("small", "detail-source", `${selected.file}:${selected.line}`),
      createText("span", "detail-count", `${selected.elements.length} elements`),
    );
    detail.append(heading, this.objectView("PROPS", selected.props));
    if (selected.elements.length > 0) detail.append(this.objectView("ELEMENTS", selected.elements));
    explorer.append(tree, this.createSplitter(explorer), detail);
    this.body.append(explorer);
  }

  private renderRequests(items: readonly SolixRequestSnapshot[]): void {
    if (items.length === 0) return this.empty("No loaders, queries, or mutations observed yet.");
    const ordered = items.toReversed();
    const ids = new Set(ordered.map((request) => request.id));
    if (!this.selectedRequest || !ids.has(this.selectedRequest)) {
      this.selectedRequest = ordered[0]!.id;
    }
    const explorer = document.createElement("div");
    explorer.className = "split-view request-explorer";
    const list = document.createElement("div");
    list.className = "master-list";
    list.setAttribute("aria-label", "Observed requests");
    for (const request of ordered) {
      const row = document.createElement("button");
      row.className = "record";
      row.classList.toggle("selected", request.id === this.selectedRequest);
      row.addEventListener("click", () => {
        this.selectedRequest = request.id;
        this.render();
      });
      const status = createText("span", `status ${request.status}`, request.status);
      row.append(
        status,
        createText(
          "strong",
          "record-title",
          request.name ??
            (request.kind === "mutation" ? "mutation" : (request.key ?? request.kind)),
        ),
        createText(
          "small",
          "record-meta",
          request.source
            ? `${request.source.file}:${request.source.line}:${request.source.column ?? 0}`
            : request.kind === "loader"
              ? "runtime async boundary"
              : "source unavailable",
        ),
        createText(
          "span",
          "record-detail",
          `#${request.id}${request.duration == null ? "" : ` · ${request.duration}ms`}`,
        ),
      );
      list.append(row);
    }
    const request = ordered.find((candidate) => candidate.id === this.selectedRequest)!;
    const detail = document.createElement("aside");
    detail.className = "detail-pane request-detail-pane";
    const heading = document.createElement("div");
    heading.className = "detail-heading";
    heading.append(
      createText(
        "strong",
        "detail-title",
        request.name ?? (request.kind === "mutation" ? "mutation" : (request.key ?? request.kind)),
      ),
      createText(
        "small",
        "detail-source",
        request.source
          ? `${request.source.file}:${request.source.line}:${request.source.column ?? 0}`
          : "source unavailable",
      ),
      createText("span", `status ${request.status}`, request.status),
    );
    detail.append(heading);
    if (request.args !== undefined) detail.append(this.objectView("ARGUMENTS", request.args));
    if (request.error != null) detail.append(this.objectView("ERROR", request.error));
    else if (request.data !== undefined) detail.append(this.objectView("DATA", request.data));
    detail.append(
      this.objectView("REQUEST", {
        id: request.id,
        kind: request.kind,
        key: request.key,
        name: request.name,
        status: request.status,
        duration: request.duration,
      }),
    );
    explorer.append(list, this.createSplitter(explorer), detail);
    this.body.append(explorer);
  }

  private renderRouter(snapshot: Readonly<Record<string, unknown>>): void {
    const routes = Array.isArray(snapshot.routes)
      ? snapshot.routes.filter((route): route is Record<string, unknown> =>
          Boolean(route && typeof route === "object"),
        )
      : [];
    if (routes.length === 0) return this.empty("No compiled routes observed yet.");
    const activePath =
      snapshot.route && typeof snapshot.route === "object"
        ? (snapshot.route as Record<string, unknown>).path
        : undefined;
    const paths = routes.map((route) => String(route.path ?? "unknown"));
    if (!this.selectedRoute || !paths.includes(this.selectedRoute)) {
      this.selectedRoute =
        typeof activePath === "string" && paths.includes(activePath) ? activePath : paths[0];
    }
    const explorer = document.createElement("div");
    explorer.className = "split-view router-explorer";
    const list = document.createElement("div");
    list.className = "master-list";
    list.setAttribute("aria-label", "Compiled routes");
    for (const [index, route] of routes.entries()) {
      const path = paths[index]!;
      const row = document.createElement("button");
      row.className = "route-record";
      row.classList.toggle("selected", path === this.selectedRoute);
      row.addEventListener("click", () => {
        this.selectedRoute = path;
        this.render();
      });
      row.append(
        createText("strong", "record-title", path),
        createText(
          "small",
          `route-matcher ${path === activePath ? "route-active" : "record-meta"}`,
          path === activePath ? "ACTIVE" : String(route.pattern ?? ""),
        ),
      );
      list.append(row);
    }
    const selectedRoute = this.selectedRoute!;
    const selected = routes[paths.indexOf(selectedRoute)]!;
    const { routes: _routes, ...location } = snapshot;
    const detail = document.createElement("aside");
    detail.className = "detail-pane router-detail-pane";
    const heading = document.createElement("div");
    heading.className = "detail-heading";
    heading.append(
      createText("strong", "detail-title", selectedRoute),
      createText(
        "small",
        "detail-source",
        selectedRoute === activePath ? "active route" : "compiled route",
      ),
    );
    detail.append(heading, this.objectView("ROUTE", selected));
    if (selectedRoute === activePath) detail.append(this.objectView("ACTIVE LOCATION", location));
    explorer.append(list, this.createSplitter(explorer), detail);
    this.body.append(explorer);
  }

  private renderForms(items: readonly SolixFormSnapshot[]): void {
    if (items.length === 0) return this.empty("No form controllers observed yet.");
    for (const form of items) {
      const row = document.createElement("article");
      row.className = "form-record";
      row.append(
        createText("strong", "record-title", `Form #${form.id}`),
        createText(
          "small",
          "record-meta",
          `${form.strategy} · ${form.isSubmitting ? "submitting" : "ready"}`,
        ),
        this.objectView("VALUES", form.values),
        this.objectView("ISSUES", { fields: form.errors, form: form.formErrors }),
      );
      this.body.append(row);
    }
  }

  private renderObject(label: string, value: unknown): void {
    this.body.append(this.objectView(label, value));
  }

  private objectView(label: string, value: unknown): HTMLElement {
    const view = document.createElement("div");
    view.className = "object";
    view.append(createText("span", "object-label", label));
    const pre = document.createElement("pre");
    pre.textContent = displayValue(value);
    view.append(pre);
    return view;
  }

  private createSplitter(container: HTMLElement): HTMLElement {
    const splitter = document.createElement("div");
    splitter.className = "splitter";
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", "vertical");
    splitter.setAttribute("aria-label", "Resize diagnostic list");
    splitter.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const move = (moveEvent: MouseEvent): void => {
        const rect = container.getBoundingClientRect();
        const width = Math.max(180, Math.min(moveEvent.clientX - rect.left, rect.width - 240));
        this.panel.style.setProperty("--list-width", `${width}px`);
      };
      const finish = (): void => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", finish);
        this.savePanelLayout();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", finish);
    });
    return splitter;
  }

  private startPanelDrag(event: MouseEvent): void {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) {
      return;
    }
    event.preventDefault();
    const rect = this.panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    this.panel.style.setProperty("left", `${rect.left}px`);
    this.panel.style.setProperty("top", `${rect.top}px`);
    this.panel.style.setProperty("right", "auto");
    this.panel.style.setProperty("bottom", "auto");
    this.panel.style.setProperty("width", `${rect.width}px`);
    this.panel.style.setProperty("height", `${rect.height}px`);
    const move = (moveEvent: MouseEvent): void => {
      const left = Math.max(
        0,
        Math.min(moveEvent.clientX - offsetX, window.innerWidth - rect.width),
      );
      const top = Math.max(
        0,
        Math.min(moveEvent.clientY - offsetY, window.innerHeight - rect.height),
      );
      this.panel.style.setProperty("left", `${left}px`);
      this.panel.style.setProperty("top", `${top}px`);
    };
    const finish = (): void => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", finish);
      this.savePanelLayout();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", finish);
  }

  private restorePanelLayout(): void {
    try {
      const stored = window.localStorage.getItem("solix.devtools.layout");
      if (!stored) return;
      const layout = JSON.parse(stored) as Partial<PanelLayout>;
      if (
        ![layout.left, layout.top, layout.width, layout.height, layout.listWidth].every(
          Number.isFinite,
        )
      )
        return;
      const width = Math.min(layout.width!, window.innerWidth - 16);
      const height = Math.min(layout.height!, window.innerHeight - 16);
      this.panel.style.setProperty(
        "left",
        `${Math.max(0, Math.min(layout.left!, window.innerWidth - width))}px`,
      );
      this.panel.style.setProperty(
        "top",
        `${Math.max(0, Math.min(layout.top!, window.innerHeight - height))}px`,
      );
      this.panel.style.setProperty("right", "auto");
      this.panel.style.setProperty("bottom", "auto");
      this.panel.style.setProperty("width", `${width}px`);
      this.panel.style.setProperty("height", `${height}px`);
      this.panel.style.setProperty("--list-width", `${layout.listWidth}px`);
    } catch {
      // Storage can be unavailable in sandboxed development frames.
    }
  }

  private savePanelLayout(): void {
    try {
      const rect = this.panel.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8));
      this.panel.style.setProperty("left", `${left}px`);
      this.panel.style.setProperty("top", `${top}px`);
      this.panel.style.setProperty("right", "auto");
      this.panel.style.setProperty("bottom", "auto");
      const listWidth = Number.parseFloat(this.panel.style.getPropertyValue("--list-width"));
      const layout: PanelLayout = {
        left,
        top,
        width: rect.width,
        height: rect.height,
        listWidth: Number.isFinite(listWidth) ? listWidth : rect.width * 0.38,
      };
      window.localStorage.setItem("solix.devtools.layout", JSON.stringify(layout));
    } catch {
      // Storage can be unavailable in sandboxed development frames.
    }
  }

  private highlightComponent(id: number): void {
    this.clearComponentHighlight();
    const rects = (this.registry.components.get(id)?.getNodes() ?? [])
      .filter((node): node is Element => node instanceof Element)
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const overlay = document.createElement("div");
    overlay.dataset.solixHighlight = "";
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483646",
      pointerEvents: "none",
      border: "2px solid #a78bfa",
      background: "rgba(139, 92, 246, .12)",
      boxSizing: "border-box",
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
    });
    document.documentElement.append(overlay);
    this.componentHighlight = overlay;
  }

  private clearComponentHighlight(): void {
    this.componentHighlight?.remove();
    this.componentHighlight = undefined;
  }

  startPicker(): void {
    if (this.pickerCleanup) return;
    const restorePanel = !this.panel.hidden;
    this.close();
    const overlay = document.createElement("div");
    overlay.dataset.solixPicker = "";
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483646",
      pointerEvents: "none",
      border: "2px solid #a78bfa",
      background: "rgba(139, 92, 246, .12)",
      boxSizing: "border-box",
    });
    document.documentElement.append(overlay);
    const move = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || this.host.contains(target)) return;
      const rect = target.getBoundingClientRect();
      Object.assign(overlay.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    };
    const finish = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || this.host.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      const component = this.registry.inspect(target);
      this.selectedComponent = component?.id;
      this.pickerCleanup?.();
      this.open("components");
    };
    const cancel = (event: KeyboardEvent): void => {
      if (event.key === "Escape") this.pickerCleanup?.();
    };
    this.pickerCleanup = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", finish, true);
      document.removeEventListener("keydown", cancel, true);
      overlay.remove();
      this.pickerCleanup = undefined;
      if (restorePanel) this.open();
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", finish, true);
    document.addEventListener("keydown", cancel, true);
  }
}

const styles = `
:host { --canvas:#111116; --surface:#18181f; --raised:#202029; --line:rgba(255,255,255,.1); --text:#f2f0f7; --muted:#8f8b9c; --violet:#a78bfa; --amber:#fbbf24; --red:#fb7185; --green:#4ade80; position:fixed; inset:0; z-index:2147483647; pointer-events:none; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:var(--text); }
* { box-sizing:border-box; } button { font:inherit; color:inherit; }
.launcher { pointer-events:auto; position:fixed; right:20px; bottom:20px; width:44px; height:44px; border:1px solid rgba(255,255,255,.18); border-radius:50%; background:var(--canvas); color:var(--violet); font-size:15px; font-weight:800; box-shadow:0 8px 28px rgba(0,0,0,.35); cursor:pointer; }
.launcher::after,.pulse { content:""; display:block; width:6px; height:6px; border-radius:50%; background:var(--green); }
.launcher::after { position:absolute; right:2px; top:2px; border:2px solid var(--canvas); }
.launcher.busy::after,.busy .pulse { background:var(--amber); animation:pulse 1s infinite; }
.launcher:hover,.launcher:focus-visible { border-color:var(--violet); outline:2px solid rgba(167,139,250,.25); outline-offset:3px; }
.panel { --list-width:38%; pointer-events:auto; position:fixed; right:20px; bottom:76px; width:min(1040px,calc(100vw - 40px)); min-width:min(640px,calc(100vw - 16px)); max-width:calc(100vw - 16px); height:min(680px,calc(100vh - 116px)); min-height:320px; max-height:calc(100vh - 16px); display:grid; grid-template-rows:48px 1fr; overflow:hidden; resize:both; border:1px solid rgba(255,255,255,.16); border-radius:10px; background:var(--canvas); box-shadow:0 18px 64px rgba(0,0,0,.48); }
.panel[hidden] { display:none; }
header { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:12px; border-bottom:1px solid var(--line); padding:0 8px 0 16px; background:var(--surface); cursor:move; user-select:none; }
header>div { display:flex; align-items:center; gap:8px; } header strong { font-size:12px; letter-spacing:.12em; } .pulse { background:var(--violet); }
.actions { gap:4px; }.tool { border:1px solid transparent; border-radius:5px; background:transparent; color:var(--muted); padding:6px 8px; font-size:11px; cursor:pointer; }.tool:hover,.tool:focus-visible { color:var(--text); border-color:var(--line); outline:none; }.close { font-size:18px; line-height:1; }
nav { min-width:0; height:100%; display:flex; align-items:stretch; gap:2px; cursor:default; }
.tab { height:48px; border:0; border-bottom:2px solid transparent; background:transparent; padding:0 10px; color:var(--muted); text-transform:uppercase; font-size:10px; letter-spacing:.06em; cursor:pointer; }.tab:hover { color:var(--text); }.tab[aria-selected=true] { color:var(--violet); border-bottom-color:var(--violet); }
main { overflow:auto; padding:8px; background:var(--canvas); scrollbar-color:var(--raised) transparent; }
.empty { display:grid; min-height:100%; place-items:center; margin:0; color:var(--muted); font-size:11px; }
.split-view { width:calc(100% + 16px); height:calc(100% + 16px); min-width:0; min-height:0; display:grid; grid-template-columns:minmax(180px,var(--list-width)) 5px minmax(0,1fr); margin:-8px; overflow:hidden; }
.component-tree { min-width:0; overflow:auto; border-right:1px solid var(--line); padding:8px 6px; background:var(--canvas); }
.master-list { min-width:0; overflow:auto; padding:8px 6px; background:var(--canvas); }
.splitter { position:relative; background:var(--line); cursor:col-resize; touch-action:none; }.splitter::after { content:""; position:absolute; inset:0 -3px; }.splitter:hover { background:var(--violet); }
.tree-branch { display:contents; }.tree-row { min-width:0; display:grid; grid-template-columns:18px minmax(0,1fr); align-items:center; gap:2px; padding-left:calc(var(--tree-depth) * 14px); }
.tree-toggle,.tree-node { height:27px; border:0; border-radius:4px; background:transparent; }.tree-toggle { padding:0; color:var(--muted); font-size:10px; cursor:pointer; }.tree-toggle.leaf { opacity:.28; cursor:default; }.tree-node { min-width:0; overflow:hidden; padding:0 6px; text-align:left; text-overflow:ellipsis; white-space:nowrap; color:var(--text); font-size:11px; cursor:pointer; }.tree-node:hover { background:var(--surface); }.tree-node.selected { background:var(--raised); color:var(--violet); }.tree-node:focus-visible,.tree-toggle:focus-visible { outline:1px solid var(--violet); outline-offset:-1px; }
.detail-pane,.component-detail-pane { min-width:0; overflow:auto; padding:10px; background:var(--canvas); }.detail-heading { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:3px 12px; padding:4px 2px 10px; border-bottom:1px solid var(--line); }.detail-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }.detail-source { grid-column:1; overflow:hidden; color:var(--muted); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }.detail-count,.detail-heading>.status { grid-column:2; grid-row:1/3; align-self:center; color:var(--muted); font-size:9px; }
.record,.form-record { width:100%; min-width:0; display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; gap:4px 8px; border:1px solid transparent; border-bottom-color:var(--line); border-radius:5px; background:transparent; padding:9px 7px; text-align:left; cursor:pointer; }.record:hover,.record.selected { background:var(--surface); border-color:var(--line); }.record.selected { border-left-color:var(--violet); }.form-record { cursor:default; }.record-id,.record-detail,.record-meta { color:var(--muted); font-size:10px; }.record-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }.record-meta { grid-column:2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.record-detail { grid-column:2; overflow:hidden; color:var(--muted); font-size:9px; text-overflow:ellipsis; white-space:nowrap; }.status { min-width:58px; border:1px solid currentColor; border-radius:3px; padding:2px 5px; text-align:center; text-transform:uppercase; font-size:8px; }.status.pending { color:var(--amber); }.status.error { color:var(--red); }.status.success { color:var(--green); }.status.idle,.status.cancelled { color:var(--muted); }
.route-record { width:100%; min-width:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); align-items:center; gap:4px 8px; border:1px solid transparent; border-bottom-color:var(--line); border-radius:5px; background:transparent; padding:9px 8px; text-align:left; cursor:pointer; }.route-record:hover,.route-record.selected { border-color:var(--line); background:var(--surface); }.route-record.selected { border-left-color:var(--violet); }.route-matcher { min-width:0; overflow:hidden; text-align:right; text-overflow:ellipsis; white-space:nowrap; }.route-active { color:var(--green); font-size:9px; letter-spacing:.08em; }
.object { grid-column:1/-1; min-width:0; margin-top:6px; border:1px solid var(--line); border-radius:5px; background:var(--surface); overflow:hidden; }.object-label { display:block; padding:6px 8px; border-bottom:1px solid var(--line); color:var(--muted); font-size:9px; letter-spacing:.08em; }.object pre { max-height:220px; overflow:auto; margin:0; padding:9px; color:#d8d4e3; font:10px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; tab-size:2; white-space:pre-wrap; }
.form-record { margin-bottom:6px; border-color:var(--line); background:var(--surface); cursor:default; }
@keyframes pulse { 50% { opacity:.35; transform:scale(.75); } }
@media (max-width:600px) { .panel { left:8px!important; right:8px!important; top:8px!important; bottom:64px!important; width:auto!important; min-width:0; height:auto!important; resize:none; }.launcher { right:12px; bottom:12px; }header { grid-template-columns:1fr auto; gap:4px; padding-left:10px; }.brand { display:none!important; }.tab { padding:0 7px; font-size:9px; }.split-view { grid-template-columns:1fr; grid-template-rows:minmax(150px,42%) minmax(0,1fr); }.splitter { display:none; }.component-tree,.master-list { border-right:0; border-bottom:1px solid var(--line); } }
@media (prefers-reduced-motion:reduce) { * { animation-duration:.01ms!important; } }
`;

function installWebMcp(api: SolixDevtools): void {
  const context = document.modelContext ?? navigator.modelContext;
  if (!context) return;
  const controller = new AbortController();
  context.registerTool(
    {
      name: "solix_get_diagnostics",
      description: "Returns live Solix component, request, router, or form diagnostics.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { area: { type: "string", enum: areas } },
        additionalProperties: false,
      },
      execute(input) {
        validateToolInput(input, ["area"]);
        const area = input.area;
        if (area !== undefined && !isArea(area))
          throw new TypeError("area must be a Solix devtools area");
        return api.getSnapshot(area);
      },
    },
    { signal: controller.signal },
  );
  context.registerTool(
    {
      name: "solix_inspect_element",
      description: "Returns the mounted Solix component responsible for a CSS-selected element.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string", minLength: 1, maxLength: 500 } },
        required: ["selector"],
        additionalProperties: false,
      },
      execute(input) {
        validateToolInput(input, ["selector"]);
        if (
          typeof input.selector !== "string" ||
          input.selector.length === 0 ||
          input.selector.length > 500
        ) {
          throw new TypeError("selector must be a non-empty string of at most 500 characters");
        }
        return api.inspectElement(input.selector);
      },
    },
    { signal: controller.signal },
  );
}

function validateToolInput(
  input: unknown,
  allowed: readonly string[],
): asserts input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("WebMCP tool input must be an object");
  }
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new TypeError(`Unexpected WebMCP input property ${unexpected}`);
}

export function installDevtools(): SolixDevtools | undefined {
  if (typeof document === "undefined" || typeof navigator === "undefined") return undefined;
  if (globalThis.__solix) return globalThis.__solix;
  const registry = new DevtoolsRegistry();
  const panel = new DevtoolsPanel(registry);
  const api: SolixDevtools = Object.freeze({
    version: "0.1" as const,
    get components() {
      return registry.snapshot().components;
    },
    get requests() {
      return registry.snapshot().requests;
    },
    get router() {
      return registry.snapshot().router;
    },
    get forms() {
      return registry.snapshot().forms;
    },
    getSnapshot(area?: DevtoolsArea) {
      if (area !== undefined && !isArea(area))
        throw new TypeError("__solix.getSnapshot() expects a valid area");
      const snapshot = registry.snapshot();
      return area ? snapshot[area] : snapshot;
    },
    inspectElement(target: Element | string) {
      const element = typeof target === "string" ? document.querySelector(target) : target;
      if (!(element instanceof Element)) {
        if (typeof target === "string") return null;
        throw new TypeError("__solix.inspectElement() expects an Element or CSS selector");
      }
      return registry.inspect(element);
    },
    open: (tab?: DevtoolsArea) => panel.open(tab),
    close: () => panel.close(),
    startElementPicker: () => panel.startPicker(),
    subscribe: (listener: () => void) => registry.subscribe(listener),
  });
  globalThis.__solix = api;
  (globalThis as { [DEVTOOLS_HOOK]?: DevtoolsHook })[DEVTOOLS_HOOK] = registry;
  installWebMcp(api);
  return api;
}

installDevtools();
