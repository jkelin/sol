// oxlint-disable no-control-regex -- Internal template slots intentionally use NUL delimiters.
import type { Block, TemplateDefinition } from "./rendering.ts";
import { runCleanups, runDisposals } from "./reactivity.ts";
import type { SsrSession } from "./ssr-session.ts";

export interface ServerRenderable {
  serverHtml(): string;
}

export interface ServerElement {
  readonly kind: "server-element";
  readonly index: number;
  readonly tag: string;
  readonly attributes: Map<string, string | true | undefined>;
  textContent?: string;
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
  readonly templateHtml: string;
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
  const elements: ServerElement[] = [];
  for (const [index, tag] of definition.metadata.elements.entries()) {
    elements[index] = { kind: "server-element", index, tag, attributes: new Map() };
  }
  const regions: ServerRegion[] = [];
  for (let index = 0; index < definition.metadata.regionCount; index += 1) {
    regions[index] = { kind: "server-region", index, blocks: [] };
  }
  const fragment = {
    kind: "server-fragment",
    definition,
    templateHtml: prepareElementSlots(definition.html, elements),
    session,
    elements,
    regions,
  } as ServerFragment;
  Object.defineProperty(fragment, "fragment", { value: fragment });
  return fragment;
}

function elementSlot(index: number): string {
  return `\0sol:element:${index}\0`;
}

function prepareElementSlots(html: string, elements: ServerElement[]): string {
  const found = new Set<number>();
  const markerPattern = /data-sol-e="(\d+)"(?=\s|\/?>)/y;
  let result = "";
  let cursor = 0;
  let inTag = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < html.length; index += 1) {
    const character = html[index]!;
    if (!inTag) {
      if (character === "<") inTag = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      inTag = false;
      continue;
    }
    if (!/\s/.test(html[index - 1] ?? "")) continue;
    markerPattern.lastIndex = index;
    const match = markerPattern.exec(html);
    if (!match) continue;
    const elementIndex = Number(match[1]);
    if (!elements[elementIndex] || found.has(elementIndex)) {
      throw new Error(`Invalid server element metadata ${elementIndex}`);
    }
    result += html.slice(cursor, index) + elementSlot(elementIndex);
    cursor = index + match[0].length;
    index = cursor - 1;
    found.add(elementIndex);
  }
  for (const element of elements) {
    if (element && !found.has(element.index)) {
      throw new Error(`Missing server element metadata ${element.index}`);
    }
  }
  return result + html.slice(cursor);
}

export function normalizeHtmlString(value: string): string {
  let result = "";
  let chunkStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (code !== 0 && (code < 0xdc00 || code > 0xdfff)) {
      continue;
    }
    result += value.slice(chunkStart, index) + "\uFFFD";
    chunkStart = index + 1;
  }
  return chunkStart === 0 ? value : result + value.slice(chunkStart);
}

function escapeAttribute(value: string): string {
  return normalizeHtmlString(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeText(value: string): string {
  return normalizeHtmlString(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function serverSafeRawText(tag: string, value: string): string {
  switch (tag.toLowerCase()) {
    case "script":
      return value.replaceAll(/<\/script/gi, "<\\/script");
    case "style":
      return value.replaceAll(/<\/style/gi, "<\\/style");
    default:
      return value;
  }
}

function decodeHtml(value: string): string {
  return value.replaceAll(
    /&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|#39);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hexadecimal !== undefined) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        default:
          return "'";
      }
    },
  );
}

function optionValue(
  attributes: string,
  content: string,
  elements: readonly ServerElement[],
): string {
  const slot = /\x00sol:element:(\d+)\x00/.exec(attributes);
  if (slot) {
    const value = elements[Number(slot[1])]?.attributes.get("value");
    if (typeof value === "string") return value;
  }
  const match = /\svalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
  if (match) return decodeHtml(match[1] ?? match[2] ?? match[3] ?? "");
  const text = decodeHtml(content.replaceAll(/<!--[\s\S]*?-->|<[^>]*>/g, ""));
  return text.replaceAll(/[\t\n\f\r ]+/g, " ").trim();
}

function renderedAttributeSlot(element: ServerElement): string {
  const marker = `data-sol-e="${element.index}"`;
  const dynamic = [...element.attributes]
    .filter(
      ([name]) => !(name === "value" && (element.tag === "textarea" || element.tag === "select")),
    )
    .flatMap(([name, value]) =>
      value === undefined ? [] : [value === true ? name : `${name}="${escapeAttribute(value)}"`],
    )
    .join(" ");
  return `${dynamic ? `${dynamic} ` : ""}${marker}`;
}

function renderSpecialElementContent(
  element: ServerElement,
  content: string,
  elements: readonly ServerElement[],
): string {
  if (element.tag === "textarea") {
    const value = element.attributes.get("value");
    if (typeof value === "string") return escapeText(value);
  }
  if (element.textContent !== undefined) {
    return element.tag === "script" || element.tag === "style"
      ? serverSafeRawText(element.tag, element.textContent)
      : escapeText(element.textContent);
  }
  const value = element.attributes.get("value");
  if (element.tag !== "select" || typeof value !== "string") return content;
  return content.replaceAll(
    /<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi,
    (option, attributes: string, optionContent: string) => {
      const withoutSelected = attributes.replace(
        /\sselected(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i,
        "",
      );
      const selected =
        optionValue(withoutSelected, optionContent, elements) === value ? " selected" : "";
      return `<option${withoutSelected}${selected}>${optionContent}</option>`;
    },
  );
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
    let html = fragment.templateHtml;
    const renderedRegions = new Set<number>();
    html = html.replaceAll(
      /<!--sol:s:(\d+)--><!--sol:e:\1-->/g,
      (_marker, serializedIndex: string) => {
        const index = Number(serializedIndex);
        const region = fragment.regions[index];
        if (!region || renderedRegions.has(index)) {
          throw new Error(`Invalid server region metadata ${index}`);
        }
        renderedRegions.add(index);
        const content = region.blocks
          .map((block) => {
            if (!isServerBlock(block)) throw new Error("Invalid server-rendered block");
            return block.serverHtml();
          })
          .join("");
        return `<!--sol:s:${index}-->${content}<!--sol:e:${index}-->`;
      },
    );
    for (const region of fragment.regions) {
      if (region && !renderedRegions.has(region.index)) {
        throw new Error(`Missing server region metadata ${region.index}`);
      }
    }
    html = html.replaceAll(
      new RegExp(
        `<(script|style|textarea|title|select)\\b([^>]*\\x00sol:element:(\\d+)\\x00[^>]*)>([\\s\\S]*?)<\\/\\1>`,
        "gi",
      ),
      (whole, tag: string, attributes: string, serializedIndex: string, content: string) => {
        const element = fragment.elements[Number(serializedIndex)];
        if (!element || element.tag !== tag.toLowerCase()) {
          throw new Error(`Invalid server element metadata ${serializedIndex}`);
        }
        return `<${tag}${attributes}>${renderSpecialElementContent(element, content, fragment.elements)}</${tag}>`;
      },
    );
    html = html.replaceAll(
      new RegExp("\\x00sol:element:(\\d+)\\x00", "g"),
      (_slot, serializedIndex: string) => {
        const element = fragment.elements[Number(serializedIndex)];
        if (!element) throw new Error(`Invalid server element metadata ${serializedIndex}`);
        return renderedAttributeSlot(element);
      },
    );
    return `<!--sol:block:start:${fragment.definition.signature}-->${html}<!--sol:block:end-->`;
  };
  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    runCleanups(cleanups);
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
      runDisposals([
        cleanup,
        () => {
          if (parent) parent.blocks = parent.blocks.filter((block) => block !== this);
        },
      ]);
      return undefined;
    },
    dispose() {
      runDisposals([
        cleanup,
        () => {
          if (parent) parent.blocks = parent.blocks.filter((block) => block !== this);
        },
      ]);
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
    serverHtml: () => `<!--sol:block:start-->${value}<!--sol:block:end-->`,
  };
  return block;
}

export function serverRawValue(value: string): Block {
  const block = serverValueBlock(value) as Block & ServerRenderable;
  Object.defineProperty(block, "serverHtml", { value: () => value });
  return block;
}
