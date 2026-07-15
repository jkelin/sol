import {
  $signal,
  assertOwnerActive,
  batch,
  isObject,
  isPromiseLike,
  runtimeState,
} from "./reactivity.ts";
import { assertSetupActive, type Cleanup, type RenderFrame } from "./rendering.ts";
import {
  devtoolsMutationCreated,
  devtoolsMutationDisposed,
  devtoolsMutationUpdated,
  devtoolsQueryCreated,
  devtoolsQueryDisposed,
  devtoolsQueryUpdated,
  type SourceMetadata,
} from "./devtools-hook.ts";
import { asyncValue } from "./ssr-session.ts";
import { rpcFunctionMetadata } from "./server-functions.ts";
import { snapshotOwnDataProperties } from "./options.ts";
import { MAX_TIMER_DELAY } from "./timers.ts";

export type QueryKey =
  | null
  | boolean
  | number
  | string
  | readonly QueryKey[]
  | { readonly [key: string]: QueryKey };

export interface QuerySuspenseOptions {
  readonly initial?: boolean;
  readonly refetch?: boolean;
}

export interface QueryConfig<Data, Args extends unknown[] = unknown[]> {
  readonly query: (...args: Args) => PromiseLike<Data>;
  readonly queryKey: QueryKey;
  readonly enabled?: boolean;
  readonly staleTime?: number;
  readonly cacheTime?: number;
  readonly pollingInterval?: number;
  readonly suspense?: QuerySuspenseOptions;
}

export interface QueryCallOptions {
  readonly suspense?: boolean;
}

export interface QueryController<Data, Args extends unknown[] = unknown[]> {
  readonly data: Data | undefined;
  readonly lastData: Data | undefined;
  readonly error: unknown;
  readonly isFetching: boolean;
  readonly isRefetching: boolean;
  readonly isFailed: boolean;
  refetch(this: void, options?: QueryCallOptions): Promise<Data>;
  refetch(this: void, options: QueryCallOptions, ...args: Args): Promise<Data>;
}

export interface MutationConfig<Data, Args extends unknown[] = unknown[]> {
  readonly mutation: (...args: Args) => PromiseLike<Data>;
  readonly suspense?: boolean;
}

export interface MutationCallOptions {
  readonly suspense?: boolean;
}

export interface MutationController<Data, Args extends unknown[] = unknown[]> {
  readonly data: Data | undefined;
  readonly lastData: Data | undefined;
  readonly error: unknown;
  readonly isMutating: boolean;
  readonly isFailed: boolean;
  mutate(this: void, options: MutationCallOptions, ...args: Args): Promise<Data>;
}

interface QueryState<Data> {
  data: Data | undefined;
  lastData: Data | undefined;
  error: unknown;
  hasData: boolean;
  isFetching: boolean;
  isRefetching: boolean;
  isFailed: boolean;
  updatedAt: number;
}

interface QueryObserver {
  readonly cacheTime: number;
}

interface QueryCacheEntry {
  readonly key: string;
  readonly cache: Map<string, QueryCacheEntry>;
  readonly requestScoped: boolean;
  readonly state: ReturnType<typeof $signal<QueryState<unknown>>>;
  readonly observers: Set<QueryObserver>;
  inFlight?: Promise<unknown>;
  evictionTimer?: ReturnType<typeof setTimeout>;
  cycleCacheTime: number;
}

interface MutationState<Data> {
  data: Data | undefined;
  lastData: Data | undefined;
  error: unknown;
  hasData: boolean;
  isMutating: boolean;
  isFailed: boolean;
}

const DEFAULT_CACHE_TIME = 5 * 60 * 1000;
const queryCache = new Map<string, QueryCacheEntry>();
const requestSources = new WeakMap<object, SourceMetadata>();

export function requestSource<Config extends object>(
  config: Config,
  source: SourceMetadata,
): Config {
  if (config && typeof config === "object") requestSources.set(config, source);
  return config;
}
const serverQueryCaches = new WeakMap<object, Map<string, QueryCacheEntry>>();

export function clearServerQueryCache(scope: object | undefined): void {
  if (!scope) return;
  const cache = serverQueryCaches.get(scope);
  if (!cache) return;
  serverQueryCaches.delete(scope);
  for (const entry of cache.values()) {
    if (entry.evictionTimer !== undefined) clearTimeout(entry.evictionTimer);
  }
  cache.clear();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function validateOptionsObject(value: unknown, name: string): asserts value is object {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`);
}

function validateOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
}

function validateDuration(
  value: unknown,
  name: string,
  defaultValue: number,
  allowZero: boolean,
  timerBacked = false,
): number {
  if (value === undefined) return defaultValue;
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    value < 0 ||
    (!allowZero && value === 0) ||
    (timerBacked && value !== Infinity && typeof value === "number" && value > MAX_TIMER_DELAY) ||
    (value !== Infinity && !Number.isFinite(value))
  ) {
    const range = allowZero ? "a non-negative number" : "a positive finite number";
    throw new TypeError(`${name} must be ${range}`);
  }
  if (!allowZero && value === Infinity) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function validateQueryKey(value: unknown, ancestors: Set<object>): asserts value is QueryKey {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("$query() queryKey numbers must be finite");
    return;
  }
  if (!isObject(value)) {
    throw new TypeError("$query() queryKey must contain only JSON values");
  }
  if (ancestors.has(value)) throw new TypeError("$query() queryKey must not be cyclic");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) throw new TypeError("$query() queryKey arrays must not be sparse");
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("$query() queryKey arrays must contain enumerable data properties");
      }
      validateQueryKey(descriptor.value, ancestors);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      const index = typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
      if (Number.isSafeInteger(index) && index >= 0 && index < value.length) continue;
      throw new TypeError("$query() queryKey arrays may contain only indexed JSON values");
    }
  } else {
    if (!isPlainObject(value)) {
      throw new TypeError("$query() queryKey objects must be plain objects");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError("$query() queryKey objects must use string keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("$query() queryKey objects must contain enumerable data properties");
      }
      validateQueryKey(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

function serializeQueryKey(value: unknown): string {
  validateQueryKey(value, new Set());
  return JSON.stringify(value);
}

function activeComponent(name: "$query()" | "$mutation()"): {
  owner: Cleanup[];
  frame: RenderFrame;
} {
  const owner = runtimeState.activeOwner;
  const frame = runtimeState.activeFrame;
  if (!owner || !frame) throw new Error(`${name} must be called during component setup`);
  return { owner, frame };
}

function removeOwnerCleanup(owner: Cleanup[], cleanup: Cleanup): void {
  const index = owner.lastIndexOf(cleanup);
  if (index >= 0) owner.splice(index, 1);
}

function trackSuspense<Data>(
  promise: Promise<Data>,
  enabled: boolean,
  owner: Cleanup[],
  frame: RenderFrame,
): void {
  const suspense = enabled ? frame.suspense : undefined;
  if (!suspense) return;
  const finish = suspense.begin(true);
  let active = true;
  const cleanup = (): void => {
    if (!active) return;
    active = false;
    finish();
  };
  owner.push(cleanup);
  void promise.then(
    () => {
      cleanup();
      removeOwnerCleanup(owner, cleanup);
    },
    (error) => {
      if (active) suspense.reject(error);
      cleanup();
      removeOwnerCleanup(owner, cleanup);
    },
  );
}

function invokeAsync<Data, Args extends unknown[]>(
  name: "$query()" | "$mutation()",
  operation: (...args: Args) => PromiseLike<Data>,
  args: Args,
): Promise<Data> {
  try {
    const result = operation(...args);
    if (!isPromiseLike(result)) {
      return Promise.reject(new TypeError(`${name} function must return a promise-like value`));
    }
    return Promise.resolve(result);
  } catch (error) {
    return Promise.reject(error);
  }
}

function queryEntry(key: string, frame: RenderFrame): QueryCacheEntry {
  let cache = queryCache;
  const serverScope = frame.ssr ?? frame.url;
  if (serverScope) {
    cache = serverQueryCaches.get(serverScope) ?? new Map<string, QueryCacheEntry>();
    serverQueryCaches.set(serverScope, cache);
  }
  let entry = cache.get(key);
  if (entry) return entry;
  entry = {
    key,
    cache,
    requestScoped: Boolean(serverScope),
    state: $signal<QueryState<unknown>>({
      data: undefined,
      lastData: undefined,
      error: undefined,
      hasData: false,
      isFetching: false,
      isRefetching: false,
      isFailed: false,
      updatedAt: 0,
    }),
    observers: new Set(),
    cycleCacheTime: 0,
  };
  cache.set(key, entry);
  return entry;
}

function subscribe(entry: QueryCacheEntry, cacheTime: number, owner: Cleanup[]): Cleanup {
  if (entry.evictionTimer !== undefined) {
    clearTimeout(entry.evictionTimer);
    entry.evictionTimer = undefined;
  }
  const observer = { cacheTime };
  entry.observers.add(observer);
  entry.cycleCacheTime = Math.max(entry.cycleCacheTime, cacheTime);
  let active = true;
  const unsubscribe = (): void => {
    if (!active) return;
    active = false;
    entry.observers.delete(observer);
    if (entry.observers.size > 0) return;
    if (entry.requestScoped) return;
    const retention = entry.cycleCacheTime;
    entry.cycleCacheTime = 0;
    if (retention === Infinity) return;
    if (retention === 0) {
      if (entry.cache.get(entry.key) === entry) entry.cache.delete(entry.key);
      return;
    }
    entry.evictionTimer = setTimeout(() => {
      entry.evictionTimer = undefined;
      if (entry.observers.size === 0 && entry.cache.get(entry.key) === entry) {
        entry.cache.delete(entry.key);
      }
    }, retention);
    (entry.evictionTimer as { unref?: () => void }).unref?.();
  };
  owner.push(unsubscribe);
  return unsubscribe;
}

function requestQuery<Data, Args extends unknown[]>(
  entry: QueryCacheEntry,
  operation: (...args: Args) => PromiseLike<Data>,
  args: Args,
  suspend: boolean,
  owner: Cleanup[],
  frame: RenderFrame,
  devtoolsId: number,
): Promise<Data> {
  const existing = entry.inFlight as Promise<Data> | undefined;
  if (existing) {
    trackSuspense(existing, suspend, owner, frame);
    devtoolsQueryUpdated(devtoolsId, { ...entry.state.value, args });
    void existing.then(
      () => devtoolsQueryUpdated(devtoolsId, { ...entry.state.value, args }),
      () => devtoolsQueryUpdated(devtoolsId, { ...entry.state.value, args }),
    );
    return existing;
  }
  const state = entry.state.value;
  batch(() => {
    state.isFetching = true;
    state.isRefetching = state.hasData;
    state.error = undefined;
    state.isFailed = false;
  });
  devtoolsQueryUpdated(devtoolsId, { ...state, args });
  const site = `sol:query:${entry.key}`;
  const invoke = () => invokeAsync("$query()", operation, args);
  const replay =
    frame.hydration && !frame.hydration.committed
      ? frame.hydration.captureReplay(site, invoke, true)
      : undefined;
  const promise = replay?.promise ?? asyncValue(frame, site, invoke, true);
  if (replay?.status === "fulfilled" && suspend) {
    state.data = replay.value;
    state.hasData = true;
    state.updatedAt = Date.now();
    state.isFetching = false;
  }
  devtoolsQueryUpdated(devtoolsId, { ...state, args });
  entry.inFlight = promise;
  void promise.then(
    (data) => {
      const apply = (): void => {
        if (entry.inFlight !== promise) return;
        batch(() => {
          if (replay?.status !== "fulfilled" || !suspend) {
            if (state.hasData) state.lastData = state.data;
            state.data = data;
            state.hasData = true;
            state.updatedAt = Date.now();
          }
          state.isFetching = false;
          state.isRefetching = false;
          state.error = undefined;
          state.isFailed = false;
        });
        entry.inFlight = undefined;
        devtoolsQueryUpdated(devtoolsId, { ...state, args });
      };
      if (replay?.status === "fulfilled" && !suspend && frame.hydration) {
        frame.hydration.afterCommit(apply);
        frame.hydration.afterFailure(() => {
          if (entry.inFlight !== promise) return;
          batch(() => {
            state.isFetching = false;
            state.isRefetching = false;
          });
          entry.inFlight = undefined;
          devtoolsQueryUpdated(devtoolsId, { ...state, args });
        });
      } else apply();
    },
    (error) => {
      if (entry.inFlight !== promise) return;
      batch(() => {
        state.error = error;
        state.isFetching = false;
        state.isRefetching = false;
        state.isFailed = true;
      });
      entry.inFlight = undefined;
      devtoolsQueryUpdated(devtoolsId, { ...state, args });
    },
  );
  trackSuspense(promise, suspend, owner, frame);
  return promise;
}

export function $query<Data, Args extends unknown[]>(
  config: QueryConfig<Data, Args>,
  ...initialArgs: Args
): QueryController<Data, Args> {
  return createQuery(config, initialArgs);
}

export function queryInFrame<Data, Args extends unknown[]>(
  config: QueryConfig<Data, Args>,
  frame: RenderFrame,
  ...initialArgs: Args
): QueryController<Data, Args> {
  assertSetupActive(frame, "$query()");
  return createQuery(config, initialArgs, frame.owner, frame);
}

function createQuery<Data, Args extends unknown[]>(
  config: QueryConfig<Data, Args>,
  initialArgs: Args,
  explicitOwner?: Cleanup[],
  explicitFrame?: RenderFrame,
): QueryController<Data, Args> {
  validateOptionsObject(config, "$query() config");
  const snapshot = snapshotOwnDataProperties(config, "$query() config", [
    "query",
    "queryKey",
    "enabled",
    "staleTime",
    "cacheTime",
    "pollingInterval",
    "suspense",
  ]);
  const query = snapshot.query;
  if (typeof query !== "function") throw new TypeError("$query() query must be a function");
  validateOptionalBoolean(snapshot.enabled, "$query() enabled");
  const staleTime = validateDuration(snapshot.staleTime, "$query() staleTime", 0, true);
  const cacheTime = validateDuration(
    snapshot.cacheTime,
    "$query() cacheTime",
    DEFAULT_CACHE_TIME,
    true,
    true,
  );
  const pollingInterval =
    snapshot.pollingInterval === undefined
      ? undefined
      : validateDuration(snapshot.pollingInterval, "$query() pollingInterval", 0, false, true);
  let suspenseInitial = true;
  let suspenseRefetch = false;
  if (snapshot.suspense !== undefined) {
    validateOptionsObject(snapshot.suspense, "$query() suspense");
    const suspense = snapshotOwnDataProperties(snapshot.suspense, "$query() suspense", [
      "initial",
      "refetch",
    ]);
    validateOptionalBoolean(suspense.initial, "$query() suspense.initial");
    validateOptionalBoolean(suspense.refetch, "$query() suspense.refetch");
    suspenseInitial = (suspense.initial as boolean | undefined) ?? true;
    suspenseRefetch = (suspense.refetch as boolean | undefined) ?? false;
  }
  const active =
    explicitOwner && explicitFrame
      ? { owner: explicitOwner, frame: explicitFrame }
      : activeComponent("$query()");
  const { owner, frame } = active;
  assertOwnerActive(owner, "$query()");
  const enabled = (snapshot.enabled as boolean | undefined) ?? true;
  const key = serializeQueryKey(snapshot.queryKey);
  const entry = queryEntry(key, frame);
  subscribe(entry, cacheTime, owner);
  let disposed = false;
  let currentArgs = [...initialArgs] as Args;
  const devtoolsId = devtoolsQueryCreated(
    key,
    currentArgs,
    requestSources.get(config),
    rpcFunctionMetadata(query)?.name,
  );
  devtoolsQueryUpdated(devtoolsId, { ...entry.state.value, args: currentArgs });
  owner.push(() => {
    disposed = true;
    devtoolsQueryDisposed(devtoolsId);
  });

  const execute = (suspend: boolean): Promise<Data> => {
    if (disposed) return Promise.reject(new Error("$query() controller has been disposed"));
    return requestQuery(
      entry,
      query as (...args: Args) => PromiseLike<Data>,
      currentArgs,
      suspend,
      owner,
      frame,
      devtoolsId,
    );
  };
  const state = entry.state.value;
  const controller: QueryController<Data, Args> = {
    get data() {
      return state.data as Data | undefined;
    },
    get lastData() {
      return state.lastData as Data | undefined;
    },
    get error() {
      return state.error;
    },
    get isFetching() {
      return state.isFetching;
    },
    get isRefetching() {
      return state.isRefetching;
    },
    get isFailed() {
      return state.isFailed;
    },
    refetch(options: QueryCallOptions = {}, ...args: Args): Promise<Data> {
      validateOptionsObject(options, "$query().refetch() options");
      const call = snapshotOwnDataProperties(options, "$query().refetch() options", ["suspense"]);
      validateOptionalBoolean(call.suspense, "$query().refetch() suspense");
      if (args.length > 0) currentArgs = [...args] as Args;
      return execute((call.suspense as boolean | undefined) ?? suspenseRefetch);
    },
  };

  if (
    enabled &&
    !(frame.ssrRerender && state.hasData) &&
    (!state.hasData || Date.now() - state.updatedAt >= staleTime)
  ) {
    const automatic = execute(state.hasData ? suspenseRefetch : suspenseInitial);
    void automatic.catch(() => {});
  }

  if (enabled && pollingInterval !== undefined && typeof document !== "undefined") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (disposed || document.visibilityState === "hidden") return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed && document.visibilityState !== "hidden" && !entry.inFlight) {
          void execute(suspenseRefetch).catch(() => {});
        }
        schedule();
      }, pollingInterval);
    };
    const visibilityChanged = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (document.visibilityState !== "hidden") schedule();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    schedule();
    owner.push(() => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    });
  }

  return Object.freeze(controller);
}

export function $mutation<Data, Args extends unknown[]>(
  config: MutationConfig<Data, Args>,
): MutationController<Data, Args> {
  return createMutation(config);
}

export function mutationInFrame<Data, Args extends unknown[]>(
  config: MutationConfig<Data, Args>,
  frame: RenderFrame,
): MutationController<Data, Args> {
  assertSetupActive(frame, "$mutation()");
  return createMutation(config, frame.owner, frame);
}

function createMutation<Data, Args extends unknown[]>(
  config: MutationConfig<Data, Args>,
  explicitOwner?: Cleanup[],
  explicitFrame?: RenderFrame,
): MutationController<Data, Args> {
  validateOptionsObject(config, "$mutation() config");
  const snapshot = snapshotOwnDataProperties(config, "$mutation() config", [
    "mutation",
    "suspense",
  ]);
  const mutation = snapshot.mutation;
  if (typeof mutation !== "function") {
    throw new TypeError("$mutation() mutation must be a function");
  }
  validateOptionalBoolean(snapshot.suspense, "$mutation() suspense");
  const suspense = (snapshot.suspense as boolean | undefined) ?? false;
  const active =
    explicitOwner && explicitFrame
      ? { owner: explicitOwner, frame: explicitFrame }
      : activeComponent("$mutation()");
  const { owner, frame } = active;
  assertOwnerActive(owner, "$mutation()");
  const state = $signal<MutationState<Data>>({
    data: undefined,
    lastData: undefined,
    error: undefined,
    hasData: false,
    isMutating: false,
    isFailed: false,
  });
  let generation = 0;
  let disposed = false;
  const devtoolsId = devtoolsMutationCreated(
    requestSources.get(config),
    rpcFunctionMetadata(mutation)?.name,
  );
  owner.push(() => {
    disposed = true;
    generation += 1;
    devtoolsMutationDisposed(devtoolsId);
  });

  const controller: MutationController<Data, Args> = {
    get data() {
      return state.value.data;
    },
    get lastData() {
      return state.value.lastData;
    },
    get error() {
      return state.value.error;
    },
    get isMutating() {
      return state.value.isMutating;
    },
    get isFailed() {
      return state.value.isFailed;
    },
    mutate(options: MutationCallOptions, ...args: Args): Promise<Data> {
      validateOptionsObject(options, "$mutation().mutate() options");
      const call = snapshotOwnDataProperties(options, "$mutation().mutate() options", ["suspense"]);
      validateOptionalBoolean(call.suspense, "$mutation().mutate() suspense");
      if (disposed) return Promise.reject(new Error("$mutation() controller has been disposed"));
      const currentGeneration = ++generation;
      batch(() => {
        state.value.isMutating = true;
        state.value.isFailed = false;
        state.value.error = undefined;
      });
      devtoolsMutationUpdated(devtoolsId, { ...state.value, args });
      const promise = invokeAsync(
        "$mutation()",
        mutation as (...args: Args) => PromiseLike<Data>,
        args,
      );
      trackSuspense(promise, (call.suspense as boolean | undefined) ?? suspense, owner, frame);
      void promise.then(
        (data) => {
          if (disposed || currentGeneration !== generation) return;
          batch(() => {
            if (state.value.hasData) state.value.lastData = state.value.data;
            state.value.data = data;
            state.value.hasData = true;
            state.value.isMutating = false;
          });
          devtoolsMutationUpdated(devtoolsId, { ...state.value, args });
        },
        (error) => {
          if (disposed || currentGeneration !== generation) return;
          batch(() => {
            state.value.error = error;
            state.value.isFailed = true;
            state.value.isMutating = false;
          });
          devtoolsMutationUpdated(devtoolsId, { ...state.value, args });
        },
      );
      return promise;
    },
  };
  return Object.freeze(controller);
}
