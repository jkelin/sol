import type { Component } from "./components.ts";
import {
  disposeOwner,
  isObject,
  isPromiseLike,
  reactive,
  runtimeEffect,
  runtimeState,
} from "./reactivity.ts";
import type { RouteRuntimeAdapter } from "./routes.ts";
import { COMPONENT } from "./symbols.ts";
import { cancelTransitions, runTransitions } from "./transitions.ts";
import type { HydrationSession, SsrSession } from "./ssr-session.ts";
import {
  instantiateServer,
  isServerBlock,
  isServerFragment,
  isServerRegion,
  serverBlock,
  serverValueBlock,
  type ServerElement,
  type ServerFragment,
  type ServerRegion,
} from "./server-rendering.ts";
import {
  hydratedBlock,
  hydratedValueBlock,
  instantiateHydrated,
  isHydratedFragment,
  type HydratedFragment,
  type HydrationClaim,
} from "./hydration-rendering.ts";

export type Cleanup = () => void;

export type Region = { start: Comment; end: Comment } | ServerRegion;

export interface View {
  fragment: DocumentFragment;
  elements: Element[];
  regions: { start: Comment; end: Comment }[];
}

export interface RenderView {
  fragment: DocumentFragment | ServerFragment | HydratedFragment;
  elements: (Element | ServerElement)[];
  regions: Region[];
}

export type RenderParent = Node | ServerRegion;

export interface Block {
  readonly nodes: Node[];
  mount(parent: RenderParent, before?: Node | null): void;
  move(parent: RenderParent, before?: Node | null): void;
  enter(): void;
  leave(): Promise<void> | undefined;
  retire(): Promise<void> | undefined;
  dispose(): void;
}

export interface BlockLifecycle {
  readonly refMounts: Cleanup[];
  readonly portalMounts: Cleanup[];
  readonly remoteBlocks: Block[];
  readonly coordinator: MountCoordinator;
}

interface MountCoordinator {
  active: boolean;
  flushing: boolean;
  readonly refMounts: Cleanup[];
  readonly portalMounts: Cleanup[];
}

export interface TemplateDefinition {
  readonly html: string;
  readonly signature: string;
  readonly metadata: TemplateMetadata;
  element?: HTMLTemplateElement;
}

export interface TemplateMetadata {
  readonly elements: readonly string[];
  readonly regions: readonly number[];
  readonly operations: readonly TemplateOperationMetadata[];
}

export interface TemplateOperationMetadata {
  readonly id: string;
  readonly kind: string;
  readonly target?: "element" | "region";
  readonly index?: number;
  readonly name?: string;
}

export interface PendingBlock extends PromiseLike<Block> {
  cancel?: () => void;
}

export type MaybeBlock = Block | PendingBlock;
export type RenderFactory = (frame: RenderFrame) => Block;
export type ErrorRenderFactory = (error: unknown, frame: RenderFrame) => Block;

export interface SuspenseController {
  begin(): () => void;
  reject(error: unknown): void;
}

export interface RenderFrame {
  readonly owner: Cleanup[];
  readonly contexts: ReadonlyMap<symbol, () => object>;
  readonly mounts: MountCoordinator;
  readonly suspense?: SuspenseController;
  readonly handleError?: (error: unknown) => void;
  readonly mode?: "server" | "hydrate" | "resume";
  readonly ssr?: SsrSession;
  readonly ssrBoundary?: number;
  readonly hydration?: HydrationSession;
  readonly claim?: HydrationClaim;
  readonly waitForResume?: boolean;
  readonly timeoutMs?: number;
}

export type ComponentFactory<Props extends object> = (
  props: Readonly<Props>,
  frame: RenderFrame,
) => MaybeBlock;
export type CompiledComponent<Props extends object> = Component<Props> & {
  [COMPONENT]: ComponentFactory<Props>;
};

export let routeRuntime: RouteRuntimeAdapter | undefined;

export function configureRouteRuntime(adapter: RouteRuntimeAdapter): void {
  routeRuntime = adapter;
}

export function template(
  html: string,
  signature = html,
  metadata: TemplateMetadata = { elements: [], regions: [], operations: [] },
): TemplateDefinition {
  return { html, signature, metadata };
}

export function instantiate(definition: TemplateDefinition): View;
export function instantiate(definition: TemplateDefinition, frame: RenderFrame): RenderView;
export function instantiate(definition: TemplateDefinition, frame?: RenderFrame): RenderView {
  if (frame?.mode === "server") {
    return instantiateServer(definition, frame.ssr);
  }
  if (frame?.mode === "hydrate" && frame.hydration && !frame.hydration.committed && frame.claim) {
    return instantiateHydrated(definition, frame.hydration, frame.claim);
  }
  if (typeof document === "undefined") {
    throw new Error("solix can only instantiate templates in a browser DOM");
  }
  definition.element ??= document.createElement("template");
  if (!definition.element.innerHTML) definition.element.innerHTML = definition.html;
  const fragment = definition.element.content.cloneNode(true) as DocumentFragment;
  for (const inertScript of fragment.querySelectorAll("script")) {
    const executableScript = document.createElement("script");
    for (const attribute of inertScript.attributes) {
      executableScript.setAttribute(attribute.name, attribute.value);
    }
    executableScript.textContent = inertScript.textContent;
    inertScript.replaceWith(executableScript);
  }
  const elements: Element[] = [];
  for (const element of fragment.querySelectorAll<HTMLElement>("[data-solix-e]")) {
    const index = Number(element.dataset.solixE);
    if (!Number.isInteger(index)) throw new Error("Invalid compiled element marker");
    elements[index] = element;
    element.removeAttribute("data-solix-e");
  }

  const starts = new Map<number, Comment>();
  const ends = new Map<number, Comment>();
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) {
    const comment = walker.currentNode as Comment;
    const match = /^solix:(s|e):(\d+)$/.exec(comment.data);
    if (!match) continue;
    const index = Number(match[2]);
    if (match[1] === "s") starts.set(index, comment);
    else ends.set(index, comment);
  }
  const regions: Region[] = [];
  for (const [index, start] of starts) {
    const end = ends.get(index);
    if (!end) throw new Error(`Missing compiled region end marker ${index}`);
    regions[index] = { start, end };
  }
  return { fragment, elements, regions };
}

function mountCoordinator(active: boolean): MountCoordinator {
  return { active, flushing: false, refMounts: [], portalMounts: [] };
}

export function blockLifecycle(frame?: RenderFrame): BlockLifecycle {
  return {
    refMounts: [],
    portalMounts: [],
    remoteBlocks: [],
    coordinator: frame?.mounts ?? mountCoordinator(true),
  };
}

function flushMounts(coordinator: MountCoordinator): void {
  if (!coordinator.active || coordinator.flushing) return;
  coordinator.flushing = true;
  try {
    while (coordinator.refMounts.length > 0 || coordinator.portalMounts.length > 0) {
      while (coordinator.refMounts.length > 0) coordinator.refMounts.shift()!();
      coordinator.portalMounts.shift()?.();
    }
  } finally {
    coordinator.flushing = false;
  }
}

export function activateMounts(frame: RenderFrame): void {
  frame.mounts.active = true;
  flushMounts(frame.mounts);
}

function combinedTransition(
  local: Promise<void> | undefined,
  remoteBlocks: readonly Block[],
): Promise<void> | undefined {
  const transitions = remoteBlocks.flatMap((remote) => {
    const transition = remote.leave();
    return transition ? [transition] : [];
  });
  if (local) transitions.unshift(local);
  return transitions.length > 0 ? Promise.all(transitions).then(() => undefined) : undefined;
}

export function block(
  fragment: DocumentFragment | ServerFragment | HydratedFragment,
  cleanups: Cleanup[] = [],
  lifecycle: BlockLifecycle = blockLifecycle(),
): Block {
  if (isServerFragment(fragment)) return serverBlock(fragment, cleanups);
  if (isHydratedFragment(fragment)) return hydratedBlock(fragment, cleanups, lifecycle);
  const start = document.createComment("solix:block:start");
  const end = document.createComment("solix:block:end");
  fragment.prepend(start);
  fragment.append(end);
  let disposed = false;
  let cleaned = false;
  let mounted = false;
  const nodes = (): Node[] => {
    const result: Node[] = [];
    let node: Node | null = start;
    while (node) {
      result.push(node);
      if (node === end) break;
      node = node.nextSibling;
    }
    return result;
  };
  const move = (parent: Node, before: Node | null = null): void => {
    const moving = document.createDocumentFragment();
    for (const node of nodes()) moving.append(node);
    parent.insertBefore(moving, before);
  };
  const mountBlock = (parent: Node, before: Node | null = null): void => {
    if (disposed) return;
    move(parent, before);
    if (mounted) return;
    mounted = true;
    try {
      lifecycle.coordinator.refMounts.push(
        ...lifecycle.refMounts.map((attach) => () => {
          if (!disposed) attach();
        }),
      );
      lifecycle.coordinator.portalMounts.push(
        ...lifecycle.portalMounts.map((attach) => () => {
          if (!disposed) attach();
        }),
      );
      flushMounts(lifecycle.coordinator);
    } catch (error) {
      disposed = true;
      cleanup();
      for (const remote of lifecycle.remoteBlocks) remote.dispose();
      remove();
      throw error;
    }
  };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const registered of cleanups.toReversed()) registered();
  };
  const remove = (): void => {
    for (const node of nodes()) node.parentNode?.removeChild(node);
  };
  return {
    get nodes() {
      return nodes();
    },
    mount(parent, before) {
      if (isServerRegion(parent))
        throw new Error("Cannot mount a DOM block during server rendering");
      mountBlock(parent, before);
    },
    move(parent, before) {
      if (isServerRegion(parent))
        throw new Error("Cannot move a DOM block during server rendering");
      move(parent, before);
    },
    enter() {
      if (disposed) return;
      void runTransitions(nodes(), "enter");
      for (const remote of lifecycle.remoteBlocks) remote.enter();
    },
    leave() {
      return disposed
        ? undefined
        : combinedTransition(runTransitions(nodes(), "leave"), lifecycle.remoteBlocks);
    },
    retire() {
      if (disposed) return undefined;
      const leaving = combinedTransition(runTransitions(nodes(), "leave"), lifecycle.remoteBlocks);
      cleanup();
      if (!leaving) {
        disposed = true;
        for (const remote of lifecycle.remoteBlocks) remote.dispose();
        remove();
        return undefined;
      }
      return leaving.then(() => {
        if (disposed) return;
        disposed = true;
        for (const remote of lifecycle.remoteBlocks) remote.dispose();
        remove();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTransitions(nodes());
      cleanup();
      for (const remote of lifecycle.remoteBlocks) remote.dispose();
      remove();
    },
  };
}

export function emptyBlock(frame?: RenderFrame): Block {
  if (frame?.mode === "server") return serverValueBlock("");
  if (frame?.mode === "hydrate" && frame.hydration && !frame.hydration.committed && frame.claim) {
    return hydratedValueBlock(frame.claim, frame.hydration, () => "");
  }
  return block(document.createDocumentFragment());
}

function displayValue(value: unknown): string {
  return value == null || typeof value === "boolean" ? "" : String(value);
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function valueBlock(getValue: () => unknown, frame?: RenderFrame): Block {
  if (frame?.mode === "server") return serverValueBlock(escapeText(displayValue(getValue())));
  if (frame?.mode === "hydrate" && frame.hydration && !frame.hydration.committed && frame.claim) {
    return hydratedValueBlock(frame.claim, frame.hydration, () => displayValue(getValue()));
  }
  const fragment = document.createDocumentFragment();
  const textNode = document.createTextNode("");
  fragment.append(textNode);
  const cleanup = runtimeEffect(() => {
    textNode.data = displayValue(getValue());
  });
  return block(fragment, [cleanup]);
}

export function component<Props extends object>(
  factory: ComponentFactory<Props>,
): Component<Props> {
  const compiled = (() => {
    throw new Error(
      "Compiled components cannot be called directly; pass them to mount() or render them in JSX",
    );
  }) as unknown as CompiledComponent<Props>;
  const ownedFactory: ComponentFactory<Props> = (props, parentFrame) => {
    const owner: Cleanup[] = [];
    const frame: RenderFrame = { ...parentFrame, owner };
    const previousOwner = runtimeState.activeOwner;
    const previousFrame = runtimeState.activeFrame;
    runtimeState.activeOwner = owner;
    runtimeState.activeFrame = frame;
    let rendered: MaybeBlock;
    try {
      rendered = factory(props, frame);
    } catch (error) {
      disposeOwner(owner);
      throw error;
    } finally {
      runtimeState.activeOwner = previousOwner;
      runtimeState.activeFrame = previousFrame;
    }
    if (isPromiseLike(rendered)) {
      const pending = Promise.resolve(rendered).then(
        (resolved) => ownedBlock(resolved, owner),
        (error) => {
          disposeOwner(owner);
          throw error;
        },
      );
      void Object.defineProperty(pending, "cancel", { value: () => disposeOwner(owner) });
      return pending;
    }
    return ownedBlock(rendered, owner);
  };
  Object.defineProperty(compiled, COMPONENT, { value: ownedFactory });
  return compiled;
}

function ownedBlock(rendered: Block, owner: Cleanup[]): Block {
  let disposed = false;
  let retired = false;
  let retirement: Promise<void> | undefined;
  const owned: Block = {
    get nodes() {
      return rendered.nodes;
    },
    mount: (parent, before) => rendered.mount(parent, before),
    move: (parent, before) => rendered.move(parent, before),
    enter: () => rendered.enter(),
    leave: () => rendered.leave(),
    retire() {
      if (disposed || retired) return retirement;
      retired = true;
      disposeOwner(owner);
      const leaving = rendered.retire();
      if (!leaving) {
        disposed = true;
        return undefined;
      }
      retirement = leaving.then(() => {
        disposed = true;
      });
      return retirement;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      rendered.dispose();
      disposeOwner(owner);
    },
  };
  if (isServerBlock(rendered)) {
    Object.defineProperty(owned, "serverHtml", { value: () => rendered.serverHtml() });
  }
  return owned;
}

export function getFactory<Props extends object>(
  candidate: Component<Props>,
): ComponentFactory<Props> {
  if (typeof candidate !== "function") {
    throw new TypeError("Expected a compiled Solix component");
  }
  const factory = (candidate as CompiledComponent<Props>)[COMPONENT];
  if (!factory) {
    throw new TypeError(
      "mount() received an uncompiled component. Add solix() before Vite's JSX transform.",
    );
  }
  return factory;
}

export function renderComponent<Props extends object>(
  candidate: Component<Props>,
  props?: Props,
): Block {
  if (props != null && !isObject(props)) {
    throw new TypeError("renderComponent() props must be an object");
  }
  const initialProps = readonlyProps(reactive({ ...props }) as Props & object);
  const frame = rootFrame();
  return activatedBlock(resolvedBlock(getFactory(candidate)(initialProps, frame), frame), frame);
}

function activatedBlock(rendered: Block, frame: RenderFrame): Block {
  let activated = false;
  return {
    get nodes() {
      return rendered.nodes;
    },
    mount(parent, before) {
      rendered.mount(parent, before);
      if (activated) return;
      activated = true;
      try {
        activateMounts(frame);
      } catch (error) {
        rendered.dispose();
        throw error;
      }
    },
    move: (parent, before) => rendered.move(parent, before),
    enter: () => rendered.enter(),
    leave: () => rendered.leave(),
    retire: () => rendered.retire(),
    dispose: () => rendered.dispose(),
  };
}

export function readonlyProps<Props extends object>(props: Props): Readonly<Props> {
  return new Proxy(props, {
    set() {
      throw new TypeError("Component props are readonly");
    },
    deleteProperty() {
      throw new TypeError("Component props are readonly");
    },
    defineProperty() {
      throw new TypeError("Component props are readonly");
    },
    setPrototypeOf() {
      throw new TypeError("Component props are readonly");
    },
    preventExtensions() {
      throw new TypeError("Component props are readonly");
    },
  });
}

export function mount<Props extends object>(
  candidate: Component<Props>,
  target: Element,
  props?: Props,
): Cleanup {
  if (!target || target.nodeType !== Node.ELEMENT_NODE) {
    throw new TypeError("mount() expects a DOM Element target");
  }
  if (props != null && !isObject(props)) throw new TypeError("mount() props must be an object");
  const mounted = renderComponent(candidate, props);
  target.replaceChildren();
  mounted.mount(target);
  return () => mounted.dispose();
}

export function rootFrame(): RenderFrame {
  return { owner: [], contexts: new Map(), mounts: mountCoordinator(false) };
}

function cancelPendingBlock(value: PromiseLike<unknown>): void {
  const cancel = (value as PendingBlock).cancel;
  if (typeof cancel === "function") cancel();
}

export function surfaceAsyncError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

export function reportError(frame: RenderFrame, error: unknown): void {
  if (frame.suspense) frame.suspense.reject(error);
  else if (frame.handleError) frame.handleError(error);
  else if (frame.ssr) frame.ssr.fail(error);
  else if (frame.hydration && !frame.hydration.committed) frame.hydration.fail(error);
  else surfaceAsyncError(error);
}

export function resolvedBlock(candidate: MaybeBlock, frame: RenderFrame): Block {
  if (!isPromiseLike(candidate)) return candidate;
  if (frame.mode === "server") {
    let resolved: Block | undefined;
    let disposed = false;
    const finish = frame.suspense?.begin() ?? frame.ssr?.beginRoot();
    void Promise.resolve(candidate).then(
      (settled) => {
        if (disposed) settled.dispose();
        else resolved = settled;
        finish?.();
      },
      (error) => {
        if (!disposed) reportError(frame, error);
        finish?.();
      },
    );
    const pending: Block & { serverHtml(): string } = {
      nodes: [],
      mount(parent) {
        if (!isServerRegion(parent)) throw new Error("Server async blocks require a server region");
        parent.blocks.push(pending);
      },
      move() {},
      enter() {},
      leave: () => undefined,
      retire: () => undefined,
      dispose() {
        disposed = true;
        cancelPendingBlock(candidate);
        resolved?.dispose();
        finish?.();
      },
      serverHtml: () => (resolved && isServerBlock(resolved) ? resolved.serverHtml() : ""),
    };
    return pending;
  }
  if (frame.mode === "hydrate" || frame.mode === "resume") {
    let resolved: Block | undefined;
    let disposed = false;
    let parent: Node | undefined;
    let before: Node | null | undefined;
    const finish = frame.suspense?.begin();
    const promise =
      frame.hydration && (frame.mode === "hydrate" || frame.waitForResume)
        ? frame.hydration.track(candidate)
        : Promise.resolve(candidate);
    void promise.then(
      (settled) => {
        if (disposed) settled.dispose();
        else {
          resolved = settled;
          const currentParent = before?.parentNode ?? parent;
          if (currentParent) settled.mount(currentParent, before);
        }
        finish?.();
      },
      (error) => {
        if (!disposed) reportError(frame, error);
        finish?.();
      },
    );
    return {
      get nodes() {
        return resolved?.nodes ?? [];
      },
      mount(target, targetBefore) {
        if (isServerRegion(target)) throw new Error("Cannot hydrate into a server region");
        parent = target;
        before = targetBefore;
        resolved?.mount(target, targetBefore);
      },
      move(target, targetBefore) {
        if (isServerRegion(target)) throw new Error("Cannot hydrate into a server region");
        parent = target;
        before = targetBefore;
        resolved?.move(target, targetBefore);
      },
      enter: () => resolved?.enter(),
      leave: () => resolved?.leave(),
      retire: () => resolved?.retire(),
      dispose() {
        disposed = true;
        cancelPendingBlock(candidate);
        resolved?.dispose();
        finish?.();
      },
    };
  }
  const fragment = document.createDocumentFragment();
  const marker = document.createComment("solix:async");
  fragment.append(marker);
  let disposed = false;
  let resolved: Block | undefined;
  const finish = frame.suspense?.begin();
  Promise.resolve(candidate).then(
    (settledBlock) => {
      if (disposed) {
        settledBlock.dispose();
      } else {
        resolved = settledBlock;
        settledBlock.mount(marker.parentNode!, marker);
      }
      finish?.();
    },
    (error) => {
      if (!disposed) reportError(frame, error);
      finish?.();
    },
  );
  return block(fragment, [
    () => {
      disposed = true;
      cancelPendingBlock(candidate);
      finish?.();
      resolved?.dispose();
    },
  ]);
}
