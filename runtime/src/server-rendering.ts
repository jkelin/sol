import type { Block, TemplateDefinition } from "./rendering.ts";
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
  for (const index of definition.metadata.regions) {
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

function regionSlot(index: number): string {
  return `\0sol:region:${index}\0`;
}

function prepareElementSlots(html: string, elements: ServerElement[]): string {
  const found = new Set<number>();
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
    const match = /^data-sol-e="(\d+)"(?=\s|\/?>)/.exec(html.slice(index));
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

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

function optionValue(attributes: string, content: string): string {
  const match = /\svalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
  if (match) return decodeHtml(match[1] ?? match[2] ?? match[3] ?? "");
  const text = decodeHtml(content.replaceAll(/<!--[\s\S]*?-->|<[^>]*>/g, ""));
  return text.replaceAll(/[\t\n\f\r ]+/g, " ").trim();
}

function renderAttributes(html: string, element: ServerElement): string {
  const marker = `data-sol-e="${element.index}"`;
  const dynamic = [...element.attributes]
    .filter(
      ([name]) => !(name === "value" && (element.tag === "textarea" || element.tag === "select")),
    )
    .flatMap(([name, value]) =>
      value === undefined ? [] : [value === true ? name : `${name}="${escapeAttribute(value)}"`],
    )
    .join(" ");
  return html.replace(elementSlot(element.index), `${dynamic ? `${dynamic} ` : ""}${marker}`);
}

function renderTextareaValue(html: string, element: ServerElement): string {
  const value = element.attributes.get("value");
  if (element.tag !== "textarea" || typeof value !== "string") return html;
  const marker = elementSlot(element.index);
  const markerIndex = html.indexOf(marker);
  const contentStart = html.indexOf(">", markerIndex) + 1;
  const contentEnd = html.indexOf("</textarea>", contentStart);
  if (markerIndex < 0 || contentStart === 0 || contentEnd < 0) {
    throw new Error(`Invalid server textarea metadata ${element.index}`);
  }
  return `${html.slice(0, contentStart)}${escapeText(value)}${html.slice(contentEnd)}`;
}

function renderRawTextValue(html: string, element: ServerElement): string {
  if (element.textContent === undefined) return html;
  const marker = elementSlot(element.index);
  const markerIndex = html.indexOf(marker);
  const contentStart = html.indexOf(">", markerIndex) + 1;
  const closingTag = `</${element.tag}>`;
  const contentEnd = html.indexOf(closingTag, contentStart);
  if (markerIndex < 0 || contentStart === 0 || contentEnd < 0) {
    throw new Error(`Invalid server raw-text metadata ${element.index}`);
  }
  const value =
    element.tag === "script" || element.tag === "style"
      ? element.textContent
      : escapeText(element.textContent);
  return `${html.slice(0, contentStart)}${value}${html.slice(contentEnd)}`;
}

function renderSelectValue(html: string, element: ServerElement): string {
  const value = element.attributes.get("value");
  if (element.tag !== "select" || typeof value !== "string") return html;
  const marker = elementSlot(element.index);
  const markerIndex = html.indexOf(marker);
  const contentStart = html.indexOf(">", markerIndex) + 1;
  const contentEnd = html.indexOf("</select>", contentStart);
  if (markerIndex < 0 || contentStart === 0 || contentEnd < 0) {
    throw new Error(`Invalid server select metadata ${element.index}`);
  }
  const content = html
    .slice(contentStart, contentEnd)
    .replaceAll(
      /<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi,
      (option, attributes: string, optionContent: string) => {
        const withoutSelected = attributes.replace(
          /\sselected(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i,
          "",
        );
        const selected = optionValue(withoutSelected, optionContent) === value ? " selected" : "";
        return `<option${withoutSelected}${selected}>${optionContent}</option>`;
      },
    );
  return `${html.slice(0, contentStart)}${content}${html.slice(contentEnd)}`;
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
    for (const region of fragment.regions) {
      if (!region) continue;
      const marker = `<!--sol:s:${region.index}--><!--sol:e:${region.index}-->`;
      if (!html.includes(marker)) throw new Error(`Missing server region metadata ${region.index}`);
      html = html.replace(marker, regionSlot(region.index));
    }
    for (const region of fragment.regions) {
      if (!region) continue;
      const content = region.blocks
        .map((block) => {
          if (!isServerBlock(block)) throw new Error("Invalid server-rendered block");
          return block.serverHtml();
        })
        .join("");
      html = html.replace(
        regionSlot(region.index),
        `<!--sol:s:${region.index}-->${content}<!--sol:e:${region.index}-->`,
      );
    }
    for (const element of fragment.elements) {
      if (!element || element.textContent === undefined) continue;
      html = renderRawTextValue(html, element);
    }
    for (const element of fragment.elements) {
      if (element && element.tag !== "select" && element.tag !== "textarea") {
        html = renderAttributes(html, element);
      }
    }
    for (const element of fragment.elements) {
      if (!element || element.tag !== "textarea") continue;
      html = renderTextareaValue(html, element);
      html = renderAttributes(html, element);
    }
    for (const element of fragment.elements) {
      if (!element || element.tag !== "select") continue;
      html = renderSelectValue(html, element);
      html = renderAttributes(html, element);
    }
    return `<!--sol:block:start:${fragment.definition.signature}-->${html}<!--sol:block:end-->`;
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
    serverHtml: () => `<!--sol:block:start-->${value}<!--sol:block:end-->`,
  };
  return block;
}

export function serverRawValue(value: string): Block {
  const block = serverValueBlock(value) as Block & ServerRenderable;
  Object.defineProperty(block, "serverHtml", { value: () => value });
  return block;
}
