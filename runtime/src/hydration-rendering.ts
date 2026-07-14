import type { Block, BlockLifecycle, Region, RenderView, TemplateDefinition } from "./rendering.ts";
import { HydrationMismatchError, type HydrationSession } from "./ssr-session.ts";
import { runtimeEffect } from "./reactivity.ts";
import { cancelTransitions, runTransitions } from "./transitions.ts";

export interface HydrationClaim {
  readonly start?: Comment;
  readonly end?: Comment;
  cursor: Node | null;
}

export interface HeadHydrationClaim {
  readonly index: number;
  readonly start: Comment;
  readonly end: Comment;
  readonly claim: HydrationClaim;
  readonly signatures: readonly string[];
}

export interface HydratedFragment {
  readonly kind: "hydrated-fragment";
  readonly start: Comment;
  readonly end: Comment;
  readonly session: HydrationSession;
}

const hydratedRegions = new WeakSet<Comment>();

export function rootHydrationClaim(target: Element): HydrationClaim {
  return { cursor: target.firstChild };
}

export function headHydrationClaims(
  head: HTMLHeadElement,
  id: string,
  count: number,
): HeadHydrationClaim[] {
  const claims: HeadHydrationClaim[] = [];
  const startPattern = new RegExp(
    `^solix:head:start:${id.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)$`,
  );
  for (const node of head.childNodes) {
    if (node.nodeType !== Node.COMMENT_NODE) continue;
    const start = node as Comment;
    const match = startPattern.exec(start.data);
    if (!match) continue;
    const index = Number(match[1]);
    const endData = `solix:head:end:${id}:${index}`;
    let end: Comment | undefined;
    const signatures: string[] = [];
    for (let current = start.nextSibling; current; current = current.nextSibling) {
      if (current.nodeType !== Node.COMMENT_NODE) continue;
      const comment = current as Comment;
      const signature = /^solix:block:start:(t[a-z0-9]+)$/.exec(comment.data)?.[1];
      if (signature) signatures.push(signature);
      if (comment.data === endData) {
        end = comment;
        break;
      }
    }
    if (!end) mismatch(`missing server Head end marker ${index}`);
    claims.push({ index, start, end, claim: { cursor: start.nextSibling }, signatures });
  }
  const indexes = claims.map((claim) => claim.index).toSorted((left, right) => left - right);
  if (claims.length !== count || indexes.some((index, position) => index !== position)) {
    mismatch("server Head blocks differ");
  }
  return claims;
}

export function regionHydrationClaim(region: Region): HydrationClaim | undefined {
  if (!("end" in region) || !hydratedRegions.has(region.end)) return undefined;
  return { start: region.start, end: region.end, cursor: region.start.nextSibling };
}

export function isHydratedRegion(region: Region): region is { start: Comment; end: Comment } {
  return "end" in region && hydratedRegions.has(region.end);
}

export function isHydratedFragment(value: unknown): value is HydratedFragment {
  return (value as HydratedFragment | undefined)?.kind === "hydrated-fragment";
}

function mismatch(message: string): never {
  throw new HydrationMismatchError(message);
}

function isComment(node: Node | null, data: string): node is Comment {
  return node?.nodeType === Node.COMMENT_NODE && (node as Comment).data === data;
}

function matchingEnd(start: Comment, prefix: "solix:block" | "solix"): Comment {
  const startPattern =
    prefix === "solix:block" ? /^solix:block:start(?::t[a-z0-9]+)?$/ : /^solix:s:\d+$/;
  const expectedEnd =
    prefix === "solix:block" ? "solix:block:end" : start.data.replace("solix:s:", "solix:e:");
  const endPattern = prefix === "solix:block" ? /^solix:block:end$/ : /^solix:e:\d+$/;
  let depth = 0;
  for (let node = start.nextSibling; node; node = node.nextSibling) {
    if (node.nodeType !== Node.COMMENT_NODE) continue;
    const data = (node as Comment).data;
    if (startPattern.test(data)) {
      depth += 1;
    } else if (endPattern.test(data)) {
      if (depth === 0) {
        if (data !== expectedEnd) mismatch(`expected <!--${expectedEnd}-->`);
        return node as Comment;
      }
      depth -= 1;
    }
  }
  return mismatch(`missing end marker for ${start.data}`);
}

export function hydratedValueBlock(
  claim: HydrationClaim,
  session: HydrationSession,
  getValue: () => string,
): Block {
  const start = claim.cursor;
  if (!isComment(start, "solix:block:start")) mismatch("expected primitive block start marker");
  const end = matchingEnd(start, "solix:block");
  claim.cursor = end.nextSibling;
  let textNode: Text | undefined;
  const between: Node[] = [];
  for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
    between.push(node);
  }
  const initial = getValue();
  if (initial === "") {
    if (between.length > 0) mismatch("empty primitive block contains server nodes");
  } else {
    if (between.length !== 1 || between[0]!.nodeType !== Node.TEXT_NODE) {
      mismatch("primitive block text differs");
    }
    textNode = between[0] as Text;
    if (textNode.data !== initial) mismatch("primitive block text differs");
  }
  let hydrating = true;
  const stop = runtimeEffect(() => {
    const value = getValue();
    if (hydrating) {
      hydrating = false;
      return;
    }
    if (value === "") {
      textNode?.remove();
      textNode = undefined;
    } else if (textNode) {
      textNode.data = value;
    } else {
      textNode = document.createTextNode(value);
      end.parentNode?.insertBefore(textNode, end);
    }
  });
  return hydratedBlock({ kind: "hydrated-fragment", start, end, session }, [stop]);
}

function matchChildren(
  expectedParent: Node,
  actualStart: Node | null,
  actualEnd: Node | null,
  elements: Element[],
  regions: { start: Comment; end: Comment }[],
  boundElements: ReadonlySet<number>,
): void {
  let actual = actualStart;
  const expected = Array.from(expectedParent.childNodes);
  for (let index = 0; index < expected.length; index += 1) {
    const expectedNode = expected[index]!;
    if (
      expectedNode.nodeType === Node.COMMENT_NODE &&
      /^solix:s:\d+$/.test((expectedNode as Comment).data)
    ) {
      const data = (expectedNode as Comment).data;
      if (!isComment(actual, data)) mismatch(`expected <!--${data}-->`);
      const regionIndex = Number(data.slice("solix:s:".length));
      const end = matchingEnd(actual, "solix");
      const expectedEnd = expected[++index];
      if (
        !expectedEnd ||
        expectedEnd.nodeType !== Node.COMMENT_NODE ||
        (expectedEnd as Comment).data !== `solix:e:${regionIndex}`
      ) {
        mismatch(`invalid compiled region ${regionIndex}`);
      }
      regions[regionIndex] = { start: actual, end };
      hydratedRegions.add(end);
      actual = end.nextSibling;
      continue;
    }
    if (!actual || actual === actualEnd) mismatch(`missing ${expectedNode.nodeName}`);
    if (expectedNode.nodeType !== actual.nodeType) mismatch(`expected ${expectedNode.nodeName}`);
    if (expectedNode.nodeType === Node.TEXT_NODE) {
      if (expectedNode.nodeValue !== actual.nodeValue) mismatch("static text differs");
    } else if (expectedNode.nodeType === Node.COMMENT_NODE) {
      if ((expectedNode as Comment).data !== (actual as Comment).data) mismatch("comment differs");
    } else if (expectedNode.nodeType === Node.ELEMENT_NODE) {
      const expectedElement = expectedNode as Element;
      const actualElement = actual as Element;
      if (expectedElement.tagName !== actualElement.tagName) {
        mismatch(`expected <${expectedElement.tagName.toLowerCase()}>`);
      }
      for (const attribute of expectedElement.attributes) {
        if (attribute.name === "data-solix-e") continue;
        if (actualElement.getAttribute(attribute.name) !== attribute.value) {
          mismatch(`static attribute ${attribute.name} differs`);
        }
      }
      const elementIndex = expectedElement.getAttribute("data-solix-e");
      if (elementIndex !== null) {
        const parsed = Number(elementIndex);
        if (!Number.isInteger(parsed)) mismatch("invalid element marker");
        if (actualElement.getAttribute("data-solix-e") !== elementIndex) {
          mismatch(`expected element marker ${elementIndex}`);
        }
        elements[parsed] = actualElement;
      } else if (actualElement.hasAttribute("data-solix-e")) {
        mismatch("unexpected element marker");
      }
      if (
        !(
          elementIndex !== null &&
          boundElements.has(Number(elementIndex)) &&
          ["SCRIPT", "STYLE", "TEXTAREA", "TITLE"].includes(actualElement.tagName)
        )
      ) {
        matchChildren(
          expectedElement,
          actualElement.firstChild,
          null,
          elements,
          regions,
          boundElements,
        );
      }
    }
    actual = actual.nextSibling;
  }
  if (actual !== actualEnd) mismatch("unexpected server nodes");
}

export function instantiateHydrated(
  definition: TemplateDefinition,
  session: HydrationSession,
  claim: HydrationClaim,
): RenderView {
  session.claimTemplate(definition.signature);
  const start = claim.cursor;
  if (!isComment(start, `solix:block:start:${definition.signature}`)) {
    mismatch(
      `expected block signature ${definition.signature}, received ${
        start?.nodeType === Node.COMMENT_NODE ? (start as Comment).data : (start?.nodeName ?? "end")
      }`,
    );
  }
  const end = matchingEnd(start, "solix:block");
  definition.element ??= document.createElement("template");
  if (!definition.element.innerHTML) definition.element.innerHTML = definition.html;
  const elements: Element[] = [];
  const regions: { start: Comment; end: Comment }[] = [];
  const propertyValueElements = new Set(
    definition.metadata.operations
      .filter(
        (operation) =>
          operation.target === "element" &&
          operation.name === "value" &&
          (operation.kind === "bind" || operation.kind === "attribute"),
      )
      .map((operation) => operation.index)
      .filter((index): index is number => index !== undefined),
  );
  for (const operation of definition.metadata.operations) {
    if (operation.kind === "raw_text" && operation.index !== undefined) {
      propertyValueElements.add(operation.index);
    }
  }
  matchChildren(
    definition.element.content,
    start.nextSibling,
    end,
    elements,
    regions,
    propertyValueElements,
  );
  claim.cursor = end.nextSibling;
  return { fragment: { kind: "hydrated-fragment", start, end, session }, elements, regions };
}

export function hydratedBlock(
  fragment: HydratedFragment,
  cleanups: (() => void)[],
  lifecycle?: BlockLifecycle,
): Block {
  let disposed = false;
  let lifecycleQueued = false;
  let mounted = true;
  let claimedPlacement = true;
  let cleaned = false;
  const nodes = (): Node[] => {
    const result: Node[] = [];
    for (let node: Node | null = fragment.start; node; node = node.nextSibling) {
      result.push(node);
      if (node === fragment.end) break;
    }
    return result;
  };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const registered of cleanups.toReversed()) registered();
  };
  const remove = (): void => {
    for (const node of nodes()) node.parentNode?.removeChild(node);
  };
  const leave = (): Promise<void> | undefined => {
    if (!fragment.session.committed) return undefined;
    const transitions = [
      runTransitions(nodes(), "leave"),
      ...(lifecycle?.remoteBlocks.map((remote) => remote.leave()) ?? []),
    ].filter((candidate): candidate is Promise<void> => candidate !== undefined);
    return transitions.length > 0 ? Promise.all(transitions).then(() => undefined) : undefined;
  };
  const move = (parent: Node, before: Node | null = null): void => {
    if (claimedPlacement) {
      claimedPlacement = false;
      if (mounted && fragment.start.parentNode === parent) return;
    }
    const moving = document.createDocumentFragment();
    for (const node of nodes()) moving.append(node);
    parent.insertBefore(moving, before);
    mounted = true;
  };
  return {
    get nodes() {
      return nodes();
    },
    mount(parent, before) {
      if (!(parent instanceof Node)) mismatch("cannot mount a hydrated block on the server");
      move(parent, before);
      if (lifecycleQueued) return;
      lifecycleQueued = true;
      if (lifecycle) {
        lifecycle.coordinator.refMounts.push(
          ...lifecycle.refMounts.map((attach) => () => {
            if (!disposed) attach();
          }),
        );
        lifecycle.coordinator.portalMounts.push(
          ...lifecycle.portalMounts.map((attach) => () => {
            if (!disposed) attach();
          }),
        );
      }
    },
    move(parent, before) {
      if (!(parent instanceof Node)) mismatch("cannot move a hydrated block on the server");
      move(parent, before);
    },
    enter() {
      if (!fragment.session.committed || disposed) return;
      void runTransitions(nodes(), "enter");
      for (const remote of lifecycle?.remoteBlocks ?? []) remote.enter();
    },
    leave,
    retire() {
      if (disposed) return undefined;
      cleanup();
      const leaving = leave();
      if (!leaving) {
        disposed = true;
        for (const remote of lifecycle?.remoteBlocks ?? []) remote.dispose();
        remove();
        return undefined;
      }
      return leaving.then(() => {
        if (disposed) return;
        disposed = true;
        for (const remote of lifecycle?.remoteBlocks ?? []) remote.dispose();
        remove();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTransitions(nodes());
      cleanup();
      for (const remote of lifecycle?.remoteBlocks ?? []) remote.dispose();
      if (fragment.session.committed) remove();
    },
  };
}

export function claimHydratedText(region: Region): Text | undefined {
  if (!isHydratedRegion(region)) return undefined;
  const nodes: Node[] = [];
  for (let node = region.start.nextSibling; node && node !== region.end; node = node.nextSibling) {
    nodes.push(node);
  }
  if (nodes.length === 0) return undefined;
  if (nodes.length !== 1 || nodes[0]!.nodeType !== Node.TEXT_NODE) {
    return mismatch("dynamic text region differs");
  }
  return nodes[0] as Text;
}
