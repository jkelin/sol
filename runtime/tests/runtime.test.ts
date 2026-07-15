import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as v from "valibot";
import { z } from "zod";
import { $component, $context, contextUse, Head, type Context } from "../src/components.ts";
import { normalizeClass } from "../src/dom.ts";
import { $form, formInFrame, type FormConfig, type FormController } from "../src/forms.ts";
import {
  $computed,
  $signal,
  reactive,
  rethrowWithCleanups,
  type Signal,
} from "../src/reactivity.ts";
import { createRef, type Ref } from "../src/refs.ts";
import { hydrate } from "../src/hydrate.ts";
import { mount, resolvedBlock, rootFrame, type Block, type RenderFrame } from "../src/rendering.ts";
import type { ServerRegion } from "../src/server-rendering.ts";
import { renderToStringAsync } from "../src/ssr.ts";
import { HydrationSession, SsrSession } from "../src/ssr-session.ts";
import { transition } from "../src/transitions.ts";
import {
  attribute,
  batch,
  bindValue,
  block,
  blockLifecycle,
  child,
  component,
  configureRouteBase,
  configureRouteRuntime,
  instantiate,
  lazyRoute,
  list,
  link,
  rawText,
  isRouteDefinition,
  route,
  renderComponent,
  resolveRoute,
  routeHref,
  routeRead,
  runtimeEffect,
  ref,
  template,
  text,
  when,
} from "../src/compiler-runtime.ts";

let window: Window;
let formDisposals: Array<() => void>;

async function rejection(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

function deferredPromise(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function retiringBlock(finished: Promise<void>, disposalError?: Error): Block {
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode("retiring"));
  const rendered = block(fragment);
  return {
    ...rendered,
    leave: () => finished,
    dispose() {
      rendered.dispose();
      if (disposalError) throw disposalError;
    },
  };
}

beforeEach(() => {
  window = new Window();
  formDisposals = [];
  delete (window.Element.prototype as { getAnimations?: unknown }).getAnimations;
  Object.assign(globalThis, {
    window,
    document: window.document,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Element: window.Element,
    HTMLSelectElement: window.HTMLSelectElement,
  });
});

describe("DOM refs", () => {
  test("attaches after insertion, switches reactively, and clears on disposal", () => {
    const definition = template('<button data-sol-e="0">Focus</button>');
    const view = instantiate(definition);
    const cleanups: (() => void)[] = [];
    const lifecycle = blockLifecycle();
    const objectRef = createRef<HTMLButtonElement>();
    const firstCalls: Array<HTMLButtonElement | null> = [];
    const callbackRef: Ref<HTMLButtonElement> = (element) => firstCalls.push(element);
    const activeRef = $signal<Ref<HTMLButtonElement>>(objectRef);
    ref(view.elements[0] as HTMLButtonElement, () => activeRef.value, cleanups, lifecycle);
    const rendered = block(view.fragment, cleanups, lifecycle);
    document.body.append(document.createElement("main"));
    const target = document.body.querySelector("main")!;

    expect(objectRef.current).toBeNull();
    rendered.mount(target);
    expect(objectRef.current?.isConnected).toBe(true);

    activeRef.value = callbackRef;
    expect(objectRef.current).toBeNull();
    expect(firstCalls).toEqual([target.querySelector("button")]);

    rendered.dispose();
    expect(firstCalls).toEqual([expect.any(window.HTMLButtonElement), null]);
  });

  test("validates ref constructors and structural objects", () => {
    expect(() => (createRef as (...values: unknown[]) => unknown)(null)).toThrow(
      "does not accept an initial value",
    );
    const element = document.createElement("button");
    const lifecycle = blockLifecycle();
    expect(() => ref(element, () => [], [], lifecycle)).toThrow("callback or an object");
    const readonly = {};
    Object.defineProperty(readonly, "current", { value: null });
    expect(() => ref(element, () => readonly, [], lifecycle)).toThrow("must be writable");
  });
});

afterEach(() => {
  for (const dispose of formDisposals) dispose();
  window.close();
});

function noopSubmit(): void {}

function ownedForm<TValues extends Record<string, unknown>, TOutput>(
  config: FormConfig<TValues, TOutput>,
  onSubmit: (values: TOutput) => void | PromiseLike<void>,
): FormController<TValues> {
  let form!: FormController<TValues>;
  const Owner = component((_props, frame) => {
    form = formInFrame(frame, config, onSubmit);
    return block(document.createDocumentFragment());
  });
  const rendered = renderComponent(Owner);
  formDisposals.push(() => rendered.dispose());
  return form;
}

interface ControlledAnimation {
  animation: Animation;
  cancelled: boolean;
  finish(): void;
}

function installAnimations(): ControlledAnimation[] {
  const animations: ControlledAnimation[] = [];
  const current = new WeakMap<Element, { signature: string; controlled: ControlledAnimation }>();
  Object.defineProperty(window.Element.prototype, "getAnimations", {
    configurable: true,
    value(this: Element): Animation[] {
      const signature = [...this.classList]
        .filter((className) => className.startsWith("transition-"))
        .join(" ");
      if (!signature) return [];
      const existing = current.get(this);
      if (existing?.signature === signature) return [existing.controlled.animation];
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const controlled: ControlledAnimation = {
        animation: undefined as unknown as Animation,
        cancelled: false,
        finish,
      };
      controlled.animation = {
        finished,
        cancel() {
          controlled.cancelled = true;
          finish();
        },
      } as unknown as Animation;
      animations.push(controlled);
      current.set(this, { signature, controlled });
      return [controlled.animation];
    },
  });
  return animations;
}

describe("forms", () => {
  test("validates its public boundary", () => {
    expect(() =>
      $form({ schema: (value: object) => value, defaultValues: {} }, noopSubmit),
    ).toThrow("component setup");
    expect(() => ownedForm(undefined as never, noopSubmit)).toThrow("expects a config object");
    expect(() =>
      ownedForm({ schema: {} as never, defaultValues: { title: "" } }, noopSubmit),
    ).toThrow("schema must be callable");
    expect(() =>
      ownedForm(
        {
          schema: (values: { title: string }) => values,
          defaultValues: { title: "" },
          validationStrategy: "later" as never,
        },
        noopSubmit,
      ),
    ).toThrow("validationStrategy");

    let configReads = 0;
    const accessorConfig = Object.defineProperties(
      {},
      {
        schema: { enumerable: true, value: (value: object) => value },
        defaultValues: {
          enumerable: true,
          get() {
            configReads += 1;
            return configReads === 1 ? {} : [];
          },
        },
      },
    );
    expect(() => ownedForm(accessorConfig as never, noopSubmit)).toThrow("data property");
    expect(configReads).toBe(0);
    expect(() =>
      ownedForm(Object.create({ schema: (value: object) => value, defaultValues: {} }), noopSubmit),
    ).toThrow("defaultValues");
    expect(() =>
      ownedForm(
        Object.assign(
          { schema: (value: object) => value, defaultValues: {} },
          { [Symbol("extra")]: true },
        ),
        noopSubmit,
      ),
    ).toThrow("unknown property");
    expect(() =>
      (formInFrame as (...args: unknown[]) => unknown)(rootFrame(), {
        schema: (values: { title: string }) => values,
        defaultValues: { title: "" },
      }),
    ).toThrow("submit function");
  });

  test("preserves prototype-named fields and validation paths", async () => {
    const defaults = { constructor: "ctor" } as Record<string, string>;
    Object.defineProperty(defaults, "__proto__", {
      configurable: true,
      enumerable: true,
      value: "proto",
      writable: true,
    });
    const form = ownedForm(
      {
        defaultValues: defaults,
        schema: () => {
          throw {
            issues: [
              { path: ["__proto__"], message: "Proto issue" },
              { path: ["constructor"], message: "Constructor issue" },
            ],
          };
        },
      },
      noopSubmit,
    );

    expect(Object.hasOwn(form.values, "__proto__")).toBe(true);
    expect(form.values.__proto__).toBe("proto");
    expect(await form.submit()).toBe(false);
    expect(form.errors.__proto__).toEqual(["Proto issue"]);
    expect(form.errors["constructor"]).toEqual(["Constructor issue"]);
  });

  test("clones cyclic and aliased form values without sharing input state", () => {
    interface CyclicValues {
      [key: string]: unknown;
      left: { value: number };
      right: { value: number };
      self?: CyclicValues;
    }
    const sharedChild = { value: 1 };
    const defaults: CyclicValues = { left: sharedChild, right: sharedChild };
    defaults.self = defaults;
    const form = ownedForm(
      { schema: (value: CyclicValues) => value, defaultValues: defaults },
      () => {},
    );
    expect(form.values).not.toBe(defaults);
    expect(form.values.self).toBe(form.values);
    expect(form.values.left).toBe(form.values.right);
    expect(form.values.left).not.toBe(sharedChild);

    const resetChild = { value: 2 };
    const reset: CyclicValues = { left: resetChild, right: resetChild };
    reset.self = reset;
    form.reset(reset);
    expect(form.values.self).toBe(form.values);
    expect(form.values.left).toBe(form.values.right);
    expect(form.values.left).not.toBe(resetChild);
  });

  test("submits transformed Valibot output and resets controller-owned values", async () => {
    const schema = v.object({
      title: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1, "A title is required."),
        v.maxLength(5, "Use at most five characters."),
      ),
    });
    const submissions: { title: string }[] = [];
    const form = ownedForm({ schema: v.parser(schema), defaultValues: { title: "" } }, (values) => {
      submissions.push(values);
    });

    expect(await form.submit()).toBe(false);
    expect(form.errors.title).toEqual(["A title is required."]);
    form.values.title = "  note  ";
    expect(await form.submit()).toBe(true);
    expect(submissions).toEqual([{ title: "note" }]);

    form.reset({ title: "other" });
    form.values.title = "changed";
    form.reset();
    expect(form.values).toEqual({ title: "" });
    expect(form.errors).toEqual({});
  });

  test("uses Zod parseAsync and normalizes field and form issues", async () => {
    const form = ownedForm(
      {
        schema: z.object({
          profile: z.object({ name: z.string().min(2, "Name is too short.") }),
        }),
        defaultValues: { profile: { name: "" } },
      },
      () => {},
    );

    expect(await form.submit()).toBe(false);
    expect(form.errors["profile.name"]).toEqual(["Name is too short."]);

    const rootForm = ownedForm(
      {
        schema: z.object({ title: z.string() }).refine(() => false, "Form is invalid."),
        defaultValues: { title: "ok" },
      },
      () => {},
    );
    expect(await rootForm.submit()).toBe(false);
    expect(rootForm.formErrors).toEqual(["Form is invalid."]);
  });

  test("preserves multiple messages and rethrows non-validation errors", async () => {
    const failure = {
      issues: [
        { path: ["title"], message: "First problem." },
        { path: [{ key: "title" }], message: "Second problem." },
        { path: [], message: "Form problem." },
      ],
    };
    const form = ownedForm(
      {
        schema: { parse: (_values: { title: string }) => Promise.reject(failure) } as never,
        defaultValues: { title: "" },
      },
      () => {},
    );
    expect(await form.submit()).toBe(false);
    expect(form.errors.title).toEqual(["First problem.", "Second problem."]);
    expect(form.formErrors).toEqual(["Form problem."]);

    const unexpected = new Error("Network failed");
    const broken = ownedForm(
      { schema: () => Promise.reject(unexpected), defaultValues: { title: "" } },
      () => {},
    );
    const objectPrototype = Object.prototype as { issues?: unknown };
    Object.defineProperty(objectPrototype, "issues", { configurable: true, value: [] });
    try {
      expect(broken.submit()).rejects.toBe(unexpected);
    } finally {
      delete objectPrototype.issues;
    }

    let messageReads = 0;
    const accessorFailure = {
      issues: [
        Object.defineProperty({}, "message", {
          enumerable: true,
          get() {
            messageReads += 1;
            return "hidden";
          },
        }),
      ],
    };
    const accessorForm = ownedForm(
      { schema: () => Promise.reject(accessorFailure), defaultValues: { title: "" } },
      () => {},
    );
    expect(accessorForm.submit()).rejects.toBe(accessorFailure);
    expect(messageReads).toBe(0);
  });

  test("tracks submission state and prevents duplicate submissions", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    let submissions = 0;
    const form = ownedForm(
      { schema: (values: { title: string }) => values, defaultValues: { title: "ready" } },
      async () => {
        submissions += 1;
        await waiting;
      },
    );

    const first = form.submit();
    await Promise.resolve();
    expect(form.isSubmitting).toBe(true);
    expect(await form.submit()).toBe(false);
    release?.();
    expect(await first).toBe(true);
    expect(form.isSubmitting).toBe(false);
    expect(submissions).toBe(1);
  });

  test("prefers parseAsync and runs the configured validation handlers", async () => {
    let synchronousCalls = 0;
    let asynchronousCalls = 0;
    const form = ownedForm(
      {
        schema: {
          parse: (values: { title: string }) => {
            synchronousCalls += 1;
            return values;
          },
          parseAsync: async (values: { title: string }) => {
            asynchronousCalls += 1;
            return values;
          },
        },
        defaultValues: { title: "" },
        validationStrategy: "onBlur",
      },
      () => {},
    );

    await form.handleInput({ target: { name: "title" } } as unknown as Event);
    expect(asynchronousCalls).toBe(0);
    await form.handleBlur({ target: { name: "title" } } as unknown as FocusEvent);
    expect(asynchronousCalls).toBe(1);
    expect(synchronousCalls).toBe(0);
  });

  test("ignores stale asynchronous validation results", async () => {
    const pending = new Map<
      string,
      {
        resolve: (value: { title: string }) => void;
        reject: (reason: unknown) => void;
      }
    >();
    const form = ownedForm(
      {
        schema: (values: { title: string }) =>
          new Promise<{ title: string }>((resolve, reject) =>
            pending.set(values.title, { resolve, reject }),
          ),
        defaultValues: { title: "" },
        validationStrategy: "onInput",
      },
      () => {},
    );
    const event = { target: { name: "title" } } as unknown as Event;

    form.values.title = "first";
    const first = form.handleInput(event);
    form.values.title = "second";
    const second = form.handleInput(event);
    pending.get("second")!.resolve({ title: "second" });
    await second;
    pending.get("first")!.reject({ issues: [{ path: ["title"], message: "Stale." }] });
    await first;

    expect(form.errors).toEqual({});
  });

  test("does not submit stale output after an input change", async () => {
    let resolveValidation: ((value: { title: string }) => void) | undefined;
    const submissions: { title: string }[] = [];
    const form = ownedForm(
      {
        schema: (values: { title: string }) =>
          new Promise<{ title: string }>((resolve) => {
            resolveValidation = resolve;
            expect(values.title).toBe("before");
          }),
        defaultValues: { title: "before" },
      },
      (values) => {
        submissions.push(values);
      },
    );

    const submission = form.submit();
    form.values.title = "after";
    await form.handleInput({ target: { name: "title" } } as unknown as Event);
    resolveValidation?.({ title: "before" });

    expect(await submission).toBe(false);
    expect(submissions).toEqual([]);
  });

  test("does not submit stale output after reset", async () => {
    let resolveValidation: ((value: { title: string }) => void) | undefined;
    const submissions: { title: string }[] = [];
    const form = ownedForm(
      {
        schema: () =>
          new Promise<{ title: string }>((resolve) => {
            resolveValidation = resolve;
          }),
        defaultValues: { title: "default" },
      },
      (values) => {
        submissions.push(values);
      },
    );

    form.values.title = "pending";
    const submission = form.submit();
    form.reset();
    resolveValidation?.({ title: "pending" });

    expect(await submission).toBe(false);
    expect(form.values.title).toBe("default");
    expect(submissions).toEqual([]);
  });

  test("rejects invalid reset values without changing controller state", () => {
    const form = ownedForm(
      {
        schema: (values: { title: string }) => values,
        defaultValues: { title: "before" },
      },
      noopSubmit,
    );

    for (const invalid of [null, [], "after"]) {
      expect(() => form.reset(invalid as never)).toThrow("values must be an object");
      expect(form.values).toEqual({ title: "before" });
    }
  });
});

describe("transitions", () => {
  test("validates transition definitions when a phase starts", () => {
    const element = document.createElement("div");
    const fragment = document.createDocumentFragment();
    fragment.append(element);
    transition(element, () => null as never);
    const rendered = block(fragment);

    expect(() => rendered.enter()).toThrow("expects an object");

    const other = document.createElement("div");
    const otherFragment = document.createDocumentFragment();
    otherFragment.append(other);
    transition(other, () => ({ leave: "" }));
    expect(() => block(otherFragment).leave()).toThrow("non-empty class name string");
  });

  test("accepts frozen and sealed transition definitions", () => {
    for (const definition of [Object.freeze({ leave: "fade" }), Object.seal({ leave: "fade" })]) {
      const element = document.createElement("div");
      const fragment = document.createDocumentFragment();
      fragment.append(element);
      transition(element, () => definition);
      const rendered = block(fragment);
      const target = document.createElement("main");
      rendered.mount(target);

      expect(rendered.retire()).toBeUndefined();
      expect(target.childNodes).toHaveLength(0);
    }
  });

  test("finishes retirement when a transition getter throws", () => {
    const element = document.createElement("div");
    const fragment = document.createDocumentFragment();
    fragment.append(element);
    transition(element, () => {
      throw new Error("transition failed");
    });
    let cleanups = 0;
    const rendered = block(fragment, [() => (cleanups += 1)]);
    const target = document.createElement("main");
    rendered.mount(target);

    expect(() => rendered.retire()).toThrow("transition failed");
    expect(cleanups).toBe(1);
    expect(target.childNodes).toHaveLength(0);
  });

  test("runs descendant animations together and retires after every leave finishes", async () => {
    const animations = installAnimations();
    const parent = document.createElement("section");
    const descendant = document.createElement("p");
    parent.classList.add("duration-100");
    parent.append(descendant);
    const fragment = document.createDocumentFragment();
    fragment.append(parent);
    const fade = { leave: "transition-leave duration-100" };
    transition(parent, () => fade);
    transition(descendant, () => fade);
    let cleanups = 0;
    const rendered = block(fragment, [() => (cleanups += 1)]);
    const target = document.createElement("main");
    rendered.mount(target);

    const retired = rendered.retire();

    expect(animations).toHaveLength(2);
    expect(parent.classList.contains("transition-leave")).toBe(true);
    expect(cleanups).toBe(1);
    expect(target.contains(parent)).toBe(true);
    animations[0]!.finish();
    await Promise.resolve();
    expect(target.contains(parent)).toBe(true);
    animations[1]!.finish();
    await retired;
    expect(parent.classList.contains("transition-leave")).toBe(false);
    expect(parent.classList.contains("duration-100")).toBe(true);
    expect(target.contains(parent)).toBe(false);
  });

  test("cancels a leave when a block re-enters and cancels animations on disposal", () => {
    const animations = installAnimations();
    const element = document.createElement("div");
    const fragment = document.createDocumentFragment();
    fragment.append(element);
    transition(element, () => ({
      enter: "transition-enter",
      leave: "transition-leave",
    }));
    const rendered = block(fragment);
    const target = document.createElement("main");
    rendered.mount(target);

    rendered.enter();
    void rendered.leave();
    expect(animations[0]!.cancelled).toBe(true);
    rendered.enter();
    expect(animations[1]!.cancelled).toBe(true);
    rendered.dispose();
    expect(animations[2]!.cancelled).toBe(true);
    expect(target.childNodes).toHaveLength(0);
  });

  test("falls back to immediate lifecycle behavior without animation support or with reduced motion", () => {
    const element = document.createElement("div");
    const fragment = document.createDocumentFragment();
    fragment.append(element);
    transition(element, () => ({ leave: "transition-leave" }));
    const rendered = block(fragment);
    const target = document.createElement("main");
    rendered.mount(target);

    expect(rendered.retire()).toBeUndefined();
    expect(target.childNodes).toHaveLength(0);

    const animations = installAnimations();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }),
    });
    const reducedElement = document.createElement("div");
    const reducedFragment = document.createDocumentFragment();
    reducedFragment.append(reducedElement);
    transition(reducedElement, () => ({ enter: "transition-enter" }));
    block(reducedFragment).enter();
    expect(animations).toHaveLength(0);
  });

  test("freezes a retiring component while its DOM finishes leaving", async () => {
    const animations = installAnimations();
    const source = $signal("first");
    let reads = 0;
    const definition = template('<p data-sol-e="0"><!--sol:s:0--><!--sol:e:0--></p>');
    const Page = component(() => {
      const view = instantiate(definition);
      const cleanups: Array<() => void> = [];
      transition(view.elements[0]!, () => ({ leave: "transition-leave" }));
      text(
        view.regions[0]!,
        () => {
          reads += 1;
          return source.value;
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const rendered = renderComponent(Page);
    const target = document.createElement("main");
    rendered.mount(target);

    const retirement = rendered.retire();
    source.value = "second";

    expect(reads).toBe(1);
    expect(target.textContent).toBe("first");
    animations[0]!.finish();
    await retirement;
    expect(target.childNodes).toHaveLength(0);
  });
});

describe("reactivity", () => {
  test("validates context creation and missing-provider reads", () => {
    expect(() => ($context as (...values: unknown[]) => unknown)({ value: "default" })).toThrow(
      "$context() does not accept a default value",
    );
    const context = $context<{ value: string }>();
    expect(context.useOptional()).toBeUndefined();
    expect(() => context.use()).toThrow("Context is not available outside its Provider");
    const ordinary = { kind: "ordinary" };
    const optional = { kind: "optional" };
    const service = new Proxy(
      {
        Provider: (() => undefined) as never,
        use: () => ordinary,
        useOptional: () => optional,
      },
      {
        has: () => {
          throw new Error("ordinary services must not be brand-probed");
        },
      },
    );
    expect(contextUse(service as Context<{ kind: string }>, rootFrame(), false)).toBe(ordinary);
    expect(contextUse(service as Context<{ kind: string }>, rootFrame(), true)).toBe(optional);
    expect(
      contextUse(
        {} as Context<{ kind: string }>,
        rootFrame(),
        false,
        false,
        true,
        (value) => value!.kind,
      ),
    ).toBeUndefined();
    let getterReads = 0;
    const getterService = {
      get use() {
        getterReads++;
        return function (this: typeof getterService) {
          return { kind: this === getterService ? "ordinary receiver" : "wrong receiver" };
        };
      },
      get useOptional() {
        getterReads++;
        return function (this: typeof getterService) {
          return { kind: this === getterService ? "optional receiver" : "wrong receiver" };
        };
      },
    };
    expect(
      contextUse(
        getterService as unknown as Context<{ kind: string }>,
        rootFrame(),
        false,
        false,
        true,
      ),
    ).toEqual({ kind: "ordinary receiver" });
    expect(
      contextUse(
        getterService as unknown as Context<{ kind: string }>,
        rootFrame(),
        true,
        false,
        true,
      ),
    ).toEqual({ kind: "optional receiver" });
    expect(getterReads).toBe(2);

    const protectedContext = $context<{ label: string }>();
    const brand = Reflect.ownKeys(protectedContext).find(
      (candidate): candidate is symbol => typeof candidate === "symbol",
    )!;
    const key = Reflect.get(protectedContext, brand) as symbol;
    const data = { label: "provided" };
    const frame = { ...rootFrame(), contexts: new Map([[key, () => data]]) };
    const value = contextUse(protectedContext, frame, false)!;
    const originalLabel = Object.getOwnPropertyDescriptor(data, "label");

    expect(() => Object.preventExtensions(value)).toThrow();
    expect(() => Object.seal(value)).toThrow();
    expect(() => Object.freeze(value)).toThrow();
    expect(() => Object.defineProperty(value, "locked", { value: true })).toThrow();
    expect(Object.isExtensible(data)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(data, "label")).toEqual(originalLabel);
    expect(Object.hasOwn(data, "locked")).toBe(false);
    expect(Object.keys(value)).toEqual(["label"]);
    Object.defineProperty(value, "label", { value: "changed" });
    expect(data.label).toBe("changed");

    const receivers: object[] = [];
    let stored = 1;
    Object.defineProperty(data, "accessor", {
      configurable: true,
      enumerable: true,
      get() {
        receivers.push(this);
        return stored;
      },
      set(next: number) {
        receivers.push(this);
        stored = next;
      },
    });
    const accessorValue = value as { accessor: number };
    expect(accessorValue.accessor).toBe(1);
    accessorValue.accessor = 2;
    expect(stored).toBe(2);
    expect(receivers).toEqual([value, value]);

    const mapContext = $context<Map<string, string>>();
    const mapBrand = Reflect.ownKeys(mapContext).find(
      (candidate): candidate is symbol => typeof candidate === "symbol",
    )!;
    const mapKey = Reflect.get(mapContext, mapBrand) as symbol;
    const map = new Map([["answer", "yes"]]);
    const mapFrame = { ...rootFrame(), contexts: new Map([[mapKey, () => map]]) };
    const providedMap = contextUse(mapContext, mapFrame, false) as Map<string, string>;
    expect(providedMap.get("answer")).toBe("yes");
    expect(providedMap.size).toBe(1);

    class PrivateValue {
      #label = "private";
      get label() {
        return this.#label;
      }
      read() {
        return this.#label;
      }
    }
    const classContext = $context<PrivateValue>();
    const classBrand = Reflect.ownKeys(classContext).find(
      (candidate): candidate is symbol => typeof candidate === "symbol",
    )!;
    const classKey = Reflect.get(classContext, classBrand) as symbol;
    const instance = new PrivateValue();
    const classFrame = { ...rootFrame(), contexts: new Map([[classKey, () => instance]]) };
    const providedInstance = contextUse(classContext, classFrame, false) as PrivateValue;
    expect(providedInstance.label).toBe("private");
    expect(providedInstance.read()).toBe("private");
  });

  test("validates the public compiler boundary and class values", () => {
    expect(() =>
      $component(function Example() {
        return undefined as never;
      }),
    ).toThrow("reached runtime");
    expect(
      normalizeClass([
        "todo-row",
        [null, false, "ledger-line", 0],
        { "todo-row--completed": true, hidden: 0 },
        2,
      ]),
    ).toBe("todo-row ledger-line 0 todo-row--completed 2");
    expect(normalizeClass(0)).toBe("0");
    for (const value of [() => undefined, Symbol("class"), new Date(), /class/]) {
      expect(() => normalizeClass(value as never)).toThrow(TypeError);
      expect(() => normalizeClass(value as never)).toThrow("Class values");
    }
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => normalizeClass(cyclic as never)).toThrow(
      "Class value arrays cannot contain cycles",
    );
  });

  test("tracks primitives, computed values, and batches writes", () => {
    const count = $signal(1);
    const doubled = $computed(() => count.value * 2);
    const values: number[] = [];
    const stop = runtimeEffect(() => values.push(doubled.value));

    batch(() => {
      count.value = 2;
      count.value = 3;
    });

    expect(values).toEqual([2, 6]);
    stop();
    count.value = 4;
    expect(values).toEqual([2, 6]);
  });

  test("deduplicates computed cascades during a batch", () => {
    const count = $signal(1);
    const doubled = $computed(() => count.value * 2);
    const observations: string[] = [];
    runtimeEffect(() => observations.push(`${count.value}:${doubled.value}`));

    batch(() => {
      count.value = 2;
      count.value = 3;
    });

    expect(observations).toEqual(["1:2", "3:6"]);
  });

  test("deduplicates computed cascades outside a batch", () => {
    const count = $signal(1);
    const doubled = $computed(() => count.value * 2);
    const observations: string[] = [];
    runtimeEffect(() => observations.push(`${count.value}:${doubled.value}`));

    count.value = 2;

    expect(observations).toEqual(["1:2", "2:4"]);
  });

  test("settles transitive computed chains before running consumers", () => {
    for (const update of [
      (source: Signal<number>) => {
        source.value = 2;
      },
      (source: Signal<number>) =>
        batch(() => {
          source.value = 2;
        }),
    ]) {
      const source = $signal(1);
      const doubled = $computed(() => source.value * 2);
      const incremented = $computed(() => doubled.value + 1);
      const observations: string[] = [];
      runtimeEffect(() => observations.push(`${source.value}:${incremented.value}`));

      update(source);

      expect(observations).toEqual(["1:3", "2:5"]);
    }
  });

  test("preserves a batch callback failure when the reactive flush also fails", () => {
    const source = $signal(0);
    runtimeEffect(() => {
      if (source.value > 0) throw new Error("effect failed");
    });

    try {
      batch(() => {
        source.value = 1;
        throw new Error("callback failed");
      });
      throw new Error("expected batch to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        "Error: callback failed",
        "Error: effect failed",
      ]);
    }
  });

  test("reports every effect failure from one flush", () => {
    const source = $signal(0);
    runtimeEffect(() => {
      if (source.value > 0) throw new Error("first effect failed");
    });
    runtimeEffect(() => {
      if (source.value > 0) throw new Error("second effect failed");
    });

    try {
      batch(() => {
        source.value = 1;
      });
      throw new Error("expected batch to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        "Error: first effect failed",
        "Error: second effect failed",
      ]);
    }
  });

  test("unsubscribes effects and computed values whose initial evaluation throws", () => {
    const source = $signal(0);
    let effectRuns = 0;
    expect(() =>
      runtimeEffect(() => {
        effectRuns += 1;
        void source.value;
        throw new Error("effect failed");
      }),
    ).toThrow("effect failed");

    let computedRuns = 0;
    expect(() =>
      $computed(() => {
        computedRuns += 1;
        void source.value;
        throw new Error("computed failed");
      }),
    ).toThrow("computed failed");

    source.value = 1;
    expect(effectRuns).toBe(1);
    expect(computedRuns).toBe(1);
  });

  test("tracks deep object writes and array mutators", () => {
    const state = $signal({ todos: [{ done: false }] });
    const observations: string[] = [];
    runtimeEffect(() =>
      observations.push(`${state.value.todos.length}:${state.value.todos[0]?.done}`),
    );

    state.value.todos[0]!.done = true;
    state.value.todos.push({ done: false });
    state.value.todos.splice(0, 1);

    expect(observations).toEqual(["1:false", "1:true", "2:true", "1:false"]);
  });

  test("preserves overridden array mutator properties", () => {
    const nonCallable = reactive<unknown[]>([]);
    Object.defineProperty(nonCallable, "push", {
      value: 7,
      configurable: true,
      writable: true,
    });
    expect(nonCallable.push as unknown).toBe(7);

    const expected = 42;
    const custom = () => expected;
    const callable = reactive<unknown[]>([]);
    Object.defineProperty(callable, "push", {
      value: custom,
      configurable: true,
      writable: true,
    });
    expect(callable.push).toBe(custom);
    expect(callable.push).toBe(callable.push);

    class Items extends Array<unknown> {}
    const inherited = reactive(new Items());
    const inheritedPush = inherited.push;
    const receiver: unknown[] = [];
    inheritedPush.call(receiver, "value");
    expect(receiver).toEqual(["value"]);
    expect(inherited).toHaveLength(0);
    expect(inherited.push).toBe(inheritedPush);
  });

  test("invalidates removed array indexes when length shrinks", () => {
    const state = $signal({ values: ["first", "second", "third"] });
    const observations: Array<string | undefined> = [];
    const keys: string[][] = [];
    let runs = 0;
    runtimeEffect(() => observations.push(state.value.values[2]));
    runtimeEffect(() => {
      runs += 1;
      keys.push(Object.keys(state.value.values));
    });

    state.value.values.length = 1;

    expect(observations).toHaveLength(2);
    expect(observations[0]).toBe("third");
    expect(observations[1]).toBeUndefined();
    expect(runs).toBe(2);
    expect(keys).toEqual([["0", "1", "2"], ["0"]]);
  });

  test("preserves built-in and class instances instead of proxying them", () => {
    class Model {
      constructor(readonly value: number) {}
    }
    const date = new Date(0);
    const map = new Map([["answer", 42]]);
    const model = new Model(7);
    const state = $signal({ date, map, model });

    expect(state.value.date).toBe(date);
    expect(state.value.date.getTime()).toBe(0);
    expect(state.value.map).toBe(map);
    expect(state.value.map.get("answer")).toBe(42);
    expect(state.value.model).toBe(model);
    expect(state.value.model.value).toBe(7);
  });

  test("preserves frozen object identity and proxy invariants", () => {
    const nested = Object.freeze({ value: 1 });
    const frozen = Object.freeze({ nested });
    const frozenArray = Object.freeze([nested]);
    const state = $signal({ frozen, frozenArray });

    expect(state.value.frozen).toBe(frozen);
    expect(state.value.frozen.nested).toBe(nested);
    expect(state.value.frozenArray).toBe(frozenArray);
    expect(state.value.frozenArray[0]).toBe(nested);

    const lockedChild = { value: 2 };
    const locked = Object.defineProperty({ ordinary: { value: 3 } }, "child", {
      value: lockedChild,
      configurable: false,
      writable: false,
      enumerable: true,
    }) as { ordinary: { value: number }; readonly child: { value: number } };
    const lockedState = $signal(locked);
    expect(lockedState.value.child).toBe(lockedChild);
    expect(lockedState.value.ordinary).not.toBe(locked.ordinary);
    lockedState.value.ordinary.value = 4;
    expect(locked.ordinary.value).toBe(4);
  });

  test("treats assigning a cached proxy back to its property as a no-op", () => {
    const state = $signal({ child: { value: 1 } });
    const observations: number[] = [];
    runtimeEffect(() => observations.push(state.value.child.value));
    const childProxy = state.value.child;

    state.value.child = childProxy;
    childProxy.value = 2;

    expect(state.value.child).toBe(childProxy);
    expect(observations).toEqual([1, 2]);
  });

  test("tracks property iteration and deletion", () => {
    const state = $signal<Record<string, number>>({ first: 1, second: 2 });
    const keys: string[] = [];
    runtimeEffect(() => keys.push(Object.keys(state.value).join(",")));

    delete state.value.first;

    expect(keys).toEqual(["first,second", "second"]);
  });

  test("tracks property presence checks", () => {
    const state = $signal<Record<string, number>>({});
    const observations: boolean[] = [];
    runtimeEffect(() => observations.push("answer" in state.value));

    state.value.answer = 42;
    delete state.value.answer;

    expect(observations).toEqual([false, true, false]);

    const undefinedState = $signal<Record<string, undefined>>({});
    const presence: boolean[] = [];
    const keys: string[] = [];
    runtimeEffect(() => presence.push("answer" in undefinedState.value));
    runtimeEffect(() => keys.push(Object.keys(undefinedState.value).join(",")));
    undefinedState.value.answer = undefined;
    expect(presence).toEqual([false, true]);
    expect(keys).toEqual(["", "answer"]);

    const array = $signal<Array<undefined>>([]);
    const lengths: number[] = [];
    runtimeEffect(() => lengths.push(array.value.length));
    array.value[0] = undefined;
    expect(lengths).toEqual([0, 1]);
  });

  test("tracks property definitions", () => {
    const state = $signal<{ value: number; added?: number }>({ value: 1 });
    const values: number[] = [];
    const keys: string[] = [];
    runtimeEffect(() => values.push(state.value.value));
    runtimeEffect(() => keys.push(Object.keys(state.value).join(",")));

    Object.defineProperty(state.value, "value", {
      value: 2,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Reflect.defineProperty(state.value, "added", {
      value: 3,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(values).toEqual([1, 2]);
    expect(keys).toEqual(["value", "value,added"]);

    const array = $signal<number[]>([]);
    const lengths: number[] = [];
    runtimeEffect(() => lengths.push(array.value.length));
    Object.defineProperty(array.value, "0", {
      value: 1,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(lengths).toEqual([0, 1]);

    const accessorTarget = { changed: 0 } as { changed: number; update?: number };
    Object.defineProperty(accessorTarget, "update", {
      configurable: true,
      set(value: number) {
        Object.defineProperty(this, "changed", {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      },
    });
    const accessorState = $signal(accessorTarget);
    const changes: number[] = [];
    runtimeEffect(() => changes.push(accessorState.value.changed));
    accessorState.value.update = 2;
    expect(changes).toEqual([0, 2]);
  });

  test("flushes combined property, iteration, and length dependencies once", () => {
    const object = $signal<Record<string, number>>({});
    let objectRuns = 0;
    runtimeEffect(() => {
      objectRuns += 1;
      void object.value.added;
      Object.keys(object.value);
    });

    object.value.added = 1;
    delete object.value.added;
    expect(objectRuns).toBe(3);

    const array = $signal<number[]>([]);
    let arrayRuns = 0;
    runtimeEffect(() => {
      arrayRuns += 1;
      void array.value[0];
      void array.value.length;
      Object.keys(array.value);
    });

    array.value[0] = 1;
    Reflect.deleteProperty(array.value, "0");
    expect(arrayRuns).toBe(3);
  });

  test("cleans stale conditional dependencies", () => {
    const useLeft = $signal(true);
    const left = $signal("left");
    const right = $signal("right");
    const values: string[] = [];
    runtimeEffect(() => values.push(useLeft.value ? left.value : right.value));

    useLeft.value = false;
    left.value = "ignored";
    right.value = "updated";

    expect(values).toEqual(["left", "right", "updated"]);
  });
});

describe("compiled DOM runtime", () => {
  test("wakes failed server and hydration sessions while work remains pending", async () => {
    const serverFailure = new Error("server session failed");
    const server = new SsrSession();
    server.beginRoot();
    server.fail(serverFailure);
    expect(await rejection(server.wait(25))).toBe(serverFailure);

    const hydrationFailure = new Error("hydration session failed");
    const hydration = new HydrationSession({
      version: 1,
      templates: [],
      async: [],
      boundaries: [],
    });
    void hydration.track(new Promise<never>(() => undefined));
    hydration.fail(hydrationFailure);
    const hydrationTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("hydration failure did not wake waiters")), 25);
    });
    expect(await rejection(Promise.race([hydration.wait(), hydrationTimeout]))).toBe(
      hydrationFailure,
    );
  });

  test("normalizes NUL text without colliding with server element slots", async () => {
    const authored = "before\0sol:element:0\0after";
    const expected = "before\uFFFDsol:element:0\uFFFDafter";
    const textCases = [
      [
        "tnulnoelement",
        template("<p><!--sol:s:0--><!--sol:e:0--></p>", "tnulnoelement", {
          elements: [],
          regionCount: 1,
          propertyValueElements: [],
        }),
      ],
      [
        "tnulelement",
        template('<p data-sol-e="0"><!--sol:s:0--><!--sol:e:0--></p>', "tnulelement", {
          elements: ["p"],
          regionCount: 1,
          propertyValueElements: [],
        }),
      ],
    ] as const;
    await Promise.all(
      textCases.map(async ([signature, definition]) => {
        const App = component((_props, frame) => {
          const view = instantiate(definition, frame);
          const cleanups: Array<() => void> = [];
          text(view.regions[0]!, () => authored, cleanups);
          return block(view.fragment, cleanups);
        });
        const html = await renderToStringAsync(App);
        expect(html).toContain(expected);
        expect(html).not.toContain("\0");

        const hydratedTarget = document.createElement("main");
        hydratedTarget.innerHTML = html;
        const disposeHydrated = await hydrate(App, hydratedTarget);
        expect(hydratedTarget.querySelector("p")?.textContent).toBe(expected);
        disposeHydrated();

        const mountedTarget = document.createElement("main");
        const disposeMounted = mount(App, mountedTarget);
        expect(mountedTarget.querySelector("p")?.textContent, signature).toBe(expected);
        disposeMounted();
      }),
    );

    const rawDefinition = template('<textarea data-sol-e="0"></textarea>', "tnulrawtext", {
      elements: ["textarea"],
      regionCount: 0,
      propertyValueElements: [0],
    });
    const RawApp = component((_props, frame) => {
      const view = instantiate(rawDefinition, frame);
      const cleanups: Array<() => void> = [];
      rawText(view.elements[0]!, () => [authored], cleanups);
      return block(view.fragment, cleanups);
    });
    const rawHtml = await renderToStringAsync(RawApp);
    expect(rawHtml).toContain(expected);
    expect(rawHtml).not.toContain("\0");

    const rawTarget = document.createElement("main");
    rawTarget.innerHTML = rawHtml;
    const disposeRaw = await hydrate(RawApp, rawTarget);
    expect(rawTarget.querySelector("textarea")?.textContent).toBe(expected);
    disposeRaw();
  });

  test("reports asynchronous conditional and list retirement failures", async () => {
    const failures: unknown[] = [];
    const frame = { ...rootFrame(), handleError: (error: unknown) => failures.push(error) };

    const conditionalView = instantiate(
      template("<!--sol:s:0--><!--sol:e:0-->", "tasyncconditional", {
        elements: [],
        regionCount: 1,
        propertyValueElements: [],
      }),
    );
    const condition = $signal(true);
    const conditionalFinish = deferredPromise();
    const conditionalFailure = new Error("conditional async dispose failed");
    const conditionalCleanups: Array<() => void> = [];
    when(
      conditionalView.regions[0]!,
      () => condition.value,
      () => retiringBlock(conditionalFinish.promise, conditionalFailure),
      () => block(document.createDocumentFragment()),
      conditionalCleanups,
      frame,
    );
    condition.value = false;
    conditionalFinish.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([conditionalFailure]);

    const listView = instantiate(
      template("<!--sol:s:0--><!--sol:e:0-->", "tasynclist", {
        elements: [],
        regionCount: 1,
        propertyValueElements: [],
      }),
    );
    const items = $signal([1]);
    const listFinish = deferredPromise();
    const listFailure = new Error("list async dispose failed");
    const listCleanups: Array<() => void> = [];
    list(
      listView.regions[0]!,
      () => items.value,
      (item) => item,
      () => retiringBlock(listFinish.promise, listFailure),
      listCleanups,
      frame,
    );
    items.value = [];
    listFinish.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([conditionalFailure, listFailure]);

    const rejectedView = instantiate(
      template("<!--sol:s:0--><!--sol:e:0-->", "tasyncrejection", {
        elements: [],
        regionCount: 1,
        propertyValueElements: [],
      }),
    );
    const rejectedCondition = $signal(true);
    const rejectedFinish = deferredPromise();
    const transitionFailure = new Error("conditional leave rejected");
    when(
      rejectedView.regions[0]!,
      () => rejectedCondition.value,
      () => retiringBlock(rejectedFinish.promise),
      () => block(document.createDocumentFragment()),
      [],
      frame,
    );
    rejectedCondition.value = false;
    rejectedFinish.reject(transitionFailure);
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([conditionalFailure, listFailure, transitionFailure]);
  });

  test("validates and brands compiled route records", () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const definition = route({ path: "/entry/:id" }, Empty, {
      pattern: "^/entry/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [],
      specificity: [1, 0],
    });

    expect(isRouteDefinition(definition)).toBe(true);
    expect(definition.config.path).toBe("/entry/:id");
    expect(() => route(null as never, Empty, definition.compiled)).toThrow(
      "config must contain a path",
    );
    expect(() => route({ path: "/bad" }, (() => undefined) as never, definition.compiled)).toThrow(
      "uncompiled component",
    );

    const inheritedConfig = Object.create({ path: "/inherited" }) as { path: "/inherited" };
    expect(() => route(inheritedConfig, Empty, definition.compiled)).toThrow(
      "config must contain a path",
    );
    const accessorConfig = Object.defineProperty({}, "path", {
      enumerable: true,
      get() {
        throw new Error("route config accessor ran");
      },
    }) as { path: "/accessor" };
    expect(() => route(accessorConfig, Empty, definition.compiled)).toThrow(
      "config must contain a path",
    );
    const hiddenConfig = Object.defineProperty({}, "path", { value: "/hidden" }) as {
      path: "/hidden";
    };
    expect(() => route(hiddenConfig, Empty, definition.compiled)).toThrow(
      "config must contain a path",
    );

    const inheritedCompiled = Object.create(definition.compiled) as typeof definition.compiled;
    expect(() => route({ path: "/inherited" }, Empty, inheritedCompiled)).toThrow(
      "metadata is invalid",
    );
    const accessorParameterNames = Object.defineProperty([], "0", {
      enumerable: true,
      get() {
        throw new Error("route metadata accessor ran");
      },
    });
    expect(() =>
      route({ path: "/accessor" }, Empty, {
        ...definition.compiled,
        parameterNames: accessorParameterNames as string[],
      }),
    ).toThrow("metadata is invalid");
  });

  test("validates and caches lazy route implementations", async () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const definition = route({ path: "/lazy" }, Empty, {
      pattern: "^/lazy$",
      parameterNames: [],
      pathnameParameterNames: [],
      queryParameters: [],
      specificity: [1],
    });
    let loads = 0;
    const lazy = lazyRoute("/lazy", definition.compiled, async () => {
      loads += 1;
      return definition;
    });

    expect(await Promise.all([lazy.load(), lazy.load()])).toEqual([definition, definition]);
    expect(loads).toBe(1);
    expect(() => lazyRoute("lazy", definition.compiled, async () => definition)).toThrow(
      "root-relative",
    );
    const failure = await lazyRoute("/lazy", definition.compiled, async () => null)
      .load()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain("did not export");

    let retryLoads = 0;
    const retrying = lazyRoute("/lazy", definition.compiled, async () => {
      retryLoads += 1;
      if (retryLoads === 1) throw new Error("transient route load");
      return definition;
    });
    const firstAttempts = await Promise.allSettled([retrying.load(), retrying.load()]);
    expect(firstAttempts.every((attempt) => attempt.status === "rejected")).toBe(true);
    expect(retryLoads).toBe(1);
    expect(await retrying.load()).toBe(definition);
    expect(await retrying.load()).toBe(definition);
    expect(retryLoads).toBe(2);

    const mismatched = route({ path: "/lazy" }, Empty, {
      ...definition.compiled,
      parameterNames: ["id"],
    });
    const metadataFailure = await lazyRoute("/lazy", definition.compiled, async () => mismatched)
      .load()
      .catch((error: unknown) => error);
    expect(metadataFailure).toBeInstanceOf(TypeError);
    expect((metadataFailure as Error).message).toContain("metadata does not match");

    const loaderError = new Error("sync loader failure");
    const syncFailure = lazyRoute("/lazy", definition.compiled, () => {
      throw loaderError;
    });
    let loadPromise: Promise<unknown> | undefined;
    expect(() => {
      loadPromise = syncFailure.load();
    }).not.toThrow();
    expect(await loadPromise!.catch((error: unknown) => error)).toBe(loaderError);
  });

  test("provides typed route params, navigation, and active state", () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const detail = route({ path: "/blog/:id" }, Empty, {
      pattern: "^/blog/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [],
      specificity: [1, 0],
    });
    const todo = route({ path: "/" }, Empty, {
      pattern: "^/$",
      parameterNames: [],
      pathnameParameterNames: [],
      queryParameters: [],
      specificity: [],
    });
    const rootQuery = route({ path: "/?filter=:filter" }, Empty, {
      pattern: "^/$",
      parameterNames: ["filter"],
      pathnameParameterNames: [],
      queryParameters: [{ key: "filter", name: "filter" }],
      specificity: [],
    });
    let active: object = detail;
    let pathname = "/blog/first";
    const activeParams = { id: "first" } as const;
    const navigations: Array<{ path: string; replace: boolean | undefined }> = [];
    configureRouteRuntime({
      getParams(definition) {
        if (definition !== active) throw new Error("inactive");
        return activeParams;
      },
      getPathname: () => pathname,
      isActive: (definition) => definition === active,
      navigate(path, options) {
        navigations.push({ path, replace: options?.replace });
      },
    });

    expect(detail.params.id).toBe("first");
    expect(detail.query).toBe(detail.params);
    expect(detail.isActive).toBe(true);
    expect(detail.isActivePrefix).toBe(true);
    expect(todo.isActive).toBe(false);
    expect(todo.isActivePrefix).toBe(false);
    expect(rootQuery.isActivePrefix).toBe(false);
    detail.navigate({ params: { id: "hello world" } }, { replace: true });
    expect(navigations).toEqual([{ path: "/blog/hello%20world", replace: true }]);
    expect(() => detail.navigate({} as never)).toThrow("Missing route parameter id");
    expect(() => detail.navigate({ params: { id: "one", extra: "two" } } as never)).toThrow(
      "Unknown route parameter extra",
    );

    const reads: PropertyKey[] = [];
    const ordinary = new Proxy(
      { params: { id: "ordinary" } },
      {
        get(target, key, receiver) {
          if (typeof key === "symbol") throw new Error("unexpected symbol read");
          reads.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    expect(routeRead(ordinary, "params", rootFrame())).toEqual({ id: "ordinary" });
    expect(reads).toEqual(["params"]);
    expect(routeRead(undefined, "params", rootFrame(), (value) => value)).toBeUndefined();

    active = todo;
    pathname = "/";
    expect(() => detail.params.id).toThrow("inactive");
    expect(detail.isActive).toBe(false);
    todo.navigate({}, { replace: true });
    expect(navigations.at(-1)).toEqual({ path: "/", replace: true });
  });

  test("validates and serializes parsed route values", async () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const detail = route(
      {
        path: "/blog/:id?page=:page&filter=:filter",
        schema: ({ id, page, filter }) => ({ id: Number(id), page: Number(page), filter: filter! }),
      },
      Empty,
      {
        pattern: "^/blog/([^/]+)$",
        parameterNames: ["id", "page", "filter"],
        pathnameParameterNames: ["id"],
        queryParameters: [
          { key: "page", name: "page" },
          { key: "filter", name: "filter" },
        ],
        specificity: [1, 0],
      },
    );

    const resolution = await resolveRoute(detail, { id: "42", page: "3", filter: "recent" });
    expect(resolution).toEqual({
      matched: true,
      values: { id: 42, page: 3, filter: "recent" },
    });
    expect(
      routeHref(detail, {
        params: { id: 42, page: 3, filter: "recent" },
      }),
    ).toBe("/blog/42?page=3&filter=recent");
    expect(() =>
      routeHref(detail, { params: { id: 42, page: true, filter: "recent" } } as never),
    ).toThrow("must be a string, number, or undefined");
    expect(() => routeHref(detail, { params: { id: 42 }, extra: true })).toThrow(
      "unknown property extra",
    );

    let accessorCalls = 0;
    const invalidSchemaValues = [
      Object.defineProperty({}, "id", { value: "42", enumerable: false }),
      Object.defineProperty({}, "id", {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return "42";
        },
      }),
    ];
    const invalidSchemaFailures = await Promise.all(
      invalidSchemaValues.map(async (schemaValues) => {
        const invalid = route(
          { path: "/invalid/:id", schema: () => schemaValues as { id: string } },
          Empty,
          {
            pattern: "^/invalid/([^/]+)$",
            parameterNames: ["id"],
            pathnameParameterNames: ["id"],
            queryParameters: [],
            specificity: [1, 0],
          },
        );
        return Promise.resolve()
          .then(() => resolveRoute(invalid, { id: "42" }))
          .catch((error: unknown) => error);
      }),
    );
    for (const failure of invalidSchemaFailures) {
      expect(failure).toBeInstanceOf(TypeError);
    }
    expect(accessorCalls).toBe(0);

    const objectPrototype = Object.prototype as { id?: unknown };
    Object.defineProperty(objectPrototype, "id", {
      configurable: true,
      value: { enumerable: true, value: "POLLUTED" },
    });
    try {
      const missing = route({ path: "/missing/:id", schema: () => ({}) as { id: string } }, Empty, {
        pattern: "^/missing/([^/]+)$",
        parameterNames: ["id"],
        pathnameParameterNames: ["id"],
        queryParameters: [],
        specificity: [1, 0],
      });
      expect(() => resolveRoute(missing, { id: "actual" })).toThrow("missing parameter id");
    } finally {
      delete objectPrototype.id;
    }

    const prototypeName = route(
      {
        path: "/prototype/:__proto__",
        schema: () => ({ ["__proto__"]: "preserved" }) as { __proto__: string },
      },
      Empty,
      {
        pattern: "^/prototype/([^/]+)$",
        parameterNames: ["__proto__"],
        pathnameParameterNames: ["__proto__"],
        queryParameters: [],
        specificity: [1, 0],
      },
    );
    const prototypeResolution = await resolveRoute(prototypeName, {
      ["__proto__"]: "raw",
    });
    expect(prototypeResolution.matched).toBe(true);
    if (prototypeResolution.matched) {
      expect(Object.hasOwn(prototypeResolution.values, "__proto__")).toBe(true);
      expect(prototypeResolution.values.__proto__).toBe("preserved");
    }

    const repeated = route({ path: "/blog/:id?selected=:id" }, Empty, {
      pattern: "^/blog/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [{ key: "selected", name: "id" }],
      specificity: [1, 0],
    });
    expect(routeHref(repeated, { params: { id: "hello world" } })).toBe(
      "/blog/hello%20world?selected=hello+world",
    );
    let routeReads = 0;
    const accessorParams = Object.defineProperty({}, "id", {
      enumerable: true,
      get() {
        routeReads += 1;
        return routeReads;
      },
    });
    expect(() => routeHref(repeated, { params: accessorParams })).toThrow("data property");
    const accessorDestination = Object.defineProperty({}, "params", {
      enumerable: true,
      get() {
        routeReads += 1;
        return { id: "hidden" };
      },
    });
    expect(() => routeHref(repeated, accessorDestination)).toThrow("data property");
    expect(routeReads).toBe(0);

    const prefixedNames = route({ path: "/blog/:id/:id2" }, Empty, {
      pattern: "^/blog/([^/]+)/([^/]+)$",
      parameterNames: ["id", "id2"],
      pathnameParameterNames: ["id", "id2"],
      queryParameters: [],
      specificity: [1, 0, 0],
    });
    expect(routeHref(prefixedNames, { params: { id: 1, id2: 2 } })).toBe("/blog/1/2");

    const optionalQuery = route({ path: "/search?filter=:filter" }, Empty, {
      pattern: "^/search$",
      parameterNames: ["filter"],
      pathnameParameterNames: [],
      queryParameters: [{ key: "filter", name: "filter" }],
      specificity: [1],
    });
    expect(routeHref(optionalQuery, { params: {} })).toBe("/search");
    expect(await resolveRoute(optionalQuery, { filter: undefined })).toEqual({
      matched: true,
      values: { filter: undefined },
    });

    const unicode = route({ path: "/cafe au lait/Crème" }, Empty, {
      pattern: "^/cafe%20au%20lait/Cr%C3%A8me$",
      parameterNames: [],
      pathnameParameterNames: [],
      queryParameters: [],
      specificity: [1, 1],
    });
    expect(routeHref(unicode, {})).toBe("/cafe%20au%20lait/Cr%C3%A8me");

    const inherited = Object.create({ id: "42" }) as { id: string };
    const inheritedRoute = route({ path: "/item/:id", schema: () => inherited }, Empty, {
      pattern: "^/item/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [],
      specificity: [1, 0],
    });
    expect(() => resolveRoute(inheritedRoute, { id: "42" })).toThrow("plain object");
    expect(() => routeHref(inheritedRoute, { params: inherited })).toThrow("plain object");
    expect(() =>
      routeHref(inheritedRoute, {
        params: Object.assign({ id: "42" }, { [Symbol("extra")]: true }),
      }),
    ).toThrow("symbol");
  });

  test("rejects accessor-backed SSR options", async () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    let reads = 0;
    const options = Object.defineProperty({}, "onHead", {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? () => undefined : "changed";
      },
    });
    const failure = await renderToStringAsync(Empty, {}, options).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain("data property");
  });

  test("validates routes with Standard Schema implementations", async () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const detail = route(
      {
        path: "/blog/:id?from=:from",
        schema: v.object({
          id: v.pipe(v.string(), v.transform(Number), v.integer()),
          from: v.string(),
        }),
      },
      Empty,
      {
        pattern: "^/blog/([^/]+)$",
        parameterNames: ["id", "from"],
        pathnameParameterNames: ["id"],
        queryParameters: [{ key: "from", name: "from" }],
        specificity: [1, 0],
      },
    );

    expect(await resolveRoute(detail, { id: "42", from: "index" })).toEqual({
      matched: true,
      values: { id: 42, from: "index" },
    });
    expect(await resolveRoute(detail, { id: "invalid", from: "index" })).toEqual({
      matched: false,
    });

    const stable = route(
      {
        path: "/stable/:id?from=:from",
        schema: {
          "~standard": {
            validate(input: unknown) {
              const values = input as { id: string; from: string };
              return { value: { id: Number(values.id), from: values.from } };
            },
          },
        },
      },
      Empty,
      {
        ...detail.compiled,
        pattern: "^/stable/([^/]+)$",
      },
    );
    const objectPrototype = Object.prototype as { issues?: unknown };
    Object.defineProperty(objectPrototype, "issues", { configurable: true, value: [] });
    try {
      expect(await resolveRoute(stable, { id: "42", from: "index" })).toEqual({
        matched: true,
        values: { id: 42, from: "index" },
      });
    } finally {
      delete objectPrototype.issues;
    }

    let issueReads = 0;
    const accessorResult = route(
      {
        path: "/accessor/:id",
        schema: {
          "~standard": {
            validate() {
              return Object.defineProperty({ value: { id: 1 } }, "issues", {
                get() {
                  issueReads += 1;
                  return [];
                },
              }) as never;
            },
          },
        },
      },
      Empty,
      {
        pattern: "^/accessor/([^/]+)$",
        parameterNames: ["id"],
        pathnameParameterNames: ["id"],
        queryParameters: [],
        specificity: [1, 0],
      },
    );
    expect(() => resolveRoute(accessorResult, { id: "1" })).toThrow("data properties");
    expect(issueReads).toBe(0);
  });

  test("treats schema issues as no match and preserves unexpected failures", async () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const compiled = {
      pattern: "^/entry/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [],
      specificity: [1, 0],
    };
    const invalid = route(
      {
        path: "/entry/:id",
        schema: async (): Promise<{ id: string }> => {
          throw { issues: [{ message: "Invalid id", path: ["id"] }] };
        },
      },
      Empty,
      compiled,
    );
    const broken = route(
      {
        path: "/entry/:id",
        schema: (): { id: string } => {
          throw new Error("parser failed");
        },
      },
      Empty,
      compiled,
    );

    expect(await resolveRoute(invalid, { id: "bad" })).toEqual({
      matched: false,
    });
    const objectPrototype = Object.prototype as { issues?: unknown };
    Object.defineProperty(objectPrototype, "issues", { configurable: true, value: [] });
    try {
      expect(() => resolveRoute(broken, { id: "bad" })).toThrow("parser failed");
    } finally {
      delete objectPrototype.issues;
    }
  });

  test("decorates Link anchors and preserves cancelled or modified clicks", () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const detail = route({ path: "/blog/:id" }, Empty, {
      pattern: "^/blog/([^/]+)$",
      parameterNames: ["id"],
      pathnameParameterNames: ["id"],
      queryParameters: [],
      specificity: [1, 0],
    });
    const navigations: string[] = [];
    configureRouteRuntime({
      getParams: () => ({ id: "first" }),
      getPathname: () => "/",
      isActive: () => false,
      navigate: (path) => navigations.push(path),
    });
    const anchor = document.createElement("a");
    const cleanups: Array<() => void> = [];
    let cancelNext = false;
    anchor.addEventListener("click", (event) => {
      if (cancelNext) event.preventDefault();
    });
    link(
      anchor,
      () => detail,
      () => ({ params: { id: "hello world" } }),
      () => false,
      cleanups,
    );

    expect(anchor.getAttribute("href")).toBe("/blog/hello%20world");
    anchor.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      }) as unknown as Event,
    );
    anchor.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        button: 0,
        ctrlKey: true,
        cancelable: true,
      }) as unknown as Event,
    );
    cancelNext = true;
    anchor.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      }) as unknown as Event,
    );
    cancelNext = false;
    anchor.target = "_blank";
    anchor.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      }) as unknown as Event,
    );
    anchor.removeAttribute("target");
    anchor.setAttribute("download", "entry.txt");
    anchor.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
      }) as unknown as Event,
    );

    expect(navigations).toEqual(["/blog/hello%20world"]);
    for (const cleanup of cleanups.toReversed()) cleanup();
  });

  test("prefixes Link hrefs with the configured route base", () => {
    const Empty = component(() => block(document.createDocumentFragment()));
    const docs = route({ path: "/docs" }, Empty, {
      pattern: "^/docs$",
      parameterNames: [],
      pathnameParameterNames: [],
      queryParameters: [],
      specificity: [1],
    });
    const anchor = document.createElement("a");
    const navigations: string[] = [];
    configureRouteRuntime({
      getParams: () => ({}),
      getPathname: () => "/",
      isActive: () => false,
      navigate: (path) => navigations.push(path),
    });
    configureRouteBase("/sol/");
    try {
      const cleanups: Array<() => void> = [];
      link(
        anchor,
        () => docs,
        () => ({}),
        () => false,
        cleanups,
      );
      expect(anchor.getAttribute("href")).toBe("/sol/docs");
      anchor.click();
      expect(navigations).toEqual(["/docs"]);
      for (const cleanup of cleanups.toReversed()) cleanup();
    } finally {
      configureRouteBase("/");
    }
  });

  test("updates normalized DOM classes reactively", () => {
    const classes = $signal(["todo-row", { "todo-row--completed": false }]);
    const element = document.createElement("div");
    const cleanups: (() => void)[] = [];
    attribute(element, "classNames", () => classes.value, cleanups);

    expect(element.className).toBe("todo-row");
    classes.value = ["todo-row", { "todo-row--completed": true }];
    expect(element.className).toBe("todo-row todo-row--completed");
    for (const cleanup of cleanups.toReversed()) cleanup();
  });

  test("writes reflected getter-only DOM values as attributes", () => {
    const formId = $signal("first-form");
    const input = document.createElement("input");
    const cleanups: Array<() => void> = [];

    attribute(input, "form", () => formId.value, cleanups);
    expect(input.getAttribute("form")).toBe("first-form");

    formId.value = "second-form";
    expect(input.getAttribute("form")).toBe("second-form");
    for (const cleanup of cleanups.toReversed()) cleanup();
  });

  test("omits falsey numeric standard boolean attributes during server rendering", async () => {
    const definition = template('<img data-sol-e="0"><div data-sol-e="1"></div>', "booleans", {
      elements: ["img", "div"],
      regionCount: 0,
      propertyValueElements: [],
    });
    const Example = component((_props, frame) => {
      const view = instantiate(definition, frame);
      const cleanups: Array<() => void> = [];
      attribute(view.elements[0]!, "isMap", () => 0, cleanups);
      attribute(view.elements[1]!, "itemScope", () => 0, cleanups);
      return block(view.fragment, cleanups);
    });

    const html = await renderToStringAsync(Example);

    expect(html).not.toContain("isMap");
    expect(html).not.toContain("itemScope");
  });

  test("mounts once and patches text without rerunning setup", () => {
    const count = $signal(0);
    let setups = 0;
    const definition = template("<p><!--sol:s:0--><!--sol:e:0--></p>");
    const Counter = component(() => {
      setups += 1;
      const view = instantiate(definition);
      const cleanups: (() => void)[] = [];
      text(view.regions[0]!, () => count.value, cleanups);
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");

    const dispose = mount(Counter, target);
    count.value = 2;

    expect(target.textContent).toBe("2");
    expect(setups).toBe(1);
    dispose();
    expect(target.textContent).toBe("");
  });

  test("finishes block teardown when cleanup callbacks throw", () => {
    const target = document.createElement("main");
    const fragment = document.createDocumentFragment();
    fragment.append(document.createElement("p"));
    const calls: string[] = [];
    const rendered = block(fragment, [
      () => calls.push("first"),
      () => {
        calls.push("throwing");
        throw new Error("cleanup failed");
      },
      () => calls.push("last"),
    ]);
    rendered.mount(target);

    expect(() => rendered.dispose()).toThrow("cleanup failed");
    expect(calls).toEqual(["last", "throwing", "first"]);
    expect(target.childNodes).toHaveLength(0);
  });

  test("finishes block retirement when cleanup callbacks throw", () => {
    const target = document.createElement("main");
    const fragment = document.createDocumentFragment();
    fragment.append(document.createElement("p"));
    const rendered = block(fragment, [
      () => {
        throw new Error("retirement cleanup failed");
      },
    ]);
    rendered.mount(target);

    expect(() => rendered.retire()).toThrow("retirement cleanup failed");
    expect(target.childNodes).toHaveLength(0);
  });

  test("preserves a render failure when its cleanup also fails", () => {
    try {
      rethrowWithCleanups(new Error("render failed"), [
        () => {
          throw new Error("cleanup failed");
        },
      ]);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String)).toEqual([
        "Error: render failed",
        "Error: cleanup failed",
      ]);
    }
  });

  test("preserves a server render failure when teardown also fails", async () => {
    const primary = new Error("primary server render failed");
    const cleanup = new Error("server teardown failed");
    let disposals = 0;
    const Broken = component(() => {
      const rendered: Block & { serverHtml(): string } = {
        nodes: [],
        mount(parent) {
          (parent as ServerRegion).blocks.push(rendered);
        },
        move() {},
        enter() {},
        leave: () => undefined,
        retire: () => undefined,
        dispose() {
          disposals += 1;
          throw cleanup;
        },
        serverHtml() {
          throw primary;
        },
      };
      return rendered;
    });

    const failure = await rejection(renderToStringAsync(Broken));
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(primary);
    expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
    expect(disposals).toBe(1);
  });

  test("reports late async block teardown failures after disposal", async () => {
    await Promise.all(
      ([undefined, "hydrate", "server"] as const).map(async (mode) => {
        let resolve!: (block: Block) => void;
        const candidate = new Promise<Block>((resolveCandidate) => {
          resolve = resolveCandidate;
        });
        const errors: unknown[] = [];
        const frame = {
          ...rootFrame(),
          mode,
          handleError: (error: unknown) => errors.push(error),
        } as RenderFrame;
        const pending = resolvedBlock(candidate, frame);
        pending.dispose();
        const cleanup = new Error(`late ${mode ?? "browser"} teardown failed`);
        resolve({
          nodes: [],
          mount() {},
          move() {},
          enter() {},
          leave: () => undefined,
          retire: () => undefined,
          dispose() {
            throw cleanup;
          },
        });
        await candidate;
        await Promise.resolve();
        expect(errors).toEqual([cleanup]);
      }),
    );
  });

  test("preserves a mount failure when teardown also fails", () => {
    const lifecycle = blockLifecycle();
    lifecycle.refMounts.push(() => {
      throw new Error("mount failed");
    });
    const rendered = block(
      document.createDocumentFragment(),
      [
        () => {
          throw new Error("cleanup failed");
        },
      ],
      lifecycle,
    );

    let failure: unknown;
    try {
      rendered.mount(document.createElement("main"));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toEqual(new Error("mount failed"));
    expect((failure as AggregateError).errors.map(String)).toContain("Error: cleanup failed");
  });

  test("disposes child-owned effects when child mounting fails", () => {
    const source = $signal(0);
    const observations: number[] = [];
    const Broken = component(() => {
      runtimeEffect(() => {
        observations.push(source.value);
      });
      const lifecycle = blockLifecycle();
      lifecycle.refMounts.push(() => {
        throw new Error("child mount failed");
      });
      return block(document.createDocumentFragment(), [], lifecycle);
    });
    const view = instantiate(template("<div><!--sol:s:0--><!--sol:e:0--></div>"));

    expect(() => child(view.regions[0]!, Broken, {}, [])).toThrow("child mount failed");
    source.value = 1;

    expect(observations).toEqual([0]);
  });

  test("validates mount boundaries", () => {
    const target = document.createElement("main");
    const Valid = component(() => block(document.createDocumentFragment()));
    expect(() => mount((() => undefined) as never, target)).toThrow("uncompiled component");
    expect(() => mount((() => undefined) as never, null as never)).toThrow("DOM Element target");
    expect(() => mount((() => undefined) as never, target, "bad props" as never)).toThrow(
      "props must be an object",
    );
    expect(() => mount(Valid, target, [] as never)).toThrow("props must be an object");
    expect(() => renderComponent(Valid, [] as never)).toThrow("props must be an object");
  });

  test("rejects calling the compiler-specialized Head handle directly", () => {
    expect(() => Head({})).toThrow("Head must be rendered as JSX inside a compiled component");
  });

  test("validates raw-text runtime operations", () => {
    const cleanups: Array<() => void> = [];
    expect(() => rawText(document.createElement("div"), () => [], cleanups)).toThrow(
      "expects a script, style, textarea, or title element",
    );
    expect(() =>
      rawText(document.createElement("title"), () => "not an array" as never, cleanups),
    ).toThrow("values must be an array");
    expect(cleanups).toHaveLength(0);
  });

  test("rejects every reflective mutation of readonly component props", () => {
    let receivedProps: Readonly<{ label: string }> | undefined;
    const Example = component((props: Readonly<{ label: string }>) => {
      receivedProps = props;
      return block(document.createDocumentFragment());
    });
    mount(Example, document.createElement("main"), { label: "original" });
    const props = receivedProps!;

    expect(() => Object.defineProperty(props, "label", { value: "changed" })).toThrow(
      "Component props are readonly",
    );
    expect(() => Reflect.defineProperty(props, "label", { value: "changed" })).toThrow(
      "Component props are readonly",
    );
    expect(() => Object.setPrototypeOf(props, null)).toThrow("Component props are readonly");
    expect(() => Reflect.setPrototypeOf(props, null)).toThrow("Component props are readonly");
    expect(() => Object.preventExtensions(props)).toThrow("Component props are readonly");
    expect(() => Reflect.preventExtensions(props)).toThrow("Component props are readonly");
    expect(() => Object.freeze(props)).toThrow("Component props are readonly");
    expect(() => Object.seal(props)).toThrow("Component props are readonly");
    expect(props.label).toBe("original");
    expect(Object.isExtensible(props)).toBe(true);
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
  });

  test("cleans setup-owned effects when component setup throws", () => {
    const source = $signal(1);
    let derivations = 0;
    const Broken = component(() => {
      $computed(() => {
        derivations += 1;
        return source.value;
      });
      throw new Error("setup failed");
    });
    const target = document.createElement("main");

    expect(() => mount(Broken, target)).toThrow("setup failed");
    source.value = 2;

    expect(derivations).toBe(1);
  });

  test("synchronizes form bindings in both directions", () => {
    const draft = $signal("first");
    const definition = template('<input data-sol-e="0">');
    const view = instantiate(definition);
    const cleanups: (() => void)[] = [];
    const input = view.elements[0] as HTMLInputElement;
    bindValue(
      input,
      "value",
      () => draft.value,
      (value) => {
        draft.value = String(value);
      },
      cleanups,
    );

    expect(input.value).toBe("first");
    input.value = "second";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(draft.value).toBe("second");
    draft.value = "third";
    expect(input.value).toBe("third");
    for (const cleanup of cleanups.toReversed()) cleanup();
    input.value = "ignored";
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(draft.value).toBe("third");
  });

  test("synchronizes inferred checked bindings in both directions", () => {
    const completed = $signal(false);
    const definition = template('<input type="checkbox" data-sol-e="0">');
    const view = instantiate(definition);
    const cleanups: (() => void)[] = [];
    const input = view.elements[0] as HTMLInputElement;
    bindValue(
      input,
      "checked",
      () => completed.value,
      (value) => {
        completed.value = Boolean(value);
      },
      cleanups,
    );

    expect(input.checked).toBe(false);
    input.checked = true;
    input.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    expect(completed.value).toBe(true);
    completed.value = false;
    expect(input.checked).toBe(false);
    for (const cleanup of cleanups.toReversed()) cleanup();
  });

  test("disposes effects owned by removed conditional branches", () => {
    const visible = $signal(true);
    const branchValue = $signal("first");
    let branchReads = 0;
    const parentTemplate = template("<div><!--sol:s:0--><!--sol:e:0--></div>");
    const Parent = component(() => {
      const view = instantiate(parentTemplate);
      const cleanups: (() => void)[] = [];
      when(
        view.regions[0]!,
        () => visible.value,
        () => {
          const fragment = document.createDocumentFragment();
          fragment.append(document.createTextNode("visible"));
          const branchCleanups = [
            runtimeEffect(() => {
              branchReads += 1;
              void branchValue.value;
            }),
          ];
          return block(fragment, branchCleanups);
        },
        () => block(document.createDocumentFragment()),
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");
    mount(Parent, target);

    visible.value = false;
    branchValue.value = "ignored";

    expect(branchReads).toBe(1);
  });

  test("keeps and retries a conditional branch when its replacement fails", () => {
    const condition = $signal(false);
    const retry = $signal(0);
    let attempts = 0;
    const definition = template("<div><!--sol:s:0--><!--sol:e:0--></div>");
    const Parent = component(() => {
      const view = instantiate(definition);
      const cleanups: (() => void)[] = [];
      when(
        view.regions[0]!,
        () => {
          void retry.value;
          return condition.value;
        },
        () => {
          attempts += 1;
          throw new Error("replacement failed");
        },
        () => {
          const fragment = document.createDocumentFragment();
          fragment.append(document.createTextNode("old branch"));
          return block(fragment);
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");
    const dispose = mount(Parent, target);

    expect(() => {
      condition.value = true;
    }).toThrow("replacement failed");
    expect(target.textContent).toBe("old branch");
    expect(attempts).toBe(1);
    expect(() => {
      retry.value += 1;
    }).toThrow("replacement failed");
    expect(target.textContent).toBe("old branch");
    expect(attempts).toBe(2);
    dispose();
  });

  test("registers server conditional and list blocks for disposal", () => {
    const region: ServerRegion = { kind: "server-region", index: 0, blocks: [] };
    const cleanups: Array<() => void> = [];
    let disposed = 0;
    const serverTestBlock = (): Block =>
      ({
        nodes: [],
        mount() {},
        move() {},
        enter() {},
        leave: () => undefined,
        retire: () => undefined,
        dispose() {
          disposed += 1;
        },
        serverHtml: () => "",
      }) as Block;

    when(region, () => true, serverTestBlock, serverTestBlock, cleanups);
    list(
      region,
      () => [1, 2],
      (item) => item,
      serverTestBlock,
      cleanups,
    );
    expect(region.blocks).toHaveLength(3);
    expect(cleanups).toHaveLength(3);
    for (const cleanup of cleanups.toReversed()) cleanup();
    expect(disposed).toBe(3);

    const failedCleanups: Array<() => void> = [];
    let failedRowDisposed = 0;
    expect(() =>
      list(
        { kind: "server-region", index: 1, blocks: [] },
        () => [1, 2],
        (item) => item,
        (item) => {
          if (item.value === 2) throw new Error("row failed");
          const rendered = serverTestBlock();
          const dispose = rendered.dispose.bind(rendered);
          rendered.dispose = () => {
            failedRowDisposed += 1;
            dispose();
          };
          return rendered;
        },
        failedCleanups,
      ),
    ).toThrow("row failed");
    for (const cleanup of failedCleanups.toReversed()) cleanup();
    expect(failedRowDisposed).toBe(1);
  });

  test("disposes setup-owned computed effects", () => {
    const source = $signal(1);
    let derivations = 0;
    const definition = template("<p><!--sol:s:0--><!--sol:e:0--></p>");
    const Derived = component(() => {
      const value = $computed(() => {
        derivations += 1;
        return source.value * 2;
      });
      const view = instantiate(definition);
      const cleanups: (() => void)[] = [];
      text(view.regions[0]!, () => value.value, cleanups);
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");
    const dispose = mount(Derived, target);

    dispose();
    source.value = 2;

    expect(derivations).toBe(1);
  });

  test("disposes setup-owned effects while an async component is pending", async () => {
    const source = $signal(0);
    const observations: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const Async = component(async () => {
      runtimeEffect(() => observations.push(source.value));
      await gate;
      return block(document.createDocumentFragment());
    });
    const target = document.createElement("div");
    const dispose = mount(Async, target);

    expect(observations).toEqual([0]);
    dispose();
    source.value = 1;
    expect(observations).toEqual([0]);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(target.childNodes).toHaveLength(0);
  });

  test("updates reactive child props without rerunning child setup", () => {
    const label = $signal("First");
    let childSetups = 0;
    let childReads = 0;
    let propReads = 0;
    const childTemplate = template("<span><!--sol:s:0--><!--sol:e:0--></span>");
    const Child = component((props: Readonly<{ label: string }>) => {
      childSetups += 1;
      const view = instantiate(childTemplate);
      const cleanups: (() => void)[] = [];
      text(
        view.regions[0]!,
        () => {
          childReads += 1;
          return props.label;
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const parentTemplate = template("<div><!--sol:s:0--><!--sol:e:0--></div>");
    const Parent = component(() => {
      const view = instantiate(parentTemplate);
      const cleanups: (() => void)[] = [];
      child(
        view.regions[0]!,
        Child,
        {
          label: () => {
            propReads += 1;
            return label.value;
          },
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");
    const dispose = mount(Parent, target);

    label.value = "Second";

    expect(target.textContent).toBe("Second");
    expect(childSetups).toBe(1);
    expect(propReads).toBe(2);
    dispose();
    label.value = "Ignored";
    expect(childReads).toBe(2);
  });

  test("reorders keyed blocks while preserving their nodes", () => {
    const values = $signal([
      { id: 1, label: "One" },
      { id: 2, label: "Two" },
    ]);
    const definition = template("<ol><!--sol:s:0--><!--sol:e:0--></ol>");
    const rowDefinition = template("<li><!--sol:s:0--><!--sol:e:0--></li>");
    const List = component(() => {
      const view = instantiate(definition);
      const cleanups: (() => void)[] = [];
      list(
        view.regions[0]!,
        () => values.value,
        (item) => item.id,
        (item) => {
          const row = instantiate(rowDefinition);
          const rowCleanups: (() => void)[] = [];
          text(row.regions[0]!, () => item.value.label, rowCleanups);
          return block(row.fragment, rowCleanups);
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");
    mount(List, target);
    const firstNode = target.querySelectorAll("li")[0];

    values.value.reverse();

    expect([...target.querySelectorAll("li")].map((node) => node.textContent)).toEqual([
      "Two",
      "One",
    ]);
    expect(target.querySelectorAll("li")[1]).toBe(firstNode);
  });

  test("rolls back and disposes staged keyed rows after render or mount failures", () => {
    for (const failure of ["render", "mount"] as const) {
      const values = $signal([0]);
      const disposals = new Map<number, number>();
      const definition = template("<div><!--sol:s:0--><!--sol:e:0--></div>");
      const List = component(() => {
        const view = instantiate(definition);
        const cleanups: Array<() => void> = [];
        list(
          view.regions[0]!,
          () => values.value,
          (item) => item,
          (item) => {
            const value = item.value;
            if (value === 2 && failure === "render") throw new Error("row render failed");
            const fragment = document.createDocumentFragment();
            fragment.append(document.createTextNode(String(value)));
            const lifecycle = blockLifecycle();
            if (value === 2 && failure === "mount") {
              lifecycle.refMounts.push(() => {
                throw new Error("row mount failed");
              });
            }
            return block(
              fragment,
              [() => disposals.set(value, (disposals.get(value) ?? 0) + 1)],
              lifecycle,
            );
          },
          cleanups,
        );
        return block(view.fragment, cleanups);
      });
      const target = document.createElement("main");
      const dispose = mount(List, target);

      expect(() => {
        values.value = [1, 2];
      }).toThrow(failure === "render" ? "row render failed" : "row mount failed");
      expect(target.textContent).toBe("0");
      expect(disposals.get(1)).toBe(1);
      expect(disposals.get(0)).toBeUndefined();
      dispose();
      expect(disposals.get(0)).toBe(1);
      expect(disposals.get(1)).toBe(1);
    }
  });

  test("rolls back staged keyed rows when a reused row update fails", () => {
    type Item = { id: number; label: string };
    const values = $signal<Item[]>([{ id: 1, label: "one" }]);
    const disposals = new Map<number, number>();
    const definition = template("<div><!--sol:s:0--><!--sol:e:0--></div>");
    const rowDefinition = template("<p><!--sol:s:0--><!--sol:e:0--></p>");
    const List = component(() => {
      const view = instantiate(definition);
      const cleanups: Array<() => void> = [];
      list(
        view.regions[0]!,
        () => values.value,
        (item) => item.id,
        (item) => {
          const id = item.value.id;
          const row = instantiate(rowDefinition);
          const rowCleanups: Array<() => void> = [
            () => disposals.set(id, (disposals.get(id) ?? 0) + 1),
          ];
          text(
            row.regions[0]!,
            () => {
              if (item.value.label === "boom") throw new Error("row update failed");
              return item.value.label;
            },
            rowCleanups,
          );
          return block(row.fragment, rowCleanups);
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    const target = document.createElement("main");
    const dispose = mount(List, target);

    expect(() => {
      values.value = [
        { id: 1, label: "boom" },
        { id: 2, label: "two" },
      ];
    }).toThrow("row update failed");
    expect(target.textContent).toBe("one");
    expect(disposals.get(2)).toBe(1);

    values.value = [
      { id: 1, label: "recovered" },
      { id: 2, label: "two" },
    ];
    expect(target.textContent).toBe("recoveredtwo");
    expect(target.querySelectorAll("p")).toHaveLength(2);
    dispose();
    expect(disposals.get(1)).toBe(1);
    expect(disposals.get(2)).toBe(2);
  });

  test("disposes effects owned by removed keyed rows", () => {
    const items = $signal([{ id: 1, value: "first" }]);
    const removed = items.value[0]!;
    let rowReads = 0;
    const definition = template("<div><!--sol:s:0--><!--sol:e:0--></div>");
    const List = component(() => {
      const view = instantiate(definition);
      const cleanups: (() => void)[] = [];
      list(
        view.regions[0]!,
        () => items.value,
        (item) => item.id,
        (item) => {
          const fragment = document.createDocumentFragment();
          fragment.append(document.createTextNode("row"));
          const rowCleanups = [
            runtimeEffect(() => {
              rowReads += 1;
              void item.value.value;
            }),
          ];
          return block(fragment, rowCleanups);
        },
        cleanups,
      );
      return block(view.fragment, cleanups);
    });
    mount(List, document.createElement("main"));

    items.value.splice(0, 1);
    removed.value = "ignored";

    expect(rowReads).toBe(1);
  });
});
