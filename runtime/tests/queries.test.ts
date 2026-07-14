import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  $mutation,
  $query,
  clearServerQueryCache,
  queryInFrame,
  type QueryKey,
} from "../src/queries.ts";
import { disposeOwner } from "../src/reactivity.ts";
import { block, component, renderComponent, rootFrame, type Block } from "../src/rendering.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

let window: Window;

beforeEach(() => {
  window = new Window();
  Object.assign(globalThis, {
    window,
    document: window.document,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Element: window.Element,
  });
});

afterEach(() => window.close());

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emptyBlock(): Block {
  return block(document.createDocumentFragment());
}

function inComponent<T>(setup: () => T): { readonly value: T; dispose(): void } {
  let value!: T;
  const TestComponent = component(() => {
    value = setup();
    return emptyBlock();
  });
  const rendered = renderComponent(TestComponent);
  return { value, dispose: () => rendered.dispose() };
}

describe("queries", () => {
  test("retains query data through a request and clears it at the render boundary", async () => {
    const url = new URL("https://example.test/request");
    const firstOwner: Array<() => void> = [];
    const firstFrame = { ...rootFrame(), owner: firstOwner, url };
    let requests = 0;
    const config = {
      queryKey: "request",
      query: async () => {
        requests += 1;
        return "payload";
      },
      enabled: false,
    };
    const first = queryInFrame(config, firstFrame);
    await first.refetch();
    const originalSetTimeout = globalThis.setTimeout;
    let scheduled = false;
    globalThis.setTimeout = ((..._arguments: unknown[]) => {
      scheduled = true;
      return 0 as never;
    }) as unknown as typeof setTimeout;
    try {
      disposeOwner(firstOwner);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(scheduled).toBe(false);
    const secondOwner: Array<() => void> = [];
    const second = queryInFrame(config, { ...rootFrame(), owner: secondOwner, url });
    expect(second.data).toBe("payload");
    expect(requests).toBe(1);
    disposeOwner(secondOwner);

    clearServerQueryCache(url);
    const thirdOwner: Array<() => void> = [];
    const third = queryInFrame(config, { ...rootFrame(), owner: thirdOwner, url });
    expect(third.data).toBeUndefined();
    disposeOwner(thirdOwner);
  });

  test("validates configs, JSON keys, durations, call options, and component ownership", async () => {
    expect(() => $query(undefined as never)).toThrow("config must be an object");
    expect(() => $mutation({ mutation: async () => 1 })).toThrow("component setup");
    expect(() =>
      inComponent(() => $query({ query: undefined as never, queryKey: "missing-query" })),
    ).toThrow("query must be a function");
    expect(() =>
      inComponent(() =>
        $query({ query: async () => 1, queryKey: new Date() as unknown as QueryKey }),
      ),
    ).toThrow("plain objects");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      inComponent(() => $query({ query: async () => 1, queryKey: cyclic as unknown as QueryKey })),
    ).toThrow("must not be cyclic");
    const arrayWithExtra = ["post"] as unknown[] & { hidden?: unknown };
    arrayWithExtra.hidden = undefined;
    expect(() =>
      inComponent(() =>
        $query({ query: async () => 1, queryKey: arrayWithExtra as unknown as QueryKey }),
      ),
    ).toThrow("only indexed JSON values");
    const arrayWithSymbol = ["post"] as unknown as Record<PropertyKey, unknown>;
    arrayWithSymbol[Symbol("hidden")] = "ignored";
    expect(() =>
      inComponent(() =>
        $query({ query: async () => 1, queryKey: arrayWithSymbol as unknown as QueryKey }),
      ),
    ).toThrow("only indexed JSON values");
    expect(() =>
      inComponent(() => $query({ query: async () => 1, queryKey: "bad-stale", staleTime: -1 })),
    ).toThrow("staleTime");
    expect(() =>
      inComponent(() =>
        $query({ query: async () => 1, queryKey: "bad-poll", pollingInterval: Infinity }),
      ),
    ).toThrow("pollingInterval");

    const query = inComponent(() =>
      $query({ query: async () => 1, queryKey: "bad-call-options", enabled: false }),
    );
    expect(() => query.value.refetch([] as never)).toThrow("options must be an object");
    query.dispose();

    const mutation = inComponent(() => $mutation({ mutation: async () => 1 }));
    expect(() => mutation.value.mutate(undefined as never)).toThrow("options must be an object");
    mutation.dispose();

    const invalidResult = inComponent(() =>
      $query({ query: (() => 1) as never, queryKey: "non-promise" }),
    );
    await Promise.resolve();
    expect(invalidResult.value.isFailed).toBe(true);
    expect(invalidResult.value.error).toBeInstanceOf(TypeError);
    invalidResult.dispose();

    const queryFailure = new Error("synchronous query failure");
    const throwingQuery = inComponent(() =>
      $query({
        query: () => {
          throw queryFailure;
        },
        queryKey: "synchronous-query-failure",
        enabled: false,
        cacheTime: 0,
      }),
    );
    let caughtQuery: unknown;
    try {
      await throwingQuery.value.refetch();
    } catch (error) {
      caughtQuery = error;
    }
    expect(caughtQuery).toBe(queryFailure);
    expect(throwingQuery.value.isFailed).toBe(true);
    throwingQuery.dispose();

    const mutationFailure = new Error("synchronous mutation failure");
    const throwingMutation = inComponent(() =>
      $mutation({
        mutation: () => {
          throw mutationFailure;
        },
      }),
    );
    let caughtMutation: unknown;
    try {
      await throwingMutation.value.mutate({});
    } catch (error) {
      caughtMutation = error;
    }
    expect(caughtMutation).toBe(mutationFailure);
    expect(throwingMutation.value.isFailed).toBe(true);
    throwingMutation.dispose();
  });

  test("forwards and reuses arguments while tracking data, previous data, and failures", async () => {
    const pending: Array<{ arg: string; request: Deferred<number> }> = [];
    const mounted = inComponent(() =>
      $query(
        {
          queryKey: ["argument-state"],
          query: (arg: string) => {
            const request = deferred<number>();
            pending.push({ arg, request });
            return request.promise;
          },
          cacheTime: 0,
        },
        "initial",
      ),
    );
    const query = mounted.value;

    expect(pending[0]!.arg).toBe("initial");
    expect(query.isFetching).toBe(true);
    expect(query.isRefetching).toBe(false);
    pending[0]!.request.resolve(1);
    await pending[0]!.request.promise;
    expect(query.data).toBe(1);
    expect(query.lastData).toBeUndefined();

    const second = query.refetch({}, "changed");
    expect(pending[1]!.arg).toBe("changed");
    expect(query.data).toBe(1);
    expect(query.isFetching).toBe(true);
    expect(query.isRefetching).toBe(true);
    pending[1]!.request.resolve(2);
    expect(await second).toBe(2);
    expect(query.data).toBe(2);
    expect(query.lastData).toBe(1);

    const failed = query.refetch();
    expect(pending[2]!.arg).toBe("changed");
    const failure = new Error("request failed");
    pending[2]!.request.reject(failure);
    let caught: unknown;
    try {
      await failed;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(query.data).toBe(2);
    expect(query.lastData).toBe(1);
    expect(query.error).toBe(failure);
    expect(query.isFailed).toBe(true);
    mounted.dispose();
  });

  test("shares cached state, deduplicates requests, respects freshness, and evicts unused keys", async () => {
    const firstRequest = deferred<undefined>();
    let firstCalls = 0;
    let secondCalls = 0;
    const first = inComponent(() =>
      $query({
        queryKey: { resource: "shared-undefined" },
        query: () => {
          firstCalls += 1;
          return firstRequest.promise;
        },
        staleTime: Infinity,
        cacheTime: 0,
      }),
    );
    const second = inComponent(() =>
      $query({
        queryKey: { resource: "shared-undefined" },
        query: async () => {
          secondCalls += 1;
          return undefined;
        },
        staleTime: Infinity,
        cacheTime: 0,
      }),
    );

    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
    firstRequest.resolve(undefined);
    await firstRequest.promise;
    expect(first.value.data).toBeUndefined();
    expect(second.value.data).toBeUndefined();
    expect(first.value.isFetching).toBe(false);
    first.dispose();
    second.dispose();

    const remounted = inComponent(() =>
      $query({
        queryKey: { resource: "shared-undefined" },
        query: async () => {
          secondCalls += 1;
          return undefined;
        },
        staleTime: Infinity,
        cacheTime: 0,
      }),
    );
    expect(secondCalls).toBe(1);
    await Promise.resolve();
    remounted.dispose();
  });

  test("reuses fresh retained data and treats differently stringified keys as distinct", async () => {
    let calls = 0;
    const first = inComponent(() =>
      $query({
        queryKey: { first: 1, second: 2 },
        query: async () => ++calls,
        staleTime: Infinity,
        cacheTime: Infinity,
      }),
    );
    await Promise.resolve();
    expect(first.value.data).toBe(1);
    first.dispose();

    const fresh = inComponent(() =>
      $query({
        queryKey: { first: 1, second: 2 },
        query: async () => ++calls,
        staleTime: Infinity,
        cacheTime: Infinity,
      }),
    );
    expect(calls).toBe(1);
    expect(fresh.value.data).toBe(1);

    const reordered = inComponent(() =>
      $query({
        queryKey: { second: 2, first: 1 },
        query: async () => ++calls,
        staleTime: Infinity,
        cacheTime: Infinity,
      }),
    );
    expect(calls).toBe(2);
    await Promise.resolve();
    fresh.dispose();
    reordered.dispose();
  });

  test("deduplicates changed refetch arguments but remembers them for the next request", async () => {
    const requests: Array<{ arg: string; request: Deferred<string> }> = [];
    const mounted = inComponent(() =>
      $query(
        {
          queryKey: "deduplicated-arguments",
          query: (arg: string) => {
            const request = deferred<string>();
            requests.push({ arg, request });
            return request.promise;
          },
          cacheTime: 0,
        },
        "initial",
      ),
    );

    const deduplicated = mounted.value.refetch({}, "next");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.arg).toBe("initial");
    requests[0]!.request.resolve("first result");
    expect(await deduplicated).toBe("first result");

    const next = mounted.value.refetch();
    expect(requests[1]!.arg).toBe("next");
    requests[1]!.request.resolve("next result");
    expect(await next).toBe("next result");
    mounted.dispose();
  });

  test("keeps disabled queries idle until a manual refetch", async () => {
    let calls = 0;
    const mounted = inComponent(() =>
      $query(
        {
          queryKey: "disabled-query",
          query: async (value: number) => {
            calls += 1;
            return value;
          },
          enabled: false,
          cacheTime: 0,
        },
        1,
      ),
    );
    expect(calls).toBe(0);
    expect(mounted.value.isFetching).toBe(false);
    expect(await mounted.value.refetch({}, 2)).toBe(2);
    expect(calls).toBe(1);
    expect(mounted.value.data).toBe(2);
    mounted.dispose();
  });

  test("applies finite freshness and the longest cache retention across remounts", async () => {
    const originalNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let now = 0;
    let nextTimer = 1;
    const timers = new Map<number, { callback: () => void; delay: number }>();
    Date.now = () => now;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
      const id = nextTimer++;
      timers.set(id, { callback: callback as () => void, delay: delay ?? 0 });
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as typeof clearTimeout;

    try {
      let calls = 0;
      const create = (cacheTime: number) =>
        inComponent(() =>
          $query({
            queryKey: "finite-cache-lifecycle",
            query: async () => ++calls,
            staleTime: 100,
            cacheTime,
          }),
        );

      const first = create(200);
      await Promise.resolve();
      expect(first.value.data).toBe(1);
      first.dispose();
      expect([...timers.values()].map((timer) => timer.delay)).toEqual([200]);

      const remounted = create(200);
      expect(timers.size).toBe(0);
      expect(calls).toBe(1);
      expect(remounted.value.data).toBe(1);

      now = 101;
      const longerObserver = create(500);
      expect(calls).toBe(2);
      await Promise.resolve();
      expect(remounted.value.data).toBe(2);
      remounted.dispose();
      longerObserver.dispose();
      expect([...timers.values()].map((timer) => timer.delay)).toEqual([500]);

      for (const timer of timers.values()) timer.callback();
      timers.clear();
      const afterEviction = create(0);
      expect(calls).toBe(3);
      await Promise.resolve();
      afterEviction.dispose();
    } finally {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("keeps only the latest overlapping mutation in controller state", async () => {
    const requests = new Map<string, Deferred<number>>();
    const mounted = inComponent(() =>
      $mutation({
        mutation: (name: string) => {
          const request = deferred<number>();
          requests.set(name, request);
          return request.promise;
        },
      }),
    );
    const mutation = mounted.value;
    const first = mutation.mutate({}, "first");
    const second = mutation.mutate({}, "second");
    expect(mutation.isMutating).toBe(true);

    requests.get("second")!.resolve(2);
    expect(await second).toBe(2);
    expect(mutation.data).toBe(2);
    expect(mutation.isMutating).toBe(false);
    requests.get("first")!.resolve(1);
    expect(await first).toBe(1);
    expect(mutation.data).toBe(2);
    expect(mutation.lastData).toBeUndefined();

    const failed = mutation.mutate({}, "failed");
    const failure = new Error("mutation failed");
    requests.get("failed")!.reject(failure);
    let caught: unknown;
    try {
      await failed;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(mutation.data).toBe(2);
    expect(mutation.isFailed).toBe(true);
    expect(mutation.error).toBe(failure);

    const third = mutation.mutate({}, "third");
    requests.get("third")!.resolve(3);
    expect(await third).toBe(3);
    expect(mutation.data).toBe(3);
    expect(mutation.lastData).toBe(2);
    expect(mutation.isFailed).toBe(false);
    mounted.dispose();
  });

  test("polls only while mounted and visible and skips in-flight ticks", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let nextTimer = 1;
    const timers = new Map<number, () => void>();
    globalThis.setTimeout = ((callback: TimerHandler) => {
      const id = nextTimer++;
      timers.set(id, callback as () => void);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as typeof clearTimeout;
    const runTimers = (): void => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    };

    try {
      const requests: Deferred<number>[] = [];
      const mounted = inComponent(() =>
        $query({
          queryKey: "polling",
          query: () => {
            const request = deferred<number>();
            requests.push(request);
            return request.promise;
          },
          pollingInterval: 10,
          cacheTime: Infinity,
          suspense: { initial: false },
        }),
      );
      expect(requests).toHaveLength(1);
      runTimers();
      expect(requests).toHaveLength(1);
      requests[0]!.resolve(1);
      await requests[0]!.promise;
      runTimers();
      expect(requests).toHaveLength(2);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new window.Event("visibilitychange") as unknown as Event);
      requests[1]!.resolve(2);
      await requests[1]!.promise;
      runTimers();
      expect(requests).toHaveLength(2);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new window.Event("visibilitychange") as unknown as Event);
      runTimers();
      expect(requests).toHaveLength(3);
      mounted.dispose();
      requests[2]!.resolve(3);
      await requests[2]!.promise;
      runTimers();
      expect(requests).toHaveLength(3);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
