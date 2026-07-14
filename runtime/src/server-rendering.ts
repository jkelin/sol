import type { Block, TemplateDefinition } from "./rendering.ts";
import type { SsrSession } from "./ssr-session.ts";

export interface ServerRenderable {
  serverHtml(): string;
}

export interface ServerElement {
  readonly kind: "server-element";
  readonly index: number;
  readonly attributes: Map<string, string | true | undefined>;
}

export interface ServerRegion {
  readonly kind: "server-region";
  readonly index: number;
  blocks: Block[];
}

export interface ServerFragment {
  readonly kind: "server-fragment";
  readonly fragment: ServerFragment;
  readonly definition: TemplateDefinition;
  readonly session?: SsrSession;
  readonly elements: ServerElement[];
  readonly regions: ServerRegion[];
}

export function isServerElement(value: unknown): value is ServerElement {
  return (value as ServerElement | undefined)?.kind === "server-element";
}

export function isServerRegion(value: unknown): value is ServerRegion {
  return (value as ServerRegion | undefined)?.kind === "server-region";
}

export function isServerFragment(value: unknown): value is ServerFragment {
  return (value as ServerFragment | undefined)?.kind === "server-fragment";
}

export function isServerBlock(value: Block): value is Block & ServerRenderable {
  return typeof (value as Block & Partial<ServerRenderable>).serverHtml === "function";
}

export function instantiateServer(
  definition: TemplateDefinition,
  session?: SsrSession,
): ServerFragment {
  const elementIndexes = [...definition.html.matchAll(/data-solix-e="(\d+)"/g)].map((match) =>
    Number(match[1]),
  );
  const regionIndexes = [...definition.html.matchAll(/<!--solix:s:(\d+)-->/g)].map((match) =>
    Number(match[1]),
  );
  const elements: ServerElement[] = [];
  for (const index of elementIndexes) {
    elements[index] = { kind: "server-element", index, attributes: new Map() };
  }
  const regions: ServerRegion[] = [];
  for (const index of regionIndexes) {
    regions[index] = { kind: "server-region", index, blocks: [] };
  }
  const fragment = {
    kind: "server-fragment",
    definition,
    session,
    elements,
    regions,
  } as ServerFragment;
  Object.defineProperty(fragment, "fragment", { value: fragment });
  return fragment;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function setServerAttribute(
  element: ServerElement,
  name: string,
  value: string | true | undefined,
): void {
  element.attributes.set(name, value);
}

export function mountServerBlock(block: Block, region: ServerRegion, replace = false): void {
  if (!isServerBlock(block)) throw new Error("Cannot mount a DOM block during server rendering");
  if (replace) region.blocks = [block];
  else region.blocks.push(block);
}

export function serverBlock(fragment: ServerFragment, cleanups: (() => void)[] = []): Block {
  let disposed = false;
  let parent: ServerRegion | undefined;
  const render = (): string => {
    fragment.session?.recordTemplate(fragment.definition.signature);
    let html = fragment.definition.html;
    for (const element of fragment.elements) {
      if (!element) continue;
      const dynamic = [...element.attributes]
        .flatMap(([name, value]) =>
          value === undefined
            ? []
            : [value === true ? name : `${name}="${escapeAttribute(value)}"`],
        )
        .join(" ");
      html = html.replace(
        `data-solix-e="${element.index}"`,
        `${dynamic ? `${dynamic} ` : ""}data-solix-e="${element.index}"`,
      );
    }
    for (const region of fragment.regions) {
      if (!region) continue;
      const marker = `<!--solix:s:${region.index}--><!--solix:e:${region.index}-->`;
      const content = region.blocks
        .map((block) => {
          if (!isServerBlock(block)) throw new Error("Invalid server-rendered block");
          return block.serverHtml();
        })
        .join("");
      html = html.replace(
        marker,
        `<!--solix:s:${region.index}-->${content}<!--solix:e:${region.index}-->`,
      );
    }
    return `<!--solix:block:start:${fragment.definition.signature}-->${html}<!--solix:block:end-->`;
  };
  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    for (const registered of cleanups.toReversed()) registered();
  };
  return {
    nodes: [],
    mount(target) {
      if (!isServerRegion(target)) throw new Error("Server blocks require a server region");
      parent = target;
      mountServerBlock(this, target);
    },
    move(target) {
      if (!isServerRegion(target)) throw new Error("Server blocks require a server region");
      if (parent) parent.blocks = parent.blocks.filter((block) => block !== this);
      parent = target;
      mountServerBlock(this, target);
    },
    enter() {},
    leave() {
      return undefined;
    },
    retire() {
      cleanup();
      if (parent) parent.blocks = parent.blocks.filter((block) => block !== this);
      return undefined;
    },
    dispose() {
      cleanup();
      if (parent) parent.blocks = parent.blocks.filter((block) => block !== this);
    },
    serverHtml: render,
  } as Block & ServerRenderable;
}

export function serverValueBlock(value: string): Block {
  const block: Block & ServerRenderable = {
    nodes: [],
    mount(target) {
      if (!isServerRegion(target)) throw new Error("Server blocks require a server region");
      mountServerBlock(block, target);
    },
    move(target) {
      if (!isServerRegion(target)) throw new Error("Server blocks require a server region");
      mountServerBlock(block, target);
    },
    enter() {},
    leave: () => undefined,
    retire: () => undefined,
    dispose() {},
    serverHtml: () => `<!--solix:block:start-->${value}<!--solix:block:end-->`,
  };
  return block;
}

export function serverRawValue(value: string): Block {
  const block = serverValueBlock(value) as Block & ServerRenderable;
  Object.defineProperty(block, "serverHtml", { value: () => value });
  return block;
}
