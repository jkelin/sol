export interface Transition {
  readonly enter?: string;
  readonly leave?: string;
}

type TransitionPhase = keyof Transition;
type TransitionGetter = () => Transition;

const transitionGetters = new WeakMap<Element, TransitionGetter>();
const runningTransitions = new WeakMap<
  Element,
  { animations: readonly Animation[]; classes: readonly string[] }
>();

export function transition(element: Element, getTransition: TransitionGetter): void {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    throw new TypeError("$transition expects a DOM Element");
  }
  if (typeof getTransition !== "function") {
    throw new TypeError("$transition expects a transition getter");
  }
  transitionGetters.set(element, getTransition);
}

function transitionClasses(value: unknown, phase: TransitionPhase): string[] | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.isExtensible(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  ) {
    throw new TypeError("$transition expects an object with enter and/or leave class names");
  }
  const className = (value as Record<TransitionPhase, unknown>)[phase];
  if (className === undefined) return undefined;
  if (typeof className !== "string" || className.trim() === "") {
    throw new TypeError(`$transition ${phase} must be a non-empty class name string`);
  }
  return className.trim().split(/\s+/);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function transitionedElements(nodes: readonly Node[]): Element[] {
  const elements: Element[] = [];
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    if (transitionGetters.has(node)) elements.push(node);
    for (const descendant of node.querySelectorAll("*")) {
      if (transitionGetters.has(descendant)) elements.push(descendant);
    }
  }
  return elements;
}

export function cancelTransitions(nodes: readonly Node[]): void {
  for (const element of transitionedElements(nodes)) {
    const running = runningTransitions.get(element);
    if (!running) continue;
    runningTransitions.delete(element);
    for (const animation of running.animations) animation.cancel();
    element.classList.remove(...running.classes);
  }
}

export function runTransitions(
  nodes: readonly Node[],
  phase: TransitionPhase,
): Promise<void> | undefined {
  const configured: Array<{ element: Element; classes: string[] }> = [];
  for (const element of transitionedElements(nodes)) {
    const getter = transitionGetters.get(element)!;
    const classes = transitionClasses(getter(), phase);
    if (classes) configured.push({ element, classes });
  }
  cancelTransitions(nodes);
  if (configured.length === 0 || prefersReducedMotion()) return undefined;

  const finished: Promise<unknown>[] = [];
  for (const { element, classes } of configured) {
    if (typeof element.getAnimations !== "function") continue;
    const existing = new Set(element.getAnimations());
    const addedClasses = classes.filter((className) => !element.classList.contains(className));
    element.classList.add(...classes);
    const animations = element.getAnimations().filter((animation) => !existing.has(animation));
    if (animations.length === 0) {
      element.classList.remove(...addedClasses);
      continue;
    }
    const running = { animations, classes: addedClasses };
    runningTransitions.set(element, running);
    finished.push(
      Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).finally(
        () => {
          if (runningTransitions.get(element) !== running) return;
          runningTransitions.delete(element);
          element.classList.remove(...addedClasses);
        },
      ),
    );
  }
  return finished.length > 0 ? Promise.all(finished).then(() => undefined) : undefined;
}
