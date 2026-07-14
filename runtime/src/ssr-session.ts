export const HYDRATION_VERSION = 1;

export type AsyncEntry =
  | { readonly site: string; status: "pending" }
  | { readonly site: string; status: "fulfilled"; value: unknown }
  | { readonly site: string; status: "rejected"; value: unknown };

export interface HydrationPayload {
  readonly version: number;
  readonly templates: string[];
  readonly async: AsyncEntry[];
  readonly boundaries: ("resolved" | "timeout" | "error")[];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export class SsrSession {
  readonly templates: string[] = [];
  readonly async: AsyncEntry[] = [];
  readonly boundaries: ("resolved" | "timeout" | "error")[] = [];
  private rootPending = 0;
  private boundaryPending = 0;
  private completion = deferred();
  private failure: unknown;

  recordTemplate(signature: string): void {
    this.templates.push(signature);
  }

  capture<T>(site: string, thunk: () => T | PromiseLike<T>): Promise<T> {
    const entry: { site: string; status: "pending" | "fulfilled" | "rejected"; value?: unknown } = {
      site,
      status: "pending",
    };
    this.async.push(entry as AsyncEntry);
    let result: T | PromiseLike<T>;
    try {
      result = thunk();
    } catch (error) {
      entry.status = "rejected";
      entry.value = error;
      return Promise.reject(error);
    }
    return Promise.resolve(result).then(
      (value) => {
        entry.status = "fulfilled";
        entry.value = value;
        return value;
      },
      (error) => {
        entry.status = "rejected";
        entry.value = error;
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

  beginBoundary(timeoutMs: number, onTimeout: () => void): { index: number; finish: () => void } {
    const index = this.boundaries.length;
    this.boundaries.push("resolved");
    this.boundaryPending += 1;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.boundaries[index] = "timeout";
      this.boundaryPending -= 1;
      onTimeout();
      this.checkComplete();
    }, timeoutMs);
    return {
      index,
      finish: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
    this.failure ??= error;
  }

  async wait(timeoutMs: number): Promise<void> {
    this.checkComplete();
    if (this.rootPending === 0 && this.boundaryPending === 0) {
      if (this.failure !== undefined) throw this.failure;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rootTimeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (this.rootPending > 0) {
          reject(new Error(`Solix server rendering timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
    try {
      await Promise.race([this.completion.promise, rootTimeout]);
      if (this.failure !== undefined) throw this.failure;
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

  constructor(readonly payload: HydrationPayload) {
    if (payload.version !== HYDRATION_VERSION) {
      throw new Error(`Unsupported Solix hydration protocol ${String(payload.version)}`);
    }
    if (!payload.templates.every((signature) => typeof signature === "string")) {
      throw new TypeError("Invalid Solix hydration template payload");
    }
    if (
      !payload.boundaries.every(
        (state) => state === "resolved" || state === "timeout" || state === "error",
      )
    ) {
      throw new TypeError("Invalid Solix hydration boundary payload");
    }
    if (
      !payload.async.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.site === "string" &&
          (entry.status === "pending" ||
            entry.status === "fulfilled" ||
            entry.status === "rejected") &&
          (entry.status === "pending" || Object.prototype.hasOwnProperty.call(entry, "value")),
      )
    ) {
      throw new TypeError("Invalid Solix hydration async payload");
    }
    for (const signature of payload.templates) {
      this.templates.set(signature, (this.templates.get(signature) ?? 0) + 1);
    }
  }

  claimTemplate(signature: string): void {
    const remaining = this.templates.get(signature) ?? 0;
    if (remaining === 0) throw new Error(`Solix hydration template mismatch for ${signature}`);
    if (remaining === 1) this.templates.delete(signature);
    else this.templates.set(signature, remaining - 1);
  }

  claimBoundary(): "resolved" | "timeout" | "error" {
    const state = this.payload.boundaries[this.boundaryIndex++];
    if (!state) throw new Error("Solix hydration boundary payload is missing");
    return state;
  }

  capture<T>(site: string, thunk: () => T | PromiseLike<T>): Promise<T> {
    const entry = this.payload.async[this.asyncIndex++];
    if (!entry) throw new Error(`Solix hydration async payload is missing for ${site}`);
    if (entry.site !== site) {
      throw new Error(`Solix hydration async mismatch: expected ${entry.site}, received ${site}`);
    }
    if (entry.status === "pending") return Promise.resolve().then(thunk);
    const replay =
      entry.status === "fulfilled"
        ? Promise.resolve(entry.value as T)
        : Promise.reject<T>(entry.value);
    this.beginReplay();
    void replay.then(
      () => this.finishReplay(),
      () => this.finishReplay(),
    );
    return replay;
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

  async wait(): Promise<void> {
    if (this.pending > 0) await this.completion.promise;
    if (this.templates.size > 0) {
      throw new Error("Solix hydration did not consume every template entry");
    }
    if (this.asyncIndex !== this.payload.async.length) {
      throw new Error("Solix hydration did not consume every async entry");
    }
    if (this.boundaryIndex !== this.payload.boundaries.length) {
      throw new Error("Solix hydration did not consume every boundary entry");
    }
  }

  commit(): void {
    this.committed = true;
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

export function asyncValue<T>(
  frame: { readonly ssr?: SsrSession; readonly hydration?: HydrationSession },
  site: string,
  thunk: () => T | PromiseLike<T>,
): Promise<T> {
  if (frame.ssr) return frame.ssr.capture(site, thunk);
  if (frame.hydration && !frame.hydration.committed) return frame.hydration.capture(site, thunk);
  try {
    return Promise.resolve(thunk());
  } catch (error) {
    return Promise.reject(error);
  }
}
