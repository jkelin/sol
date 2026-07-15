import { devtoolsLoaderCreated, devtoolsLoaderUpdated } from "./devtools-hook.ts";
import { isPromiseLike, rethrowWithDisposals, runDisposals, runtimeEffect } from "./reactivity.ts";
import { asyncValue, HydrationMismatchError } from "./ssr-session.ts";
import { isServerRegion, mountServerBlock } from "./server-rendering.ts";
import { validateTimerDelay } from "./timers.ts";
import { regionHydrationClaim } from "./hydration-rendering.ts";
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

function rejectHydrationMismatch(frame: RenderFrame, error: unknown): boolean {
  if (!(error instanceof HydrationMismatchError)) return false;
  frame.hydration?.fail(error);
  return true;
}

function mountOwnedResult(block: Block, mount: (block: Block) => void, label: string): Block {
  try {
    mount(block);
  } catch (error) {
    rethrowWithDisposals(error, [() => block.dispose()], `${label} mount and rollback both failed`);
  }
  return block;
}

function errorWithTeardown(error: unknown, current: Block | undefined, message: string): unknown {
  if (!current) return error;
  try {
    current.dispose();
    return error;
  } catch (teardownError) {
    return new AggregateError([error, teardownError], message, { cause: error });
  }
}

function boundaryFallbackError(error: unknown, current: Block | undefined): unknown {
  return errorWithTeardown(error, current, "ErrorBoundary child and teardown both failed");
}

export function suspense(
  region: Region,
  render: RenderFactory,
  renderFallback: RenderFactory,
  renderError: ErrorRenderFactory | undefined,
  cleanups: Cleanup[],
  frame: RenderFrame,
  timeoutMs?: number,
): void {
  if (timeoutMs !== undefined) validateTimerDelay(timeoutMs, "Suspense timeoutMs");
  const hydrationClaim = regionHydrationClaim(region);
  if (frame.mode === "hydrate" && frame.hydration && hydrationClaim && !isServerRegion(region)) {
    const state = frame.hydration.claimBoundary();
    const parking = document.createDocumentFragment();
    const claimFrame: RenderFrame = { ...frame, claim: hydrationClaim };
    const resumeFrame: RenderFrame = {
      ...frame,
      mode: "resume",
      claim: undefined,
      waitForResume: state === "error",
    };
    let pending = 0;
    let failed = false;
    let content: Block | undefined;
    let visible: Block | undefined;
    const show = (next: Block): void => {
      if (visible === next) return;
      visible?.dispose();
      visible = next;
      next.mount(region.end.parentNode!, region.end);
    };
    const controller: SuspenseController = {
      begin() {
        pending += 1;
        let finished = false;
        return () => {
          if (finished) return;
          finished = true;
          pending -= 1;
          if (pending === 0 && !failed && state === "timeout" && content) {
            try {
              show(content);
            } catch (error) {
              controller.reject(error);
            }
          }
        };
      },
      reject(error) {
        if (failed) return;
        failed = true;
        const failedContent = content;
        const reportedError = errorWithTeardown(
          error,
          failedContent,
          "Suspense content and teardown both failed",
        );
        if (visible === failedContent) visible = undefined;
        content = undefined;
        if (rejectHydrationMismatch(frame, reportedError)) return;
        if (renderError) {
          const errorFrame = state === "error" ? claimFrame : resumeFrame;
          try {
            show(renderError(reportedError, errorFrame));
          } catch (renderFailure) {
            reportError(frame, renderFailure);
          }
        } else if (frame.suspense) frame.suspense.reject(reportedError);
        else if (frame.handleError) frame.handleError(reportedError);
        else surfaceAsyncError(reportedError);
      },
    };
    try {
      if (state === "resolved") {
        content = render({ ...claimFrame, suspense: controller });
        visible = content;
        content.mount(region.end.parentNode!, region.end);
      } else {
        content = render({ ...resumeFrame, suspense: controller });
        content.mount(parking);
        if (state === "timeout") {
          visible = renderFallback(claimFrame);
          visible.mount(region.end.parentNode!, region.end);
          if (pending === 0) show(content);
        }
      }
    } catch (error) {
      controller.reject(error);
    }
    cleanups.push(() => {
      runDisposals([
        () => visible?.dispose(),
        () => {
          if (content && content !== visible) content.dispose();
        },
      ]);
    });
    return;
  }
  if (isServerRegion(region)) {
    const serverTimeout = timeoutMs ?? frame.timeoutMs ?? 5_000;
    validateTimerDelay(serverTimeout, "Suspense timeoutMs");
    let pending = 0;
    let failed = false;
    let timedOut = false;
    let content: Block | undefined;
    let visible: Block | undefined;
    let rerenderOnResolve = false;
    const boundary = frame.ssr?.beginBoundary(
      serverTimeout,
      (renderTimeoutFallback) => {
        timedOut = true;
        if (failed || !renderTimeoutFallback) return;
        try {
          show(renderFallback(frame));
        } catch (error) {
          failed = true;
          if (frame.handleError) frame.handleError(error);
          else frame.ssr?.fail(error);
        }
      },
      frame.ssrBoundary,
    );
    const show = (next: Block): void => {
      if (visible && visible !== next) visible.dispose();
      visible = next;
      mountServerBlock(next, region, true);
    };
    const controller: SuspenseController = {
      begin(rerenderOnServer = false) {
        rerenderOnResolve ||= rerenderOnServer;
        pending += 1;
        let finished = false;
        return () => {
          if (finished) return;
          finished = true;
          pending -= 1;
          if (pending === 0 && !failed && !timedOut && content) {
            try {
              if (rerenderOnResolve) {
                content.dispose();
                content = render({ ...contentFrame, ssrRerender: true });
              }
              show(content);
              boundary?.finish();
            } catch (error) {
              controller.reject(error);
            }
          }
        };
      },
      reject(error) {
        if (failed || timedOut) return;
        failed = true;
        if (boundary) frame.ssr?.markBoundaryError(boundary.index);
        if (renderError) {
          try {
            show(renderError(error, frame));
          } catch (renderFailure) {
            reportError(frame, renderFailure);
          }
        } else if (frame.suspense) frame.suspense.reject(error);
        else if (frame.handleError) frame.handleError(error);
        else frame.ssr?.fail(error);
        boundary?.finish();
      },
    };
    const contentFrame: RenderFrame = {
      ...frame,
      suspense: controller,
      ssrBoundary: boundary?.index,
    };
    try {
      content = render(contentFrame);
      if (pending === 0) {
        show(content);
        boundary?.finish();
      } else {
        show(renderFallback(frame));
      }
    } catch (error) {
      controller.reject(error);
    }
    cleanups.push(() => {
      runDisposals([
        () => visible?.dispose(),
        () => {
          if (content && content !== visible) content.dispose();
        },
        () => boundary?.finish(),
      ]);
    });
    return;
  }
  if (frame.mode === "resume" && frame.hydration) frame.hydration.claimBoundary();
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
        if (initialized && pending === 0 && !failed && content) {
          try {
            show(content);
          } catch (error) {
            controller.reject(error);
          }
        }
      };
    },
    reject(error) {
      if (failed) return;
      failed = true;
      let reportedError = error;
      if (renderError) {
        if (content) {
          const failedContent = content;
          reportedError = errorWithTeardown(
            error,
            failedContent,
            "Suspense content and teardown both failed",
          );
          if (visible === failedContent) visible = undefined;
          content = undefined;
        }
        try {
          show(renderError(reportedError, frame));
        } catch (renderFailure) {
          reportError(frame, renderFailure);
        }
      } else if (frame.suspense) frame.suspense.reject(reportedError);
      else if (frame.handleError) frame.handleError(reportedError);
      else surfaceAsyncError(reportedError);
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
    runDisposals([
      () => visible?.dispose(),
      () => {
        if (content && content !== visible) content.dispose();
      },
    ]);
  });
}

export function awaitBlock<T>(
  region: Region,
  getPromise: () => PromiseLike<T>,
  render: (value: T, frame: RenderFrame) => Block,
  renderError: ErrorRenderFactory | undefined,
  cleanups: Cleanup[],
  frame: RenderFrame,
  site = "await",
): void {
  if (isServerRegion(region)) {
    let candidate: PromiseLike<T>;
    try {
      candidate = asyncValue(frame, site, getPromise, true);
    } catch (error) {
      reportError(frame, error);
      return;
    }
    if (!isPromiseLike(candidate)) throw new TypeError("Await $promise must be promise-like");
    const finish = frame.suspense?.begin() ?? frame.ssr?.beginRoot();
    let current: Block | undefined;
    let disposed = false;
    void Promise.resolve(candidate).then(
      (value) => {
        if (disposed) return finish?.();
        try {
          current = mountOwnedResult(
            render(value, frame),
            (next) => mountServerBlock(next, region, true),
            "Await",
          );
        } catch (error) {
          if (renderError) {
            try {
              current = mountOwnedResult(
                renderError(error, frame),
                (next) => mountServerBlock(next, region, true),
                "Await error",
              );
            } catch (renderFailure) {
              reportError(frame, renderFailure);
            }
          } else reportError(frame, error);
        }
        finish?.();
      },
      (error) => {
        if (!disposed) {
          if (renderError) {
            try {
              current = mountOwnedResult(
                renderError(error, frame),
                (next) => mountServerBlock(next, region, true),
                "Await error",
              );
            } catch (renderFailure) {
              reportError(frame, renderFailure);
            }
          } else reportError(frame, error);
        }
        finish?.();
      },
    );
    cleanups.push(() => {
      disposed = true;
      current?.dispose();
      finish?.();
    });
    return;
  }
  let generation = 0;
  let current: Block | undefined;
  let currentFinish: (() => void) | undefined;
  let activeLoader = 0;
  let disposed = false;
  const showError = (error: unknown): void => {
    if (rejectHydrationMismatch(frame, error)) return;
    if (!renderError) return reportError(frame, error);
    try {
      const claim = regionHydrationClaim(region);
      current = mountOwnedResult(
        renderError(error, claim ? { ...frame, claim } : frame),
        (next) => next.mount(region.end.parentNode!, region.end),
        "Await error",
      );
    } catch (renderFailure) {
      reportError(frame, renderFailure);
    }
  };
  const stop = runtimeEffect(() => {
    const promise = frame.hydration ? asyncValue(frame, site, getPromise, true) : getPromise();
    if (!isPromiseLike(promise)) throw new TypeError("Await $promise must be promise-like");
    const currentGeneration = ++generation;
    devtoolsLoaderUpdated(activeLoader, { isLoading: false, isCancelled: true });
    const loaderId = devtoolsLoaderCreated(`Await ${site}`, []);
    activeLoader = loaderId;
    devtoolsLoaderUpdated(loaderId, { isLoading: true });
    currentFinish?.();
    current?.dispose();
    current = undefined;
    const finish = frame.suspense?.begin();
    currentFinish = finish;
    Promise.resolve(promise).then(
      (value) => {
        if (disposed || currentGeneration !== generation) return finish?.();
        devtoolsLoaderUpdated(loaderId, { isLoading: false, hasData: true, data: value });
        if (activeLoader === loaderId) activeLoader = 0;
        try {
          const claim = regionHydrationClaim(region);
          current = mountOwnedResult(
            render(value, claim ? { ...frame, claim } : frame),
            (next) => next.mount(region.end.parentNode!, region.end),
            "Await",
          );
        } catch (error) {
          showError(error);
        }
        finish?.();
        if (currentFinish === finish) currentFinish = undefined;
      },
      (error) => {
        if (disposed || currentGeneration !== generation) return finish?.();
        devtoolsLoaderUpdated(loaderId, { isLoading: false, isFailed: true, error });
        if (activeLoader === loaderId) activeLoader = 0;
        showError(error);
        finish?.();
        if (currentFinish === finish) currentFinish = undefined;
      },
    );
  });
  cleanups.push(stop, () => {
    disposed = true;
    generation += 1;
    devtoolsLoaderUpdated(activeLoader, { isLoading: false, isCancelled: true });
    activeLoader = 0;
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
  const hydrationClaim = regionHydrationClaim(region);
  if (frame.mode === "hydrate" && frame.hydration && hydrationClaim && !isServerRegion(region)) {
    const state = frame.hydration.claimBoundary();
    const claimFrame: RenderFrame = { ...frame, claim: hydrationClaim };
    const resumeFrame: RenderFrame = {
      ...frame,
      mode: "resume",
      claim: undefined,
      waitForResume: state === "error",
    };
    let current: Block | undefined;
    let failed = false;
    const fail = (error: unknown): void => {
      if (failed) return;
      failed = true;
      if (rejectHydrationMismatch(frame, error)) return;
      const fallbackError = boundaryFallbackError(error, current);
      current = undefined;
      try {
        current = mountOwnedResult(
          renderFallback(fallbackError, state === "error" ? claimFrame : resumeFrame),
          (next) => next.mount(region.end.parentNode!, region.end),
          "ErrorBoundary fallback",
        );
      } catch (replacementError) {
        if (frame.handleError) frame.handleError(replacementError);
        else surfaceAsyncError(replacementError);
      }
    };
    try {
      current = render({ ...(state === "error" ? resumeFrame : claimFrame), handleError: fail });
      if (state !== "error") current.mount(region.end.parentNode!, region.end);
    } catch (error) {
      fail(error);
    }
    cleanups.push(() => current?.dispose());
    return;
  }
  if (isServerRegion(region)) {
    const boundaryIndex = frame.ssr?.recordBoundary();
    let current: Block | undefined;
    let failed = false;
    const fail = (error: unknown): void => {
      if (failed) return;
      failed = true;
      if (boundaryIndex !== undefined) frame.ssr?.markBoundaryError(boundaryIndex);
      const fallbackError = boundaryFallbackError(error, current);
      current = undefined;
      try {
        current = mountOwnedResult(
          renderFallback(fallbackError, frame),
          (next) => mountServerBlock(next, region, true),
          "ErrorBoundary fallback",
        );
      } catch (replacementError) {
        if (frame.handleError) frame.handleError(replacementError);
        else frame.ssr?.fail(replacementError);
      }
    };
    try {
      current = render({ ...frame, handleError: fail });
      mountServerBlock(current, region, true);
    } catch (error) {
      fail(error);
    }
    cleanups.push(() => current?.dispose());
    return;
  }
  if (frame.mode === "resume" && frame.hydration) frame.hydration.claimBoundary();
  let current: Block | undefined;
  let failed = false;
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    const fallbackError = boundaryFallbackError(error, current);
    current = undefined;
    try {
      current = mountOwnedResult(
        renderFallback(fallbackError, frame),
        (next) => next.mount(region.end.parentNode!, region.end),
        "ErrorBoundary fallback",
      );
    } catch (replacementError) {
      if (frame.handleError) frame.handleError(replacementError);
      else surfaceAsyncError(replacementError);
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
