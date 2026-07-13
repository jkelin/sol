import { isPromiseLike, runtimeEffect } from "./reactivity.ts";
import {
  reportError,
  surfaceAsyncError,
  type Block,
  type Cleanup,
  type ErrorRenderFactory,
  type Region,
  type RenderFactory,
  type RenderFrame,
  type SuspenseController,
} from "./rendering.ts";

export function suspense(
  region: Region,
  render: RenderFactory,
  renderFallback: RenderFactory,
  renderError: ErrorRenderFactory | undefined,
  cleanups: Cleanup[],
  frame: RenderFrame,
): void {
  let pending = 0;
  let initialized = false;
  let failed = false;
  let visible: Block | undefined;
  let content: Block | undefined;
  const parking = document.createDocumentFragment();
  const show = (next: Block): void => {
    if (visible === next) return;
    if (visible && visible === content) visible.move(parking);
    else visible?.dispose();
    visible = next;
    next.mount(region.end.parentNode!, region.end);
  };
  const controller: SuspenseController = {
    begin() {
      const wasIdle = pending === 0;
      pending += 1;
      if (initialized && wasIdle && !failed && visible === content) {
        try {
          show(renderFallback(frame));
        } catch (error) {
          controller.reject(error);
        }
      }
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        pending -= 1;
        if (initialized && pending === 0 && !failed && content) show(content);
      };
    },
    reject(error) {
      if (failed) return;
      failed = true;
      if (renderError) {
        if (content) {
          content.dispose();
          if (visible === content) visible = undefined;
        }
        try {
          show(renderError(error, frame));
        } catch (renderFailure) {
          reportError(frame, renderFailure);
        }
      } else if (frame.suspense) frame.suspense.reject(error);
      else if (frame.handleError) frame.handleError(error);
      else surfaceAsyncError(error);
    },
  };
  const contentFrame: RenderFrame = { ...frame, suspense: controller };
  try {
    content = render(contentFrame);
    initialized = true;
    show(pending > 0 ? renderFallback(frame) : content);
  } catch (error) {
    controller.reject(error);
  }
  cleanups.push(() => {
    visible?.dispose();
    if (content && content !== visible) content.dispose();
  });
}

export function awaitBlock<T>(
  region: Region,
  getPromise: () => PromiseLike<T>,
  render: (value: T, frame: RenderFrame) => Block,
  renderError: ErrorRenderFactory | undefined,
  cleanups: Cleanup[],
  frame: RenderFrame,
): void {
  let generation = 0;
  let current: Block | undefined;
  let currentFinish: (() => void) | undefined;
  let disposed = false;
  const showError = (error: unknown): void => {
    if (!renderError) return reportError(frame, error);
    try {
      current = renderError(error, frame);
      current.mount(region.end.parentNode!, region.end);
    } catch (renderFailure) {
      reportError(frame, renderFailure);
    }
  };
  const stop = runtimeEffect(() => {
    const promise = getPromise();
    if (!isPromiseLike(promise)) throw new TypeError("Await $promise must be promise-like");
    const currentGeneration = ++generation;
    currentFinish?.();
    current?.dispose();
    current = undefined;
    const finish = frame.suspense?.begin();
    currentFinish = finish;
    Promise.resolve(promise).then(
      (value) => {
        if (disposed || currentGeneration !== generation) return finish?.();
        try {
          current = render(value, frame);
          current.mount(region.end.parentNode!, region.end);
        } catch (error) {
          showError(error);
        }
        finish?.();
        if (currentFinish === finish) currentFinish = undefined;
      },
      (error) => {
        if (disposed || currentGeneration !== generation) return finish?.();
        showError(error);
        finish?.();
        if (currentFinish === finish) currentFinish = undefined;
      },
    );
  });
  cleanups.push(stop, () => {
    disposed = true;
    generation += 1;
    currentFinish?.();
    current?.dispose();
  });
}

export function errorBoundary(
  region: Region,
  render: RenderFactory,
  renderFallback: ErrorRenderFactory,
  cleanups: Cleanup[],
  frame: RenderFrame,
): void {
  let current: Block | undefined;
  let failed = false;
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    current?.dispose();
    try {
      current = renderFallback(error, frame);
      current.mount(region.end.parentNode!, region.end);
    } catch (fallbackError) {
      if (frame.handleError) frame.handleError(fallbackError);
      else surfaceAsyncError(fallbackError);
    }
  };
  const childFrame: RenderFrame = { ...frame, handleError: fail };
  try {
    current = render(childFrame);
    current.mount(region.end.parentNode!, region.end);
  } catch (error) {
    fail(error);
  }
  cleanups.push(() => current?.dispose());
}
