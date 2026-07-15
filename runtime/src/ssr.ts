import type { Component } from "./components.ts";
import { clearServerQueryCache } from "./queries.ts";
import {
  isObject,
  isPromiseLike,
  reactive,
  rethrowWithDisposals,
  runDisposals,
} from "./reactivity.ts";
import {
  assertComponentProps,
  getFactory,
  prepareServerRender,
  readonlyProps,
  resolvedBlock,
  rootFrame,
  type Block,
  type RenderFrame,
} from "./rendering.ts";
import { serializeGraph } from "./serialization.ts";
import { isServerBlock, mountServerBlock, type ServerRegion } from "./server-rendering.ts";
import { SsrSession } from "./ssr-session.ts";

export interface RenderToStringOptions {
  readonly timeoutMs?: number;
  readonly onHead?: (html: string) => void;
  readonly url?: string | URL;
}

export const DEFAULT_SSR_TIMEOUT = 5_000;

function finalTemplateOrder(markup: string): string[] {
  const signatures: string[] = [];
  const lowercaseMarkup = markup.toLowerCase();
  const rawTextElements = new Set(["script", "style", "textarea", "title"]);
  let offset = 0;
  while (offset < markup.length) {
    const opening = markup.indexOf("<", offset);
    if (opening < 0) break;
    if (markup.startsWith("<!--", opening)) {
      const closing = markup.indexOf("-->", opening + 4);
      if (closing < 0) break;
      const comment = markup.slice(opening + 4, closing);
      const match = /^sol:block:start:(t[a-z0-9]+)$/.exec(comment);
      if (match) signatures.push(match[1]!);
      offset = closing + 3;
      continue;
    }
    let quote: '"' | "'" | undefined;
    let closing = opening + 1;
    for (; closing < markup.length; closing += 1) {
      const character = markup[closing]!;
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (closing >= markup.length) break;
    const tag = /^<\s*([a-z][\w:-]*)/i.exec(markup.slice(opening, closing + 1))?.[1]?.toLowerCase();
    if (
      tag &&
      rawTextElements.has(tag) &&
      !markup.slice(opening, closing).trimEnd().endsWith("/")
    ) {
      const rawClosing = lowercaseMarkup.indexOf(`</${tag}`, closing + 1);
      if (rawClosing < 0) break;
      const rawClosingEnd = markup.indexOf(">", rawClosing + tag.length + 2);
      if (rawClosingEnd < 0) break;
      offset = rawClosingEnd + 1;
      continue;
    }
    offset = closing + 1;
  }
  return signatures;
}

export function validateTimeout(value: unknown, label = "timeoutMs"): number {
  if (value === undefined) return DEFAULT_SSR_TIMEOUT;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

export async function renderToStringAsync<Props extends object>(
  candidate: Component<Props>,
  props?: Props,
  options: RenderToStringOptions = {},
): Promise<string> {
  assertComponentProps(props, "renderToStringAsync()");
  if (!isObject(options) || Array.isArray(options)) {
    throw new TypeError("renderToStringAsync() options must be an object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key !== "timeoutMs" && key !== "onHead" && key !== "url") {
      throw new TypeError(`Unknown renderToStringAsync() option ${String(key)}`);
    }
  }
  const optionValue = (key: keyof RenderToStringOptions): unknown => {
    if (!Object.hasOwn(descriptors, key)) return undefined;
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor)) {
      throw new TypeError(`renderToStringAsync() option ${key} must be a data property`);
    }
    return descriptor.value;
  };
  const onHead = optionValue("onHead");
  const configuredUrl = optionValue("url");
  const configuredTimeout = optionValue("timeoutMs");
  if (onHead !== undefined && typeof onHead !== "function") {
    throw new TypeError("renderToStringAsync() onHead must be a function");
  }
  let url: URL | undefined;
  if (configuredUrl !== undefined) {
    try {
      url = new URL(configuredUrl as string | URL);
    } catch {
      throw new TypeError("renderToStringAsync() url must be an absolute URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("renderToStringAsync() url must use http or https");
    }
  }
  const timeoutMs = validateTimeout(configuredTimeout, "renderToStringAsync() timeoutMs");
  const session = new SsrSession();
  const frame: RenderFrame = {
    ...rootFrame(),
    mode: "server",
    ssr: session,
    timeoutMs,
    url,
  };
  const initialProps = readonlyProps(reactive({ ...props }) as Props & object);
  const root: ServerRegion = { kind: "server-region", index: -1, blocks: [] };
  let rendered: Block | undefined;
  const disposals = [() => rendered?.dispose(), () => clearServerQueryCache(session)];
  let result: string;
  try {
    const preparation = prepareServerRender(frame);
    if (isPromiseLike(preparation)) await preparation;
    rendered = resolvedBlock(getFactory(candidate)(initialProps, frame), frame);
    mountServerBlock(rendered, root);
    await session.wait(timeoutMs);
    const html = root.blocks
      .map((block) => {
        if (!isServerBlock(block)) throw new Error("Invalid Sol server root block");
        return block.serverHtml();
      })
      .join("");
    const head = session.headHtml();
    if (head && !onHead) {
      throw new Error("renderToStringAsync() rendered Head content without an onHead callback");
    }
    session.templates.splice(0, session.templates.length, ...finalTemplateOrder(html + head));
    for (const entry of session.async) {
      if (entry.status === "pending") continue;
      try {
        serializeGraph(entry.value);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new TypeError(`Cannot serialize async site ${entry.site}: ${detail}`, {
          cause: error,
        });
      }
    }
    const payload = serializeGraph(session.payload());
    result = `${html}<script type="application/json" data-sol-hydration>${payload}</script>`;
    (onHead as ((html: string) => void) | undefined)?.(head);
  } catch (error) {
    rethrowWithDisposals(error, disposals, "Server render and teardown both failed");
  }
  runDisposals(disposals);
  return result;
}
