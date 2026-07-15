import type { Component, Context } from "./components.ts";
import {
  $signal,
  batch,
  computedInFrame,
  isObject,
  reactive,
  rethrowWithCleanups,
  rethrowWithDisposals,
  runDisposals,
  runtimeEffect,
  transactionalBatch,
  type Signal,
} from "./reactivity.ts";
import {
  displayValue,
  displayValues,
  getFactory,
  reportError,
  readonlyProps,
  resolvedBlock,
  rootFrame,
  routeRuntime,
  settleRetirement,
  type Block,
  type Cleanup,
  type Region,
  type RenderFrame,
} from "./rendering.ts";
import { devtoolsComponentPropsUpdated } from "./devtools-hook.ts";
import { routeHref, type RouteDefinition, type RouteValues } from "./routes.ts";
import { deployedPath } from "./route-base.ts";
import { CONTEXT, ROUTE } from "./symbols.ts";
import {
  isServerElement,
  isServerRegion,
  mountServerBlock,
  normalizeHtmlString,
  setServerAttribute,
  serverSafeRawText,
  serverRawValue,
  type ServerElement,
} from "./server-rendering.ts";
import { claimHydratedText, regionHydrationClaim } from "./hydration-rendering.ts";
import { HydrationMismatchError } from "./ssr-session.ts";
import { isHtmlSelectElement } from "./dom-realm.ts";

type ContextRecord = Context<object> & { readonly [CONTEXT]: symbol };
type RenderFactory = (frame: RenderFrame) => Block;
const RAW_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "TITLE"]);

export type ClassValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ClassValue[]
  | { readonly [className: string]: unknown };

export function normalizeClass(value: ClassValue): string {
  const classes: string[] = [];
  const activeArrays = new Set<ClassValue[]>();
  const append = (part: ClassValue): void => {
    if (part == null || typeof part === "boolean" || part === "") return;
    if (typeof part === "string" || typeof part === "number") {
      classes.push(String(part));
      return;
    }
    if (Array.isArray(part)) {
      if (activeArrays.has(part)) {
        throw new TypeError("Class value arrays cannot contain cycles");
      }
      activeArrays.add(part);
      try {
        for (const item of part) append(item);
      } finally {
        activeArrays.delete(part);
      }
      return;
    }
    if (typeof part === "object") {
      const prototype = Object.getPrototypeOf(part) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Class values must contain only arrays and plain objects");
      }
      for (const key of Reflect.ownKeys(part)) {
        if (typeof key !== "string") {
          throw new TypeError("Class maps must contain only string-named data properties");
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(part, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("Class maps must contain only string-named data properties");
        }
        if (descriptor.enumerable && descriptor.value) classes.push(key);
      }
      return;
    }
    throw new TypeError(
      "Class values must contain only strings, numbers, booleans, arrays, and plain objects",
    );
  };
  append(value);
  return classes.join(" ");
}

export function text(region: Region, getValue: () => unknown, cleanups: Cleanup[]): void {
  if (isServerRegion(region)) {
    staticText(region, getValue());
    return;
  }
  const claimed = claimHydratedText(region);
  let textNode = claimed ?? undefined;
  let hydrating = claimed !== undefined;
  cleanups.push(
    runtimeEffect(() => {
      const value = displayValue(getValue());
      if (hydrating) {
        hydrating = false;
        if ((textNode?.data ?? "") !== value) {
          throw new HydrationMismatchError("dynamic text differs");
        }
        return;
      }
      if (value === "") {
        textNode?.remove();
        textNode = undefined;
        return;
      }
      if (!textNode) {
        textNode = region.end.ownerDocument.createTextNode(value);
        region.end.parentNode?.insertBefore(textNode, region.end);
      } else {
        textNode.data = value;
      }
    }),
  );
}

export function staticText(region: Region, value: unknown): void {
  const displayed = displayValue(value);
  if (isServerRegion(region)) {
    mountServerBlock(
      serverRawValue(
        displayed.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
      ),
      region,
    );
    return;
  }
  const claimed = claimHydratedText(region);
  if (claimed !== undefined) {
    if ((claimed?.data ?? "") !== displayed) {
      throw new HydrationMismatchError("dynamic text differs");
    }
    return;
  }
  if (displayed !== "") {
    region.end.parentNode?.insertBefore(
      region.end.ownerDocument.createTextNode(displayed),
      region.end,
    );
  }
}

export function rawText(
  element: Element | ServerElement,
  getValues: () => readonly unknown[],
  cleanups: Cleanup[],
): void {
  if (isServerElement(element)) {
    if (!RAW_TEXT_TAGS.has(element.tag.toUpperCase())) {
      throw new TypeError("rawText() expects a script, style, textarea, or title element");
    }
    const values = getValues();
    if (!Array.isArray(values)) throw new TypeError("rawText() values must be an array");
    element.textContent = displayValues(values);
    return;
  }
  if (!element || element.nodeType !== Node.ELEMENT_NODE || !RAW_TEXT_TAGS.has(element.tagName)) {
    throw new TypeError("rawText() expects a script, style, textarea, or title element");
  }
  let hydrating = element.hasAttribute("data-sol-e");
  cleanups.push(
    runtimeEffect(() => {
      const values = getValues();
      if (!Array.isArray(values)) throw new TypeError("rawText() values must be an array");
      const value = displayValues(values);
      if (hydrating) {
        hydrating = false;
        if (element.textContent !== serverSafeRawText(element.tagName, value)) {
          throw new HydrationMismatchError("raw text differs");
        }
        return;
      }
      element.textContent = value;
    }),
  );
}

export function head(render: RenderFactory, cleanups: Cleanup[], frame: RenderFrame): void {
  if (frame.mode === "server") {
    const rendered = render({ ...frame, head: true });
    if (!frame.ssr) throw new Error("Head server rendering requires an SSR session");
    frame.ssr.captureHead(rendered);
    cleanups.push(() => rendered.dispose());
    return;
  }
  if (typeof document === "undefined" || !document.head) {
    throw new Error("Head requires a browser document with a head element");
  }
  const hydrating = frame.mode === "hydrate" && frame.hydration && !frame.hydration.committed;
  const headClaim = hydrating ? frame.headClaims?.shift() : undefined;
  if (hydrating && !headClaim) {
    throw new HydrationMismatchError("server Head block is missing");
  }
  const rendered = render({ ...frame, head: true, claim: headClaim?.claim ?? frame.claim });
  if (headClaim && headClaim.claim.cursor !== headClaim.end) {
    const claimedNodes = rendered.nodes;
    rendered.dispose();
    for (const node of claimedNodes) headClaim.end.before(node);
    throw new HydrationMismatchError("unexpected server Head nodes");
  }
  cleanups.push(() => {
    const preserveClaim = Boolean(headClaim && frame.hydration && !frame.hydration.committed);
    const claimedNodes = preserveClaim ? rendered.nodes : [];
    rendered.dispose();
    if (preserveClaim) {
      for (const node of claimedNodes) headClaim!.end.before(node);
    } else {
      headClaim?.start.remove();
      headClaim?.end.remove();
    }
  });
  rendered.mount(document.head, document.head.firstChild);
}

const writableProperties = new WeakMap<Element, Map<string, boolean>>();

const BOOLEAN_PROPERTIES = new Map([
  ["allowfullscreen", "allowFullscreen"],
  ["async", "async"],
  ["autofocus", "autofocus"],
  ["autoplay", "autoplay"],
  ["checked", "checked"],
  ["controls", "controls"],
  ["default", "default"],
  ["defer", "defer"],
  ["disabled", "disabled"],
  ["disablepictureinpicture", "disablePictureInPicture"],
  ["disableremoteplayback", "disableRemotePlayback"],
  ["formnovalidate", "formNoValidate"],
  ["hidden", "hidden"],
  ["inert", "inert"],
  ["ismap", "isMap"],
  ["itemscope", "itemScope"],
  ["loop", "loop"],
  ["multiple", "multiple"],
  ["muted", "muted"],
  ["nomodule", "noModule"],
  ["novalidate", "noValidate"],
  ["open", "open"],
  ["playsinline", "playsInline"],
  ["readonly", "readOnly"],
  ["required", "required"],
  ["reversed", "reversed"],
  ["selected", "selected"],
]);

function booleanProperty(name: string): string | undefined {
  return BOOLEAN_PROPERTIES.get(name.toLowerCase());
}

function isBooleanAttribute(name: string): boolean {
  return booleanProperty(name) !== undefined;
}

const ENUMERATED_BOOLEAN_ATTRIBUTES = new Map<string, readonly [string, string]>([
  ["contenteditable", ["true", "false"]],
  ["draggable", ["true", "false"]],
  ["spellcheck", ["true", "false"]],
  ["translate", ["yes", "no"]],
]);

function enumeratedBooleanToken(name: string, value: unknown): string | undefined {
  if (typeof value !== "boolean") return undefined;
  return ENUMERATED_BOOLEAN_ATTRIBUTES.get(name.toLowerCase())?.[value ? 0 : 1];
}

function isWritableProperty(element: Element, property: string): boolean {
  let properties = writableProperties.get(element);
  if (!properties) {
    properties = new Map();
    writableProperties.set(element, properties);
  }
  const cached = properties.get(property);
  if (cached !== undefined) return cached;
  let owner: object | null = element;
  let descriptor: PropertyDescriptor | undefined;
  while (owner && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(owner, property);
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  const writable = Boolean(
    descriptor &&
    ("writable" in descriptor ? descriptor.writable : typeof descriptor.set === "function"),
  );
  properties.set(property, writable);
  return writable;
}

const TEXT_VALUE_ELEMENTS = new Set(["input", "textarea", "select", "option"]);

function textControlString(value: unknown, tag?: string): string {
  const normalized = normalizeHtmlString(String(value ?? ""));
  return tag === "textarea" ? normalized.replaceAll(/\r\n?/g, "\n") : normalized;
}

function attributeString(value: unknown): string {
  return normalizeHtmlString(String(value));
}

type TextControlElement =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement
  | HTMLOptionElement;

function normalizedInputValue(input: HTMLInputElement, expected: string): string {
  const probe = input.ownerDocument.createElement("input");
  for (const inputAttribute of Array.from(input.attributes)) {
    if (inputAttribute.name !== "value") {
      probe.setAttribute(inputAttribute.name, inputAttribute.value);
    }
  }
  probe.setAttribute("value", expected);
  return probe.value;
}

function expectedHydratedTextControlValue(
  element: TextControlElement,
  value: unknown,
): string | undefined {
  const tag = element.tagName.toLowerCase();
  const expected = textControlString(value, tag);
  if (tag === "input") {
    const input = element as HTMLInputElement;
    return input.getAttribute("value") === expected
      ? normalizedInputValue(input, expected)
      : undefined;
  }
  if (tag === "textarea") {
    return (element as HTMLTextAreaElement).defaultValue === expected ? expected : undefined;
  }
  if (tag === "option") {
    return element.getAttribute("value") === expected ? expected : undefined;
  }

  const select = element as HTMLSelectElement;
  const options = Array.from(select.options);
  const match = options.findIndex((option) => option.value === expected);
  if (options.some((option, index) => option.hasAttribute("selected") !== (index === match))) {
    return undefined;
  }
  if (match >= 0) return expected;
  const container = select.ownerDocument.createElement("div");
  container.innerHTML = select.outerHTML;
  return container.querySelector("select")?.value;
}

function setDomValue(element: Element, name: string, value: unknown): void {
  const property = name === "className" ? "className" : name === "htmlFor" ? "htmlFor" : name;
  if (name.startsWith("aria-") || name.startsWith("data-")) {
    if (value == null) element.removeAttribute(name);
    else element.setAttribute(name, attributeString(value));
    return;
  }
  const reflectedBoolean = booleanProperty(name);
  if (reflectedBoolean) {
    const enabled = Boolean(value);
    if (reflectedBoolean in element && isWritableProperty(element, reflectedBoolean)) {
      (element as unknown as Record<string, unknown>)[reflectedBoolean] = enabled;
    } else if (enabled) {
      element.setAttribute(name, "");
    } else {
      element.removeAttribute(name);
    }
    return;
  }
  const enumeratedBoolean = enumeratedBooleanToken(name, value);
  if (enumeratedBoolean !== undefined) {
    if (property in element && isWritableProperty(element, property)) {
      (element as unknown as Record<string, unknown>)[property] = value;
    } else {
      element.setAttribute(name, enumeratedBoolean);
    }
    return;
  }
  const tag = element.tagName.toLowerCase();
  if (name === "value" && TEXT_VALUE_ELEMENTS.has(tag)) {
    const normalized = textControlString(value, tag);
    if (property in element && isWritableProperty(element, property)) {
      (element as unknown as Record<string, unknown>)[property] = normalized;
    } else {
      element.setAttribute(name, normalized);
    }
    return;
  }
  if (value == null || value === false) {
    element.removeAttribute(name);
    return;
  }
  if (value === true) {
    element.setAttribute(name, "");
    return;
  }
  const normalized = typeof value === "string" ? attributeString(value) : value;
  if (property in element && isWritableProperty(element, property)) {
    (element as unknown as Record<string, unknown>)[property] = normalized;
  } else {
    element.setAttribute(name, attributeString(normalized));
  }
}

function setServerValue(element: ServerElement, name: string, value: unknown): void {
  const enumeratedBoolean = enumeratedBooleanToken(name, value);
  if (name === "value" && TEXT_VALUE_ELEMENTS.has(element.tag)) {
    setServerAttribute(element, name, textControlString(value, element.tag));
  } else if (name.startsWith("aria-") || name.startsWith("data-")) {
    setServerAttribute(element, name, value == null ? undefined : attributeString(value));
  } else if (isBooleanAttribute(name)) {
    setServerAttribute(element, name, value ? true : undefined);
  } else if (enumeratedBoolean !== undefined) {
    setServerAttribute(element, name, enumeratedBoolean);
  } else if (value == null || value === false) {
    setServerAttribute(element, name, undefined);
  } else {
    setServerAttribute(element, name, value === true ? "" : attributeString(value));
  }
}

function serializedAttribute(name: string, value: unknown): string | null {
  if (name.startsWith("aria-") || name.startsWith("data-")) {
    return value == null ? null : attributeString(value);
  }
  if (isBooleanAttribute(name)) return value ? "" : null;
  const enumeratedBoolean = enumeratedBooleanToken(name, value);
  if (enumeratedBoolean !== undefined) return enumeratedBoolean;
  if (value == null || value === false) return null;
  return value === true ? "" : attributeString(value);
}

export function attribute(
  element: Element | ServerElement,
  name: string,
  getValue: () => unknown,
  cleanups: Cleanup[],
): void {
  const isClass = name === "class" || name === "className" || name === "classNames";
  if (isServerElement(element)) {
    setServerValue(
      element,
      isClass ? "class" : name,
      isClass ? normalizeClass(getValue() as ClassValue) : getValue(),
    );
    return;
  }
  let hydrating = element.hasAttribute("data-sol-e");
  cleanups.push(
    runtimeEffect(() => {
      const property = isClass ? "class" : name;
      const value = isClass ? normalizeClass(getValue() as ClassValue) : getValue();
      if (hydrating) {
        hydrating = false;
        const formValue =
          property === "value" && TEXT_VALUE_ELEMENTS.has(element.tagName.toLowerCase());
        const actual = formValue
          ? (element as TextControlElement).value
          : element.getAttribute(property);
        const expected = formValue
          ? expectedHydratedTextControlValue(element as TextControlElement, value)
          : serializedAttribute(property, value);
        if (expected === undefined || actual !== expected) {
          throw new HydrationMismatchError(`dynamic attribute ${property} differs`);
        }
        return;
      }
      setDomValue(element, property, value);
    }),
  );
}

export function event(
  element: Element | ServerElement,
  name: string,
  getHandler: () => unknown,
  cleanups: Cleanup[],
): void {
  if (isServerElement(element)) return;
  const listener = (domEvent: Event): void => {
    const handler = getHandler();
    if (typeof handler !== "function") return;
    batch(() => handler(domEvent));
  };
  element.addEventListener(name, listener);
  cleanups.push(() => element.removeEventListener(name, listener));
}

export function link<Path extends string, Values extends RouteValues>(
  element: HTMLAnchorElement | ServerElement,
  getRoute: () => RouteDefinition<Path, Values>,
  getDestination: () => Readonly<Record<string, unknown>>,
  getReplace: () => boolean,
  cleanups: Cleanup[],
): void {
  if (
    !isServerElement(element) &&
    (!element || element.nodeType !== Node.ELEMENT_NODE || element.tagName !== "A")
  ) {
    throw new TypeError("Link must decorate an anchor element");
  }
  const logicalHref = (): string => {
    const definition = getRoute();
    if (
      !definition ||
      typeof definition !== "object" ||
      !(definition as unknown as { [ROUTE]?: unknown })[ROUTE]
    ) {
      throw new TypeError("Link route must be a route definition");
    }
    return routeHref(definition, getDestination());
  };
  const href = (): string => deployedPath(logicalHref());
  if (isServerElement(element)) {
    setServerAttribute(element, "href", href());
    return;
  }
  let hydrating = element.hasAttribute("data-sol-e");
  cleanups.push(
    runtimeEffect(() => {
      const value = href();
      if (hydrating) {
        hydrating = false;
        if (element.getAttribute("href") !== value) {
          throw new HydrationMismatchError("Link href differs");
        }
        return;
      }
      element.setAttribute("href", value);
    }),
    (() => {
      const listener = (domEvent: MouseEvent): void => {
        if (
          domEvent.defaultPrevented ||
          domEvent.button !== 0 ||
          domEvent.metaKey ||
          domEvent.ctrlKey ||
          domEvent.shiftKey ||
          domEvent.altKey ||
          element.hasAttribute("download")
        )
          return;
        const target = element.getAttribute("target");
        if (target && target.toLowerCase() !== "_self") return;
        if (!routeRuntime) throw new Error("Route runtime is not initialized");
        const replace = getReplace();
        if (typeof replace !== "boolean") throw new TypeError("Link replace must be a boolean");
        domEvent.preventDefault();
        routeRuntime.navigate(logicalHref(), { replace });
      };
      element.addEventListener("click", listener);
      return () => element.removeEventListener("click", listener);
    })(),
  );
}

export function bindValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | ServerElement,
  property: "value" | "checked",
  getValue: () => unknown,
  setValue: (value: unknown) => void,
  cleanups: Cleanup[],
): void {
  if (isServerElement(element)) {
    setServerValue(element, property, property === "checked" ? Boolean(getValue()) : getValue());
    return;
  }
  const eventName = property === "checked" || isHtmlSelectElement(element) ? "change" : "input";
  let hydrating = element.hasAttribute("data-sol-e");
  const stopEffect = runtimeEffect(() => {
    const next = getValue();
    const expected =
      property === "checked"
        ? Boolean(next)
        : hydrating
          ? expectedHydratedTextControlValue(element, next)
          : textControlString(next, element.tagName.toLowerCase());
    const actual = property === "checked" ? (element as HTMLInputElement).checked : element.value;
    if (hydrating) {
      hydrating = false;
      if (expected === undefined || actual !== expected) {
        throw new HydrationMismatchError(`bound ${property} differs`);
      }
      return;
    }
    if (actual !== expected) {
      if (property === "checked") (element as HTMLInputElement).checked = expected as boolean;
      else element.value = expected as string;
    }
  });
  const listener = (): void => {
    batch(() =>
      setValue(property === "checked" ? (element as HTMLInputElement).checked : element.value),
    );
  };
  element.addEventListener(eventName, listener);
  cleanups.push(stopEffect, () => element.removeEventListener(eventName, listener));
}

export function when(
  region: Region,
  getCondition: () => unknown,
  consequent: RenderFactory,
  alternate: RenderFactory,
  cleanups: Cleanup[],
  frame: RenderFrame = rootFrame(),
): void {
  const renderFrame = frameForRegion(frame, region);
  if (isServerRegion(region)) {
    const rendered = (getCondition() ? consequent : alternate)(renderFrame);
    mountServerBlock(rendered, region);
    cleanups.push(() => rendered.dispose());
    return;
  }
  let current: Block | undefined;
  let currentCondition: boolean | undefined;
  let initialized = false;
  const leaving = new Map<boolean, Block>();
  const stop = runtimeEffect(() => {
    let transitionFailure: unknown;
    const nextCondition = Boolean(getCondition());
    if (nextCondition === currentCondition) return;
    const previousCondition = currentCondition;
    const previous = current;
    const revived = leaving.get(nextCondition);
    let candidate: Block | undefined;
    try {
      candidate = revived ?? (nextCondition ? consequent : alternate)(renderFrame);
      if (revived) candidate.move(region.end.parentNode!, region.end);
      else candidate.mount(region.end.parentNode!, region.end);
      if (initialized) candidate.enter();
    } catch (error) {
      if (revived) leaving.delete(nextCondition);
      if (candidate) {
        rethrowWithDisposals(
          error,
          [() => candidate!.dispose()],
          "Conditional render and teardown both failed",
        );
      }
      throw error;
    }
    if (revived) leaving.delete(nextCondition);
    currentCondition = nextCondition;
    current = candidate;
    initialized = true;
    if (previous && previousCondition !== undefined) {
      let finished: Promise<void> | undefined;
      try {
        finished = previous.leave();
      } catch (error) {
        transitionFailure = error;
        try {
          previous.dispose();
        } catch (disposalError) {
          transitionFailure = new AggregateError(
            [error, disposalError],
            "Conditional transition and teardown both failed",
            { cause: error },
          );
        }
      }
      if (finished) {
        leaving.set(previousCondition, previous);
        settleRetirement(
          finished,
          () => {
            if (leaving.get(previousCondition) !== previous) return;
            leaving.delete(previousCondition);
            previous.dispose();
          },
          (error) => {
            let reported = error;
            if (leaving.get(previousCondition) === previous) {
              leaving.delete(previousCondition);
              try {
                previous.dispose();
              } catch (disposalError) {
                reported = new AggregateError(
                  [error, disposalError],
                  "Conditional transition and teardown both failed",
                  { cause: error },
                );
              }
            }
            reportError(renderFrame, reported);
          },
        );
      } else if (transitionFailure === undefined) {
        previous.dispose();
      }
    }
    if (transitionFailure !== undefined) throw transitionFailure;
  });
  cleanups.push(stop, () => {
    runDisposals([
      ...[...leaving.values()].map((leavingBlock) => () => leavingBlock.dispose()),
      () => current?.dispose(),
    ]);
    leaving.clear();
  });
}

interface ListRow<T> {
  key: unknown;
  item: Signal<T>;
  index: Signal<number>;
  block: Block;
}

function sameKey(left: unknown, right: unknown): boolean {
  return (
    left === right ||
    (typeof left === "number" &&
      typeof right === "number" &&
      Number.isNaN(left) &&
      Number.isNaN(right))
  );
}

function* listEntries<T>(items: Iterable<T>): IterableIterator<{ item: T; index: number }> {
  if (Array.isArray(items)) {
    for (let index = 0; index < items.length; index += 1) {
      if (index in items) yield { item: items[index] as T, index };
    }
    return;
  }
  let index = 0;
  for (const item of items) {
    yield { item, index };
    index += 1;
  }
}

export function list<T>(
  region: Region,
  getItems: () => Iterable<T>,
  getKey: (item: T, index: number) => unknown,
  render: (item: Signal<T>, index: Signal<number>, frame: RenderFrame) => Block,
  cleanups: Cleanup[],
  frame: RenderFrame = rootFrame(),
): void {
  const renderFrame = frameForRegion(frame, region);
  if (isServerRegion(region)) {
    const keys = new Set<unknown>();
    for (const { item: itemValue, index } of listEntries(getItems())) {
      const key = getKey(itemValue, index);
      if (keys.has(key)) throw new Error("Keyed JSX lists require unique keys");
      keys.add(key);
      const item = $signal(itemValue);
      const position = $signal(index);
      const rendered = render(item, position, renderFrame);
      mountServerBlock(rendered, region);
      cleanups.push(() => rendered.dispose());
    }
    return;
  }
  let rows = new Map<unknown, ListRow<T>>();
  const leavingRows = new Map<unknown, ListRow<T>>();
  let order: unknown[] = [];
  let initialized = false;
  const stop = runtimeEffect(() => {
    const entries = Array.from(listEntries(getItems()), ({ item, index }) => ({
      item,
      index,
      key: getKey(item, index),
    }));
    const uniqueKeys = new Set(entries.map((entry) => entry.key));
    if (uniqueKeys.size !== entries.length) throw new Error("Keyed JSX lists require unique keys");

    const previousRows = rows;
    const nextRows = new Map<unknown, ListRow<T>>();
    const createdRows: ListRow<T>[] = [];
    const revivedKeys = new Set<unknown>();
    const updates: Array<{ row: ListRow<T>; item: T; index: number }> = [];
    try {
      for (const entry of entries) {
        let row = rows.get(entry.key) ?? leavingRows.get(entry.key);
        if (row) {
          if (leavingRows.get(entry.key) === row) revivedKeys.add(entry.key);
          updates.push({ row, item: entry.item, index: entry.index });
        } else {
          const item = $signal(entry.item);
          const index = $signal(entry.index);
          row = { key: entry.key, item, index, block: render(item, index, renderFrame) };
          createdRows.push(row);
        }
        nextRows.set(entry.key, row);
      }
    } catch (error) {
      rethrowWithDisposals(
        error,
        createdRows.map((row) => () => row.block.dispose()),
        "List render and teardown both failed",
      );
    }

    const activeKeys = [...nextRows.keys()];
    const projectedLeaving = new Set<unknown>();
    for (const key of leavingRows.keys()) {
      if (!revivedKeys.has(key)) projectedLeaving.add(key);
    }
    for (const key of rows.keys()) {
      if (!nextRows.has(key)) projectedLeaving.add(key);
    }
    let activeIndex = 0;
    const nextOrder = order.flatMap((key) => {
      if (projectedLeaving.has(key)) return [key];
      if (activeIndex >= activeKeys.length) return [];
      const activeKey = activeKeys[activeIndex];
      activeIndex += 1;
      return [activeKey];
    });
    nextOrder.push(...activeKeys.slice(activeIndex));
    const rollbackMounts = [
      ...createdRows.map((row) => () => row.block.dispose()),
      () => {
        for (const key of order) {
          const row = rows.get(key) ?? leavingRows.get(key);
          row?.block.mount(region.end.parentNode!, region.end);
        }
      },
    ];
    const orderUnchanged =
      createdRows.length === 0 &&
      revivedKeys.size === 0 &&
      nextOrder.length === order.length &&
      nextOrder.every((key, index) => sameKey(key, order[index]));
    if (!orderUnchanged) {
      try {
        for (const key of nextOrder) {
          const row = nextRows.get(key) ?? leavingRows.get(key) ?? rows.get(key);
          row?.block.mount(region.end.parentNode!, region.end);
        }
      } catch (error) {
        rethrowWithDisposals(error, rollbackMounts, "List mount and rollback both failed");
      }
    }

    const previousUpdates = updates.map((update) => ({
      row: update.row,
      item: update.row.item.value,
      index: update.row.index.value,
    }));
    try {
      transactionalBatch(() => {
        for (const update of updates) {
          update.row.item.value = update.item;
          update.row.index.value = update.index;
        }
      });
    } catch (error) {
      rethrowWithDisposals(
        error,
        [
          () =>
            transactionalBatch(() => {
              for (const update of previousUpdates) {
                update.row.item.value = update.item;
                update.row.index.value = update.index;
              }
            }),
          ...rollbackMounts,
        ],
        "List update and rollback both failed",
      );
    }
    for (const key of revivedKeys) leavingRows.delete(key);

    const removedKeys = new Set<unknown>();
    const transitionFailures: unknown[] = [];
    for (const [key, row] of rows) {
      if (nextRows.has(key)) continue;
      let finished: Promise<void> | undefined;
      try {
        finished = row.block.leave();
      } catch (error) {
        transitionFailures.push(error);
        try {
          row.block.dispose();
        } catch (disposalError) {
          transitionFailures.push(disposalError);
        }
        removedKeys.add(key);
        continue;
      }
      if (!finished) {
        row.block.dispose();
        removedKeys.add(key);
        continue;
      }
      leavingRows.set(key, row);
      settleRetirement(
        finished,
        () => {
          if (leavingRows.get(key) !== row) return;
          leavingRows.delete(key);
          order = order.filter((candidate) => !sameKey(candidate, key));
          row.block.dispose();
        },
        (error) => {
          let reported = error;
          if (leavingRows.get(key) === row) {
            leavingRows.delete(key);
            order = order.filter((candidate) => !sameKey(candidate, key));
            try {
              row.block.dispose();
            } catch (disposalError) {
              reported = new AggregateError(
                [error, disposalError],
                "List transition and teardown both failed",
                { cause: error },
              );
            }
          }
          reportError(renderFrame, reported);
        },
      );
    }
    order =
      removedKeys.size > 0
        ? nextOrder.filter((candidate) => !removedKeys.has(candidate))
        : nextOrder;
    rows = nextRows;
    const wasInitialized = initialized;
    initialized = true;
    if (wasInitialized) {
      for (const key of revivedKeys) {
        try {
          nextRows.get(key)!.block.enter();
        } catch (error) {
          transitionFailures.push(error);
        }
      }
      for (const [key, row] of nextRows) {
        if (previousRows.has(key) || revivedKeys.has(key)) continue;
        try {
          row.block.enter();
        } catch (error) {
          transitionFailures.push(error);
        }
      }
    }
    if (transitionFailures.length === 1) throw transitionFailures[0];
    if (transitionFailures.length > 1) {
      throw new AggregateError(transitionFailures, "List transitions and teardown failed", {
        cause: transitionFailures[0],
      });
    }
  });
  cleanups.push(stop, () => {
    runDisposals([
      ...[...rows.values()].map((row) => () => row.block.dispose()),
      ...[...leavingRows.values()].map((row) => () => row.block.dispose()),
    ]);
    rows.clear();
    leavingRows.clear();
    order = [];
  });
}

export function child<Props extends object>(
  region: Region,
  candidate: Component<Props>,
  propGetters: Record<string, () => unknown>,
  cleanups: Cleanup[],
  frame: RenderFrame = rootFrame(),
): void {
  const state = reactive<Record<string, unknown>>({});
  const props = readonlyProps(state) as Readonly<Props>;
  const renderFrame = frameForRegion(frame, region);
  const propCleanups: Cleanup[] = [];
  let mounted: Block | undefined;
  try {
    for (const [name, getter] of Object.entries(propGetters)) {
      let initialized = false;
      propCleanups.push(
        runtimeEffect(() => {
          state[name] = getter();
          if (initialized) devtoolsComponentPropsUpdated(props);
          initialized = true;
        }),
      );
    }
    mounted = resolvedBlock(getFactory(candidate)(props, renderFrame), renderFrame);
    if (isServerRegion(region)) mountServerBlock(mounted, region);
    else mounted.mount(region.end.parentNode!, region.end);
  } catch (error) {
    const failedBlock = mounted;
    rethrowWithCleanups(
      error,
      failedBlock ? [() => failedBlock.dispose(), ...propCleanups] : propCleanups,
    );
  }
  cleanups.push(() => mounted!.dispose(), ...propCleanups);
}

function contextKey(context: Context<object>): symbol {
  const key = (context as ContextRecord)[CONTEXT];
  if (typeof key !== "symbol") throw new TypeError("Invalid context Provider handle");
  return key;
}

export function contextProvider(
  region: Region,
  context: Context<object>,
  getData: () => unknown,
  render: RenderFactory,
  cleanups: Cleanup[],
  frame: RenderFrame,
): void {
  const key = contextKey(context);
  const readData = (): object => {
    const data = getData();
    if (!isObject(data) || Array.isArray(data)) {
      throw new TypeError("Context Provider data must be an object");
    }
    return data;
  };
  const data = computedInFrame(readData, frame);
  const contexts = new Map(frame.contexts);
  contexts.set(key, () => data.value);
  const childFrame: RenderFrame = { ...frame, contexts };
  const rendered = render(frameForRegion(childFrame, region));
  try {
    if (isServerRegion(region)) mountServerBlock(rendered, region);
    else rendered.mount(region.end.parentNode!, region.end);
  } catch (error) {
    rethrowWithDisposals(
      error,
      [() => rendered.dispose()],
      "Context Provider mount and rollback both failed",
    );
  }
  cleanups.push(() => rendered.dispose());
}

function frameForRegion(frame: RenderFrame, region: Region): RenderFrame {
  const claim = regionHydrationClaim(region);
  return claim ? { ...frame, claim } : frame;
}
