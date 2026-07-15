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
    session.templates.length = 0;
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
    let payload: string;
    try {
      payload = serializeGraph(session.payload());
    } catch (payloadError) {
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
      throw payloadError;
    }
    result = `${html}<script type="application/json" data-sol-hydration>${payload}</script>`;
    (onHead as ((html: string) => void) | undefined)?.(head);
  } catch (error) {
    rethrowWithDisposals(error, disposals, "Server render and teardown both failed");
  }
  runDisposals(disposals);
  return result;
}
