import { runtimeEffect } from "./reactivity.ts";
import type { JSX } from "./jsx-runtime.ts";
import type { Block, BlockLifecycle, Cleanup, RenderFactory, RenderFrame } from "./rendering.ts";

export interface PortalProps {
  readonly target: Element;
  readonly children?: JSX.Child | readonly JSX.Child[];
}

export interface GlobalPortalProps {
  readonly children?: JSX.Child | readonly JSX.Child[];
}

export const Portal = (() => {
  throw new Error("Portal must be rendered as JSX inside a compiled component");
}) as (props: Readonly<PortalProps>) => JSX.Element;

export const GlobalPortal = (() => {
  throw new Error("GlobalPortal must be rendered as JSX inside a compiled component");
}) as (props: Readonly<GlobalPortalProps>) => JSX.Element;

function validateTarget(target: unknown, name: "Portal" | "GlobalPortal"): Element {
  if (!target || !(target instanceof Element)) {
    throw new TypeError(`${name} target must be a DOM Element`);
  }
  return target;
}

function mountPortal(
  getTarget: () => unknown,
  render: RenderFactory,
  cleanups: Cleanup[],
  lifecycle: BlockLifecycle,
  frame: RenderFrame,
  name: "Portal" | "GlobalPortal",
): void {
  lifecycle.portalMounts.push(() => {
    const rendered: Block = render(
      frame.mode === "hydrate" && !frame.hydration?.committed
        ? { ...frame, mode: "resume", claim: undefined }
        : frame,
    );
    lifecycle.remoteBlocks.push(rendered);
    let target: Element | undefined;
    const stop = runtimeEffect(() => {
      const nextTarget = validateTarget(getTarget(), name);
      if (!target) {
        rendered.mount(nextTarget);
        target = nextTarget;
        return;
      }
      if (nextTarget === target) return;
      rendered.move(nextTarget);
      target = nextTarget;
    });
    cleanups.push(stop);
  });
}

export function portal(
  getTarget: () => unknown,
  render: RenderFactory,
  cleanups: Cleanup[],
  lifecycle: BlockLifecycle,
  frame: RenderFrame,
): void {
  if (typeof getTarget !== "function") throw new TypeError("Portal expects a target getter");
  if (typeof render !== "function") throw new TypeError("Portal expects a render factory");
  mountPortal(getTarget, render, cleanups, lifecycle, frame, "Portal");
}

export function globalPortal(
  render: RenderFactory,
  cleanups: Cleanup[],
  lifecycle: BlockLifecycle,
  frame: RenderFrame,
): void {
  if (typeof render !== "function") throw new TypeError("GlobalPortal expects a render factory");
  mountPortal(
    () => (typeof document === "undefined" ? undefined : document.body),
    render,
    cleanups,
    lifecycle,
    frame,
    "GlobalPortal",
  );
}
