import type { Component } from "./components.ts";
import { headHydrationClaims, rootHydrationClaim } from "./hydration-rendering.ts";
import { isObject, isPromiseLike, reactive, rethrowWithDisposals } from "./reactivity.ts";
import {
  activateMounts,
  assertComponentProps,
  getFactory,
  readonlyProps,
  rootFrame,
  type Block,
  type RenderFrame,
} from "./rendering.ts";
import { deserializeGraph } from "./serialization.ts";
import { HydrationMismatchError, HydrationSession, type HydrationPayload } from "./ssr-session.ts";
import { isDomElement } from "./dom-realm.ts";

function hydrationPayload(value: unknown): HydrationPayload {
  if (!isObject(value) || Array.isArray(value)) {
    throw new TypeError("Invalid Sol hydration payload");
  }
  const keys = Object.keys(value).toSorted().join(",");
  if (
    keys !== "async,boundaries,templates,version" &&
    keys !== "async,boundaries,head,templates,version"
  ) {
    throw new TypeError("Invalid Sol hydration payload fields");
  }
  const payload = value as Partial<HydrationPayload>;
  if (
    typeof payload.version !== "number" ||
    !Array.isArray(payload.templates) ||
    !Array.isArray(payload.async) ||
    !Array.isArray(payload.boundaries)
  ) {
    throw new TypeError("Invalid Sol hydration payload");
  }
  if (
    payload.head !== undefined &&
    (!isObject(payload.head) ||
      Array.isArray(payload.head) ||
      Object.keys(payload.head).toSorted().join(",") !== "count,id" ||
      typeof payload.head.id !== "string" ||
      !Number.isInteger(payload.head.count) ||
      payload.head.count < 1)
  ) {
    throw new TypeError("Invalid Sol hydration Head payload");
  }
  return payload as HydrationPayload;
}

function templateSignatures(target: Element): string[] {
  const signatures: string[] = [];
  const showComment = target.ownerDocument.defaultView?.NodeFilter.SHOW_COMMENT ?? 128;
  const walker = target.ownerDocument.createTreeWalker(target, showComment);
  while (walker.nextNode()) {
    const match = /^sol:block:start:(t[a-z0-9]+)$/.exec((walker.currentNode as Comment).data);
    if (match) signatures.push(match[1]!);
  }
  return signatures;
}

export async function hydrate<Props extends object>(
  candidate: Component<Props>,
  target: Element,
  props?: Props,
): Promise<() => void> {
  if (!isDomElement(target)) {
    throw new TypeError("hydrate() expects a DOM Element target");
  }
  assertComponentProps(props, "hydrate()");
  const factory = getFactory(candidate);
  const scripts = [...target.querySelectorAll<HTMLScriptElement>("script[data-sol-hydration]")];
  if (scripts.length !== 1) {
    throw new Error(
      scripts.length === 0
        ? "Sol hydration payload is missing"
        : "Sol hydration payload must appear exactly once",
    );
  }
  const script = scripts[0]!;
  if (script.type !== "application/json") {
    throw new Error('Sol hydration payload script must use type="application/json"');
  }
  const payload = hydrationPayload(deserializeGraph(script.textContent ?? ""));
  const session = new HydrationSession(payload);
  const documentHeadClaims = payload.head
    ? headHydrationClaims(target.ownerDocument.head, payload.head.id, payload.head.count)
    : [];
  session.validateTemplateOrder([
    ...templateSignatures(target),
    ...documentHeadClaims.flatMap((headClaim) => headClaim.signatures),
  ]);
  const claim = rootHydrationClaim(target);
  const frame: RenderFrame = {
    ...rootFrame(),
    mode: "hydrate",
    hydration: session,
    claim,
    headClaims: documentHeadClaims.toSorted((left, right) => left.index - right.index),
  };
  const initialProps = readonlyProps(reactive({ ...props }) as Props & object);
  let rendered: Block | undefined;
  try {
    const result = factory(initialProps, frame);
    rendered = isPromiseLike(result) ? await session.track(result) : result;
    rendered.mount(target);
    await session.wait();
    if (frame.headClaims?.length) {
      throw new HydrationMismatchError("did not consume every server Head block");
    }
    if (claim.cursor !== script) {
      throw new HydrationMismatchError("unexpected root nodes");
    }
    activateMounts(frame);
    session.commit();
    for (const element of target.querySelectorAll("[data-sol-e]")) {
      element.removeAttribute("data-sol-e");
    }
    for (const headClaim of documentHeadClaims) {
      for (
        let node = headClaim.start.nextSibling;
        node && node !== headClaim.end;
        node = node.nextSibling
      ) {
        if (!isDomElement(node)) continue;
        node.removeAttribute("data-sol-e");
        for (const element of node.querySelectorAll("[data-sol-e]")) {
          element.removeAttribute("data-sol-e");
        }
      }
    }
    script.remove();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      rendered?.dispose();
    };
  } catch (error) {
    session.fail(error);
    const failedRender = rendered;
    return rethrowWithDisposals(
      error,
      failedRender ? [() => failedRender.dispose()] : [],
      "Hydration and teardown both failed",
    );
  }
}
