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
  readonly onEmpty?: () => void;
}

interface ReactiveEffect {
  active: boolean;
  computed: boolean;
  running: boolean;
  dependencies: Set<Dependency>;
  run: () => void;
}

interface EffectQueue {
  readonly computed: Set<ReactiveEffect>;
  readonly regular: Set<ReactiveEffect>;
}

const ITERATE = Symbol("sol.iterate");
const PROTOTYPE = Symbol("sol.prototype");
const EXTENSIBLE = Symbol("sol.extensible");
const SIGNAL = Symbol("sol.signal");
const dependencies = new WeakMap<object, Map<PropertyKey, Dependency>>();
const descriptorDependencies = new WeakMap<object, Map<PropertyKey, symbol>>();
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
let capturedEffects: EffectQueue | undefined;
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
    if (dependency.effects.size === 0) {
      dependency.target.delete(dependency.key);
      dependency.onEmpty?.();
    }
  }
  effect.dependencies.clear();
}

function track(target: object, key: PropertyKey, onEmpty?: () => void): void {
  if (!activeEffect?.active) return;
  let targetDependencies = dependencies.get(target);
  if (!targetDependencies) {
    targetDependencies = new Map();
    dependencies.set(target, targetDependencies);
  }
  let dependency = targetDependencies.get(key);
  if (!dependency) {
    dependency = { effects: new Set(), key, onEmpty, target: targetDependencies };
    targetDependencies.set(key, dependency);
  }
  dependency.effects.add(activeEffect);
  activeEffect.dependencies.add(dependency);
}

function descriptorDependency(target: object, key: PropertyKey, create = true): symbol | undefined {
  let targetDependencies = descriptorDependencies.get(target);
  if (!targetDependencies) {
    if (!create) return undefined;
    targetDependencies = new Map();
    descriptorDependencies.set(target, targetDependencies);
  }
  let dependency = targetDependencies.get(key);
  if (!dependency && create) {
    dependency = Symbol("sol.descriptor");
    targetDependencies.set(key, dependency);
  }
  return dependency;
}

function trackDescriptor(target: object, key: PropertyKey): void {
  if (!activeEffect?.active) return;
  const dependency = descriptorDependency(target, key)!;
  track(target, dependency, () => descriptorDependencies.get(target)?.delete(key));
}

function runEffectQueue(queue: EffectQueue): void {
  const failures: unknown[] = [];
  while (queue.computed.size > 0 || queue.regular.size > 0) {
    const effect = queue.computed.values().next().value ?? queue.regular.values().next().value;
    if (!effect) break;
    queue.computed.delete(effect);
    queue.regular.delete(effect);
    try {
      effect.run();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Multiple reactive effects failed");
  }
}

function flushEffects(): void {
  if (flushingEffects) return;
  flushingEffects = true;
  try {
    runEffectQueue({ computed: pendingComputedEffects, regular: pendingEffects });
  } finally {
    flushingEffects = false;
  }
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
      if (capturedEffects) {
        pendingComputedEffects.delete(effect);
        pendingEffects.delete(effect);
        (effect.computed ? capturedEffects.computed : capturedEffects.regular).add(effect);
      } else {
        (effect.computed ? pendingComputedEffects : pendingEffects).add(effect);
      }
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

export function transactionalBatch<T>(callback: () => T): T {
  if (capturedEffects) return callback();
  const queue: EffectQueue = { computed: new Set(), regular: new Set() };
  capturedEffects = queue;
  let result: T | undefined;
  let callbackFailed = false;
  let callbackFailure: unknown;
  try {
    result = callback();
  } catch (error) {
    callbackFailed = true;
    callbackFailure = error;
  }
  let effectsFailed = false;
  let effectFailure: unknown;
  try {
    runEffectQueue(queue);
  } catch (error) {
    effectsFailed = true;
    effectFailure = error;
  } finally {
    capturedEffects = undefined;
  }
  if (callbackFailed && effectsFailed) {
    throw new AggregateError(
      [callbackFailure, effectFailure],
      "Transaction callback and reactive effects failed",
    );
  }
  if (callbackFailed) throw callbackFailure;
  if (effectsFailed) throw effectFailure;
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
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
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

function existingProxy<T extends object>(target: T): T | undefined {
  if (proxyTargets.has(target)) return target;
  return proxyCache.get(target) as T | undefined;
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

function descriptorShapesEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      "value" in left === "value" in right &&
      left.get === right.get &&
      left.set === right.set &&
      left.writable === right.writable &&
      left.enumerable === right.enumerable &&
      left.configurable === right.configurable)
  );
}

export function reactive<T extends object>(target: T): T {
  const cached = existingProxy(target);
  if (cached) return cached;

  const setOperations: Array<{ key: PropertyKey; handled: boolean }> = [];
  let arrayMutatorWrappers:
    | Map<
        string,
        {
          method: (...args: unknown[]) => unknown;
          wrapper: (...args: unknown[]) => unknown;
        }
      >
    | undefined;
  const invalidate = (
    key: PropertyKey,
    wasPresent: boolean,
    oldLength: number,
    iterationChanged: boolean,
    descriptorChanged: boolean,
  ): void => {
    if (Array.isArray(target) && key === "length") {
      const removed = dependencies.get(target)
        ? [...dependencies.get(target)!.keys()].filter(
            (dependency) =>
              (dependency === ITERATE && target.length < oldLength) ||
              (typeof dependency === "string" &&
                /^(0|[1-9]\d*)$/.test(dependency) &&
                Number(dependency) >= target.length),
          )
        : [];
      triggerMany(
        target,
        [
          "length",
          ...removed.flatMap((dependency) => [
            dependency,
            descriptorDependency(target, dependency, false),
          ]),
        ].filter((dependency): dependency is PropertyKey => dependency !== undefined),
      );
      return;
    }
    const affected: Array<PropertyKey | undefined> = [key];
    if (descriptorChanged) affected.push(descriptorDependency(target, key, false));
    if (!wasPresent || iterationChanged) affected.push(ITERATE);
    if (Array.isArray(target) && target.length !== oldLength) affected.push("length");
    triggerMany(
      target,
      affected.filter((dependency): dependency is PropertyKey => dependency !== undefined),
    );
  };

  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      track(object, key);
      const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
      if (
        descriptor &&
        "value" in descriptor &&
        descriptor.configurable === false &&
        descriptor.writable === false
      ) {
        return descriptor.value;
      }
      const value = Reflect.get(object, key, receiver) as unknown;
      if (
        Array.isArray(object) &&
        typeof key === "string" &&
        mutatingArrayMethods.has(key) &&
        !Object.hasOwn(object, key) &&
        value === Reflect.get(Array.prototype, key)
      ) {
        const method = value as (...values: unknown[]) => unknown;
        let cachedWrapper = arrayMutatorWrappers?.get(key);
        if (cachedWrapper?.method !== method) {
          const wrapper = function (this: unknown, ...args: unknown[]) {
            return batch(() => Reflect.apply(method, this, args));
          };
          cachedWrapper = { method, wrapper };
          (arrayMutatorWrappers ??= new Map()).set(key, cachedWrapper);
        }
        return cachedWrapper.wrapper;
      }
      return wrap(value);
    },
    has(object, key) {
      track(object, key);
      return Reflect.has(object, key);
    },
    getOwnPropertyDescriptor(object, key) {
      trackDescriptor(object, key);
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
    getPrototypeOf(object) {
      track(object, PROTOTYPE);
      return Reflect.getPrototypeOf(object);
    },
    set(object, key, value, receiver) {
      const previous = Reflect.getOwnPropertyDescriptor(object, key);
      const wasPresent = previous !== undefined;
      const oldValue = previous && "value" in previous ? unwrap(previous.value) : undefined;
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
      const isPresent = Object.prototype.hasOwnProperty.call(object, key);
      const current = Reflect.getOwnPropertyDescriptor(object, key);
      const dataUnchanged = previous && "value" in previous && Object.is(oldValue, nextValue);
      if (changed && !operation.handled && !dataUnchanged) {
        invalidate(
          key,
          wasPresent || !isPresent,
          oldLength,
          wasPresent !== isPresent,
          !descriptorShapesEqual(previous, current),
        );
      }
      return changed;
    },
    defineProperty(object, key, descriptor) {
      const previous = Object.getOwnPropertyDescriptor(object, key);
      const oldLength = Array.isArray(object) ? object.length : 0;
      const remainsDataProperty =
        "value" in descriptor ||
        "writable" in descriptor ||
        (!("get" in descriptor) &&
          !("set" in descriptor) &&
          previous !== undefined &&
          "value" in previous);
      const configurable = descriptor.configurable ?? previous?.configurable ?? false;
      const writable =
        descriptor.writable ?? (previous && "writable" in previous ? previous.writable : false);
      if (!configurable && !writable && remainsDataProperty) {
        const value = "value" in descriptor ? descriptor.value : previous?.value;
        if (isObject(value)) {
          const childProxy = existingProxy(value);
          if (childProxy !== undefined && childProxy !== value) return false;
        }
      }
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
            !descriptorShapesEqual(previous, current),
          );
        }
      }
      return defined;
    },
    preventExtensions(object) {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(object))) {
        if ("value" in descriptor && isObject(descriptor.value)) {
          const childProxy = existingProxy(descriptor.value);
          if (childProxy !== undefined && childProxy !== descriptor.value) return false;
        }
      }
      const wasExtensible = Reflect.isExtensible(object);
      const prevented = Reflect.preventExtensions(object);
      if (prevented && wasExtensible && !Reflect.isExtensible(object)) trigger(object, EXTENSIBLE);
      return prevented;
    },
    isExtensible(object) {
      track(object, EXTENSIBLE);
      return Reflect.isExtensible(object);
    },
    setPrototypeOf(object, prototype) {
      const previous = Reflect.getPrototypeOf(object);
      const changed = Reflect.setPrototypeOf(object, prototype);
      if (changed && prototype !== previous) {
        const descriptorKeys = new Set(descriptorDependencies.get(object)?.values());
        const inheritedDependencies = [...(dependencies.get(object)?.keys() ?? [])].filter(
          (key) =>
            key !== ITERATE &&
            key !== PROTOTYPE &&
            key !== EXTENSIBLE &&
            !descriptorKeys.has(key as symbol) &&
            !Object.prototype.hasOwnProperty.call(object, key),
        );
        triggerMany(object, [PROTOTYPE, ITERATE, ...inheritedDependencies]);
      }
      return changed;
    },
    deleteProperty(object, key) {
      const wasPresent = Object.prototype.hasOwnProperty.call(object, key);
      const deleted = Reflect.deleteProperty(object, key);
      if (deleted && wasPresent) {
        const descriptor = descriptorDependency(object, key, false);
        triggerMany(object, descriptor ? [key, descriptor, ITERATE] : [key, ITERATE]);
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
  if (!isObject(value)) return value;
  const cached = existingProxy(value);
  if (cached) return cached as T;
  return isReactiveTarget(value) ? (reactive(value) as T) : value;
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
