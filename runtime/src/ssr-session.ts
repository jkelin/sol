import type { Block } from "./rendering.ts";

export const HYDRATION_VERSION = 1;

export class HydrationMismatchError extends Error {
  constructor(message: string) {
    super(`Sol hydration mismatch: ${message}`);
    this.name = "HydrationMismatchError";
  }
}

let activeAsyncCapture = false;

export function asyncCaptureActive(): boolean {
  return activeAsyncCapture;
}

export function asyncCaptureCall<T>(thunk: () => T, capture: boolean): T {
  const previous = activeAsyncCapture;
  activeAsyncCapture = capture;
  try {
    return thunk();
  } finally {
    activeAsyncCapture = previous;
  }
}

export type AsyncEntry =
  | { readonly site: string; status: "pending" }
  | { readonly site: string; status: "fulfilled"; value: unknown }
  | { readonly site: string; status: "rejected"; value: unknown };

export interface HydrationPayload {
  readonly version: number;
  readonly templates: string[];
  readonly async: AsyncEntry[];
  readonly boundaries: ("resolved" | "timeout" | "error")[];
  readonly head?: { readonly id: string; readonly count: number };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class SsrSession {
  readonly templates: string[] = [];
  readonly async: AsyncEntry[] = [];
  readonly boundaries: ("resolved" | "timeout" | "error")[] = [];
  private readonly headBlocks: Array<{ readonly index: number; readonly block: Block }> = [];
  private readonly headId = Math.random().toString(36).slice(2);
  private headIndex = 0;
  private rootPending = 0;
  private boundaryPending = 0;
  private completion = deferred();
  private failed = false;
  private failure: unknown;
  private readonly boundaryEntries = new Map<
    number,
    Array<{ site: string; status: "pending" | "fulfilled" | "rejected"; value?: unknown }>
  >();
  private readonly boundaryControls = new Map<
    number,
    {
      readonly parent?: number;
      readonly onTimeout: (renderFallback: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
      settled: boolean;
    }
  >();

  recordTemplate(signature: string): void {
    this.templates.push(signature);
  }

  captureHead(block: Block): void {
    this.headBlocks.unshift({ index: this.headIndex++, block });
  }

  headHtml(): string {
    return this.headBlocks
      .map(({ index, block }) => {
        const render = (block as { serverHtml?: unknown }).serverHtml;
        if (typeof render !== "function") throw new Error("Invalid server-rendered Head block");
        return `<!--sol:head:start:${this.headId}:${index}-->${render.call(block)}<!--sol:head:end:${this.headId}:${index}-->`;
      })
      .join("");
  }

  capture<T>(
    site: string,
    thunk: () => T | PromiseLike<T>,
    requirePromiseLike = false,
    boundary?: number,
  ): Promise<T> {
    const entry: { site: string; status: "pending" | "fulfilled" | "rejected"; value?: unknown } = {
      site,
      status: "pending",
    };
    this.async.push(entry as AsyncEntry);
    if (boundary !== undefined) {
      const entries = this.boundaryEntries.get(boundary) ?? [];
      entries.push(entry);
      this.boundaryEntries.set(boundary, entries);
    }
    let result: T | PromiseLike<T>;
    try {
      result = thunk();
    } catch (error) {
      entry.status = "rejected";
      entry.value = error;
      return Promise.reject(error);
    }
    if (requirePromiseLike && !isPromiseLike(result)) {
      this.async.pop();
      throw new TypeError("Await $promise must be promise-like");
    }
    return Promise.resolve(result).then(
      (value) => {
        if (boundary === undefined || this.boundaries[boundary] !== "timeout") {
          entry.status = "fulfilled";
          entry.value = value;
        }
        return value;
      },
      (error) => {
        if (boundary === undefined || this.boundaries[boundary] !== "timeout") {
          entry.status = "rejected";
          entry.value = error;
        }
        throw error;
      },
    );
  }

  beginRoot(): () => void {
    this.rootPending += 1;
    return this.finishOnce(() => {
      this.rootPending -= 1;
      this.checkComplete();
    });
  }

  beginBoundary(
    timeoutMs: number,
    onTimeout: (renderFallback: boolean) => void,
    parent?: number,
  ): { index: number; finish: () => void } {
    const index = this.boundaries.length;
    this.boundaries.push("resolved");
    this.boundaryPending += 1;
    const control = {
      parent,
      onTimeout,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      settled: false,
    };
    control.timer = setTimeout(() => this.timeoutBoundary(index, true), timeoutMs);
    this.boundaryControls.set(index, control);
    return {
      index,
      finish: () => {
        if (control.settled) return;
        control.settled = true;
        clearTimeout(control.timer);
        this.boundaryPending -= 1;
        this.checkComplete();
      },
    };
  }

  recordBoundary(): number {
    const index = this.boundaries.length;
    this.boundaries.push("resolved");
    return index;
  }

  markBoundaryError(index: number): void {
    if (this.boundaries[index] !== "timeout") this.boundaries[index] = "error";
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = error;
  }

  async wait(timeoutMs: number): Promise<void> {
    this.checkComplete();
    if (this.rootPending === 0 && this.boundaryPending === 0) {
      if (this.failed) throw this.failure;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rootTimeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (this.rootPending > 0) {
          reject(new Error(`Sol server rendering timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
    try {
      await Promise.race([this.completion.promise, rootTimeout]);
      if (this.failed) throw this.failure;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  payload(): HydrationPayload {
    return {
      version: HYDRATION_VERSION,
      templates: this.templates,
      async: this.async,
      boundaries: this.boundaries,
      ...(this.headBlocks.length > 0
        ? { head: { id: this.headId, count: this.headBlocks.length } }
        : {}),
    };
  }

  private finishOnce(finish: () => void): () => void {
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      finish();
    };
  }

  private timeoutBoundary(index: number, renderFallback: boolean): void {
    const control = this.boundaryControls.get(index);
    if (!control || control.settled) return;
    control.settled = true;
    clearTimeout(control.timer);
    this.boundaries[index] = "timeout";
    this.boundaryPending -= 1;
    for (const [descendant, candidate] of this.boundaryControls) {
      if (!candidate.settled && this.isDescendant(descendant, index)) {
        this.timeoutBoundary(descendant, false);
      }
    }
    try {
      control.onTimeout(renderFallback);
    } catch (error) {
      this.fail(error);
    } finally {
      this.checkComplete();
    }
  }

  private isDescendant(candidate: number, ancestor: number): boolean {
    let parent = this.boundaryControls.get(candidate)?.parent;
    while (parent !== undefined) {
      if (parent === ancestor) return true;
      parent = this.boundaryControls.get(parent)?.parent;
    }
    return false;
  }

  private checkComplete(): void {
    if (this.rootPending !== 0 || this.boundaryPending !== 0) return;
    this.completion.resolve();
  }
}

export class HydrationSession {
  committed = false;
  private readonly templates = new Map<string, number>();
  private asyncIndex = 0;
  private boundaryIndex = 0;
  private pending = 0;
  private completion = deferred();
  private readonly commitCallbacks: Array<() => void> = [];
  private failed = false;
  private failure: unknown;

  constructor(readonly payload: HydrationPayload) {
    if (payload.version !== HYDRATION_VERSION) {
      throw new Error(`Unsupported Sol hydration protocol ${String(payload.version)}`);
    }
    if (!payload.templates.every((signature) => typeof signature === "string")) {
      throw new TypeError("Invalid Sol hydration template payload");
    }
    if (
      !payload.boundaries.every(
        (state) => state === "resolved" || state === "timeout" || state === "error",
      )
    ) {
      throw new TypeError("Invalid Sol hydration boundary payload");
    }
    if (!payload.async.every((entry) => validAsyncEntry(entry))) {
      throw new TypeError("Invalid Sol hydration async payload");
    }
    for (const signature of payload.templates) {
      this.templates.set(signature, (this.templates.get(signature) ?? 0) + 1);
    }
  }

  claimTemplate(signature: string): void {
    const remaining = this.templates.get(signature) ?? 0;
    if (remaining === 0) throw new HydrationMismatchError(`template mismatch for ${signature}`);
    if (remaining === 1) this.templates.delete(signature);
    else this.templates.set(signature, remaining - 1);
  }

  validateTemplateOrder(signatures: readonly string[]): void {
    if (
      signatures.length !== this.payload.templates.length ||
      signatures.some((signature, index) => signature !== this.payload.templates[index])
    ) {
      throw new HydrationMismatchError("template payload order mismatch");
    }
  }

  claimBoundary(): "resolved" | "timeout" | "error" {
    const state = this.payload.boundaries[this.boundaryIndex++];
    if (!state) throw new HydrationMismatchError("boundary payload is missing");
    return state;
  }

  capture<T>(
    site: string,
    thunk: () => T | PromiseLike<T>,
    requirePromiseLike = false,
  ): Promise<T> {
    return this.captureReplay(site, thunk, requirePromiseLike).promise;
  }

  captureReplay<T>(
    site: string,
    thunk: () => T | PromiseLike<T>,
    requirePromiseLike = false,
  ): { readonly promise: Promise<T>; readonly status: AsyncEntry["status"]; readonly value?: T } {
    const entry = this.payload.async[this.asyncIndex++];
    if (!entry) throw new HydrationMismatchError(`async payload is missing for ${site}`);
    if (entry.site !== site) {
      throw new HydrationMismatchError(`async mismatch: expected ${entry.site}, received ${site}`);
    }
    if (entry.status === "pending") {
      const result = thunk();
      if (requirePromiseLike && !isPromiseLike(result)) {
        throw new TypeError("Await $promise must be promise-like");
      }
      return { promise: Promise.resolve(result), status: "pending" };
    }
    const replay =
      entry.status === "fulfilled"
        ? Promise.resolve(entry.value as T)
        : Promise.reject<T>(entry.value);
    this.beginReplay();
    void replay.then(
      () => this.finishReplay(),
      () => this.finishReplay(),
    );
    return {
      promise: replay,
      status: entry.status,
      ...(entry.status === "fulfilled" ? { value: entry.value as T } : {}),
    };
  }

  track<T>(promise: PromiseLike<T>): Promise<T> {
    this.beginReplay();
    const tracked = Promise.resolve(promise);
    void tracked.then(
      () => this.finishReplay(),
      () => this.finishReplay(),
    );
    return tracked;
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = error;
  }

  async wait(): Promise<void> {
    if (this.pending > 0) await this.completion.promise;
    if (this.failed) throw this.failure;
    if (this.templates.size > 0) {
      throw new HydrationMismatchError(
        `did not consume every template entry: ${[...this.templates.keys()].join(", ")}`,
      );
    }
    if (this.asyncIndex !== this.payload.async.length) {
      throw new HydrationMismatchError("did not consume every async entry");
    }
    if (this.boundaryIndex !== this.payload.boundaries.length) {
      throw new HydrationMismatchError("did not consume every boundary entry");
    }
  }

  commit(): void {
    this.committed = true;
    for (const callback of this.commitCallbacks.splice(0)) callback();
  }

  afterCommit(callback: () => void): void {
    if (this.committed) callback();
    else this.commitCallbacks.push(callback);
  }

  private finishReplay(): void {
    this.pending -= 1;
    if (this.pending === 0) this.completion.resolve();
  }

  private beginReplay(): void {
    if (this.pending === 0) this.completion = deferred();
    this.pending += 1;
  }
}

function validAsyncEntry(entry: unknown): entry is AsyncEntry {
  if (entry === null || typeof entry !== "object") return false;
  const value = entry as Partial<AsyncEntry>;
  if (typeof value.site !== "string") return false;
  const keys = Object.keys(entry).toSorted().join(",");
  if (value.status === "pending") return keys === "site,status";
  if (value.status !== "fulfilled" && value.status !== "rejected") return false;
  return keys === "site,status,value";
}

export function asyncValue<T>(
  frame: {
    readonly ssr?: SsrSession;
    readonly ssrBoundary?: number;
    readonly hydration?: HydrationSession;
  },
  site: string,
  thunk: () => T | PromiseLike<T>,
  requirePromiseLike = false,
): Promise<T> {
  if (frame.ssr) return frame.ssr.capture(site, thunk, requirePromiseLike, frame.ssrBoundary);
  if (frame.hydration && !frame.hydration.committed) {
    return frame.hydration.capture(site, thunk, requirePromiseLike);
  }
  try {
    const result = thunk();
    if (requirePromiseLike && !isPromiseLike(result)) {
      throw new TypeError("Await $promise must be promise-like");
    }
    return Promise.resolve(result);
  } catch (error) {
    return Promise.reject(error);
  }
}
