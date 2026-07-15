export function isDomNode(value: unknown): value is Node {
  const ownerNode = (value as Node | null)?.ownerDocument?.defaultView?.Node;
  const ambientNode = typeof Node === "undefined" ? undefined : Node;
  const constructor = ownerNode ?? ambientNode;
  return Boolean(constructor && value instanceof constructor);
}

export function isDomElement(value: unknown): value is Element {
  const ownerElement = (value as Element | null)?.ownerDocument?.defaultView?.Element;
  const ambientElement = typeof Element === "undefined" ? undefined : Element;
  const constructor = ownerElement ?? ambientElement;
  return Boolean(constructor && value instanceof constructor);
}

export function isHtmlSelectElement(value: unknown): value is HTMLSelectElement {
  const ownerSelect = (value as Element | null)?.ownerDocument?.defaultView?.HTMLSelectElement;
  const ambientSelect = typeof HTMLSelectElement === "undefined" ? undefined : HTMLSelectElement;
  const constructor = ownerSelect ?? ambientSelect;
  return Boolean(constructor && value instanceof constructor);
}
