import type { Cleanup, RenderFrame } from "./rendering.ts";

export interface Signal<T> {
  value: T;
}

export interface ReadonlySignal<T> {
  readonly value: T;
}

interface Dependency {
  readonly effects: Set<ReactiveEffect>;
  readonly key: PropertyKey;
  readonly target: Map<PropertyKey, Dependency>;
}

interface ReactiveEffect {
  active: boolean;
  computed: boolean;
  running: boolean;
  dependencies: Set<Dependency>;
  run: () => void;
}

const ITERATE = Symbol("sol.iterate");
const SIGNAL = Symbol("sol.signal");
const dependencies = new WeakMap<object, Map<PropertyKey, Dependency>>();
const proxyCache = new WeakMap<object, object>();
const proxyTargets = new WeakMap<object, object>();
const mutatingArrayMethods = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
let activeEffect: ReactiveEffect | undefined;
export const runtimeState: { activeOwner?: Cleanup[]; activeFrame?: RenderFrame } = {};
let batchDepth = 0;
let flushingEffects = false;
const pendingEffects = new Set<ReactiveEffect>();
const pendingComputedEffects = new Set<ReactiveEffect>();
const disposedOwners = new WeakSet<Cleanup[]>();

export function runDisposals(disposals: readonly Cleanup[]): void {
  const failures: unknown[] = [];
  for (const dispose of disposals) {
    try {
      dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Multiple disposal callbacks failed");
}

export function runCleanups(cleanups: readonly Cleanup[]): void {
  runDisposals(cleanups.toReversed());
}

export function rethrowWithCleanups(error: unknown, cleanups: readonly Cleanup[]): never {
  return rethrowWithDisposals(
    error,
    [() => runCleanups(cleanups)],
    "Render and cleanup both failed",
  );
}

export function rethrowWithDisposals(
  error: unknown,
  disposals: readonly Cleanup[],
  message: string,
): never {
  try {
    runDisposals(disposals);
  } catch (disposalError) {
    // oxlint-disable-next-line preserve-caught-error -- AggregateError retains both failures and sets the primary cause.
    throw new AggregateError([error, disposalError], message, {
      cause: error,
    });
  }
  throw error;
}

export function disposeOwner(owner: Cleanup[]): void {
  if (disposedOwners.has(owner)) return;
  disposedOwners.add(owner);
  runCleanups(owner);
}

export function assertOwnerActive(owner: Cleanup[], label: string): void {
  if (disposedOwners.has(owner)) throw new Error(`${label} owner has been disposed`);
}

function cleanupEffect(effect: ReactiveEffect): void {
  for (const dependency of effect.dependencies) {
    dependency.effects.delete(effect);
    if (dependency.effects.size === 0) dependency.target.delete(dependency.key);
  }
  effect.dependencies.clear();
}

function track(target: object, key: PropertyKey): void {
  if (!activeEffect?.active) return;
  let targetDependencies = dependencies.get(target);
  if (!targetDependencies) {
    targetDependencies = new Map();
    dependencies.set(target, targetDependencies);
  }
  let dependency = targetDependencies.get(key);
  if (!dependency) {
    dependency = { effects: new Set(), key, target: targetDependencies };
    targetDependencies.set(key, dependency);
  }
  dependency.effects.add(activeEffect);
  activeEffect.dependencies.add(dependency);
}

function flushEffects(): void {
  if (flushingEffects) return;
  flushingEffects = true;
  let failed = false;
  let failure: unknown;
  try {
    while (pendingComputedEffects.size > 0 || pendingEffects.size > 0) {
      const effect =
        pendingComputedEffects.values().next().value ?? pendingEffects.values().next().value;
      if (!effect) break;
      pendingComputedEffects.delete(effect);
      pendingEffects.delete(effect);
      try {
        effect.run();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  } finally {
    flushingEffects = false;
  }
  if (failed) throw failure;
}

function triggerMany(target: object, keys: Iterable<PropertyKey>): void {
  const targetDependencies = dependencies.get(target);
  if (!targetDependencies) return;
  const effects = new Set<ReactiveEffect>();
  for (const key of keys) {
    for (const effect of targetDependencies.get(key)?.effects ?? []) effects.add(effect);
  }
  for (const effect of effects) {
    if (effect.active && !effect.running) {
      (effect.computed ? pendingComputedEffects : pendingEffects).add(effect);
    }
  }
  if (batchDepth === 0 && !flushingEffects) flushEffects();
}

function trigger(target: object, key: PropertyKey): void {
  triggerMany(target, [key]);
}

export function batch<T>(callback: () => T): T {
  batchDepth += 1;
  let result: T | undefined;
  let callbackFailed = false;
  let callbackFailure: unknown;
  try {
    result = callback();
  } catch (error) {
    callbackFailed = true;
    callbackFailure = error;
  } finally {
    batchDepth -= 1;
  }
  let flushFailed = false;
  let flushFailure: unknown;
  if (batchDepth === 0) {
    try {
      flushEffects();
    } catch (error) {
      flushFailed = true;
      flushFailure = error;
    }
  }
  if (callbackFailed && flushFailed) {
    throw new AggregateError(
      [callbackFailure, flushFailure],
      "Batch callback and reactive flush failed",
    );
  }
  if (callbackFailed) throw callbackFailure;
  if (flushFailed) throw flushFailure;
  return result as T;
}

function createReactiveEffect(
  callback: () => void,
  computed: boolean,
  explicitOwner?: Cleanup[],
): Cleanup {
  const effect: ReactiveEffect = {
    active: true,
    computed,
    running: false,
    dependencies: new Set(),
    run() {
      if (!effect.active || effect.running) return;
      cleanupEffect(effect);
      const previousEffect = activeEffect;
      activeEffect = effect;
      effect.running = true;
      try {
        callback();
      } finally {
        effect.running = false;
        activeEffect = previousEffect;
      }
    },
  };
  const stop = () => {
    if (!effect.active) return;
    effect.active = false;
    pendingEffects.delete(effect);
    pendingComputedEffects.delete(effect);
    cleanupEffect(effect);
  };
  const owner = explicitOwner ?? runtimeState.activeOwner;
  const ownerWasDisposed = owner ? disposedOwners.has(owner) : false;
  if (owner && !ownerWasDisposed) owner.push(stop);
  try {
    effect.run();
    if (ownerWasDisposed) stop();
  } catch (error) {
    stop();
    if (owner && !ownerWasDisposed) {
      const index = owner.lastIndexOf(stop);
      if (index >= 0) owner.splice(index, 1);
    }
    throw error;
  }
  return stop;
}

export function runtimeEffect(callback: () => void): Cleanup {
  return createReactiveEffect(callback, false);
}

export function untrack<T>(callback: () => T): T {
  const previousEffect = activeEffect;
  activeEffect = undefined;
  try {
    return callback();
  } finally {
    activeEffect = previousEffect;
  }
}

export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

export function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return isObject(value) && typeof (value as { then?: unknown }).then === "function";
}

function isReactiveTarget(value: object): boolean {
  if (!Object.isExtensible(value)) return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function unwrap<T>(value: T): T {
  if (!isObject(value)) return value;
  return (proxyTargets.get(value) ?? value) as T;
}

function descriptorsEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    "value" in left === "value" in right &&
    Object.is(left.value, right.value) &&
    left.get === right.get &&
    left.set === right.set &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable
  );
}

export function reactive<T extends object>(target: T): T {
  if (proxyTargets.has(target)) return target;
  const cached = proxyCache.get(target);
  if (cached) return cached as T;

  const setOperations: Array<{ key: PropertyKey; handled: boolean }> = [];
  const invalidate = (
    key: PropertyKey,
    wasPresent: boolean,
    oldLength: number,
    iterationChanged: boolean,
  ): void => {
    if (Array.isArray(target) && key === "length") {
      const removed = dependencies.get(target)
        ? [...dependencies.get(target)!.keys()].filter(
            (dependency) =>
              dependency === ITERATE ||
              (typeof dependency === "string" &&
                /^(0|[1-9]\d*)$/.test(dependency) &&
                Number(dependency) >= target.length),
          )
        : [];
      triggerMany(target, ["length", ...removed]);
      return;
    }
    const affected: PropertyKey[] = [key];
    if (!wasPresent || iterationChanged) affected.push(ITERATE);
    if (Array.isArray(target) && target.length !== oldLength) affected.push("length");
    triggerMany(target, affected);
  };

  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      if (Array.isArray(object) && typeof key === "string" && mutatingArrayMethods.has(key)) {
        return (...args: unknown[]) =>
          batch(() => {
            const method = Reflect.get(object, key, receiver) as (...values: unknown[]) => unknown;
            return method.apply(receiver, args);
          });
      }
      track(object, key);
      const value = Reflect.get(object, key, receiver) as unknown;
      return wrap(value);
    },
    has(object, key) {
      track(object, key);
      return Reflect.has(object, key);
    },
    set(object, key, value, receiver) {
      const wasPresent = Object.prototype.hasOwnProperty.call(object, key);
      const oldValue = unwrap(Reflect.get(object, key, receiver) as unknown);
      const nextValue = unwrap(value);
      const oldLength = Array.isArray(object) ? object.length : 0;
      const operation = { key, handled: false };
      setOperations.push(operation);
      let changed: boolean;
      try {
        changed = Reflect.set(object, key, nextValue, receiver);
      } finally {
        setOperations.pop();
      }
      if (changed && !operation.handled && (!wasPresent || !Object.is(oldValue, nextValue))) {
        invalidate(key, wasPresent, oldLength, !wasPresent);
      }
      return changed;
    },
    defineProperty(object, key, descriptor) {
      const previous = Object.getOwnPropertyDescriptor(object, key);
      const oldLength = Array.isArray(object) ? object.length : 0;
      const defined = Reflect.defineProperty(object, key, descriptor);
      if (defined) {
        const current = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptorsEqual(previous, current)) {
          const operation = setOperations.at(-1);
          if (operation?.key === key) operation.handled = true;
          invalidate(
            key,
            previous !== undefined,
            oldLength,
            previous?.enumerable !== current?.enumerable,
          );
        }
      }
      return defined;
    },
    deleteProperty(object, key) {
      const wasPresent = Object.prototype.hasOwnProperty.call(object, key);
      const deleted = Reflect.deleteProperty(object, key);
      if (deleted && wasPresent) {
        triggerMany(object, [key, ITERATE]);
      }
      return deleted;
    },
    ownKeys(object) {
      track(object, ITERATE);
      return Reflect.ownKeys(object);
    },
  });
  proxyCache.set(target, proxy);
  proxyTargets.set(proxy, target);
  return proxy;
}

function wrap<T>(value: T): T {
  return isObject(value) && isReactiveTarget(value) ? (reactive(value) as T) : value;
}

export function $signal<T>(initial: T): Signal<T> {
  let value = wrap(initial);
  const reference = {
    [SIGNAL]: true,
    get value(): T {
      track(reference, "value");
      return value;
    },
    set value(next: T) {
      const currentValue = unwrap(value);
      const nextValue = unwrap(next);
      if (Object.is(currentValue, nextValue)) return;
      value = wrap(nextValue);
      trigger(reference, "value");
    },
  };
  return reference;
}

function createComputed<T>(derive: () => T, frame?: RenderFrame): ReadonlySignal<T> {
  if (typeof derive !== "function") throw new TypeError("$computed() expects a function");
  const value = $signal<T>(undefined as T);
  createReactiveEffect(
    () => {
      value.value = derive();
    },
    true,
    frame?.owner,
  );
  return Object.freeze({
    get value(): T {
      return value.value;
    },
  });
}

export function $computed<T>(derive: () => T): ReadonlySignal<T> {
  return createComputed(derive);
}

export function computedInFrame<T>(derive: () => T, frame: RenderFrame): ReadonlySignal<T> {
  return createComputed(derive, frame);
}
