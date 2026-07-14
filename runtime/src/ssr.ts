import type { Component } from "./components.ts";
import { isObject, reactive } from "./reactivity.ts";
import {
  getFactory,
  readonlyProps,
  resolvedBlock,
  type Block,
  type RenderFrame,
} from "./rendering.ts";
import { serializeGraph } from "./serialization.ts";
import { isServerBlock, mountServerBlock, type ServerRegion } from "./server-rendering.ts";
import { SsrSession } from "./ssr-session.ts";

export interface RenderToStringOptions {
  readonly timeoutMs?: number;
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
  if (props != null && (!isObject(props) || Array.isArray(props))) {
    throw new TypeError("renderToStringAsync() props must be an object");
  }
  if (!isObject(options) || Array.isArray(options)) {
    throw new TypeError("renderToStringAsync() options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "timeoutMs") throw new TypeError(`Unknown renderToStringAsync() option ${key}`);
  }
  const timeoutMs = validateTimeout(options.timeoutMs, "renderToStringAsync() timeoutMs");
  const session = new SsrSession();
  const frame: RenderFrame = {
    owner: [],
    contexts: new Map(),
    mode: "server",
    ssr: session,
    timeoutMs,
  };
  const initialProps = readonlyProps(reactive({ ...props }) as Props & object);
  const root: ServerRegion = { kind: "server-region", index: -1, blocks: [] };
  let rendered: Block | undefined;
  try {
    rendered = resolvedBlock(getFactory(candidate)(initialProps, frame), frame);
    mountServerBlock(rendered, root);
    await session.wait(timeoutMs);
    const html = root.blocks
      .map((block) => {
        if (!isServerBlock(block)) throw new Error("Invalid Solix server root block");
        return block.serverHtml();
      })
      .join("");
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
    return `${html}<script type="application/json" data-solix-hydration>${payload}</script>`;
  } finally {
    rendered?.dispose();
  }
}
