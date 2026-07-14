import type { Component } from "./components.ts";
import { rootHydrationClaim } from "./hydration-rendering.ts";
import { isObject, isPromiseLike, reactive } from "./reactivity.ts";
import { getFactory, readonlyProps, type Block, type RenderFrame } from "./rendering.ts";
import { deserializeGraph } from "./serialization.ts";
import { HydrationSession, type HydrationPayload } from "./ssr-session.ts";

function hydrationPayload(value: unknown): HydrationPayload {
  if (!isObject(value) || Array.isArray(value)) {
    throw new TypeError("Invalid Solix hydration payload");
  }
  const payload = value as Partial<HydrationPayload>;
  if (
    typeof payload.version !== "number" ||
    !Array.isArray(payload.templates) ||
    !Array.isArray(payload.async) ||
    !Array.isArray(payload.boundaries)
  ) {
    throw new TypeError("Invalid Solix hydration payload");
  }
  return payload as HydrationPayload;
}

function templateSignatures(target: Element): string[] {
  const signatures: string[] = [];
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) {
    const match = /^solix:block:start:(t[a-z0-9]+)$/.exec((walker.currentNode as Comment).data);
    if (match) signatures.push(match[1]!);
  }
  return signatures;
}

export async function hydrate<Props extends object>(
  candidate: Component<Props>,
  target: Element,
  props?: Props,
): Promise<() => void> {
  if (!target || target.nodeType !== Node.ELEMENT_NODE) {
    throw new TypeError("hydrate() expects a DOM Element target");
  }
  if (props != null && (!isObject(props) || Array.isArray(props))) {
    throw new TypeError("hydrate() props must be an object");
  }
  const factory = getFactory(candidate);
  const scripts = [...target.querySelectorAll<HTMLScriptElement>("script[data-solix-hydration]")];
  if (scripts.length !== 1) {
    throw new Error(
      scripts.length === 0
        ? "Solix hydration payload is missing"
        : "Solix hydration payload must appear exactly once",
    );
  }
  const script = scripts[0]!;
  if (script.type !== "application/json") {
    throw new Error('Solix hydration payload script must use type="application/json"');
  }
  const payload = hydrationPayload(deserializeGraph(script.textContent ?? ""));
  const session = new HydrationSession(payload);
  session.validateTemplateOrder(templateSignatures(target));
  const claim = rootHydrationClaim(target);
  const frame: RenderFrame = {
    owner: [],
    contexts: new Map(),
    mode: "hydrate",
    hydration: session,
    claim,
  };
  const initialProps = readonlyProps(reactive({ ...props }) as Props & object);
  let rendered: Block | undefined;
  try {
    const result = factory(initialProps, frame);
    rendered = isPromiseLike(result) ? await session.track(result) : result;
    rendered.mount(target);
    await session.wait();
    if (claim.cursor !== script) {
      throw new Error("Solix hydration mismatch: unexpected root nodes");
    }
    session.commit();
    for (const element of target.querySelectorAll("[data-solix-e]")) {
      element.removeAttribute("data-solix-e");
    }
    script.remove();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      rendered?.dispose();
    };
  } catch (error) {
    rendered?.dispose();
    throw error;
  }
}
