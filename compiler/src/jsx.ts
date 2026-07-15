import * as t from "@babel/types";
import {
  bindingRoot,
  elementId,
  expressionAttribute,
  expressionCode,
  getAttributeName,
  getKeyAttribute,
  jsxName,
  keyCode,
  normalizeJsxText,
  region,
  staticAttributeValue,
  type ReactiveKind,
} from "./codegen.ts";
import {
  nextAsyncSite,
  type CompilerContext,
  type Expression,
  type Scope,
  type TemplateContext,
} from "./context.ts";
import { codeFrame, mappedCode } from "./diagnostics.ts";
import { escapeAttribute, escapeText, VOID_ELEMENTS } from "./html.ts";

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

export function compileBinding(
  compiler: CompilerContext,
  expression: t.Expression,
  property: "value" | "checked",
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): { read: string; write: string } {
  if (t.isIdentifier(expression)) {
    const kind = bindings.get(expression.name);
    if (!kind)
      codeFrame(compiler, expression, "$bind identifiers must be compiler-managed component state");
    if (kind === "computed")
      codeFrame(compiler, expression, "$bind cannot target a computed value");
    const reference = expressionCode(expression, scope);
    return {
      read: reference,
      write: `${reference} = ${property === "checked" ? "Boolean(__sol_value)" : 'String(__sol_value ?? "")'}`,
    };
  }
  if (t.isMemberExpression(expression) && !expression.optional) {
    const root = bindingRoot(expression);
    const scopedRoot = root ? scope.get(root) : undefined;
    const isKeyedRowValue =
      scopedRoot !== undefined && /^__sol_(?:item|index)_\d+\.value$/.test(scopedRoot);
    if (
      !isKeyedRowValue &&
      root === compiler.propsName &&
      t.isIdentifier(expression.object, { name: root })
    ) {
      codeFrame(compiler, expression, "$bind cannot assign directly to a readonly component prop");
    }
    if (!isKeyedRowValue && root && bindings.get(root) === "computed") {
      codeFrame(compiler, expression, "$bind cannot target a computed value or one of its members");
    }
    const isNestedProp =
      !isKeyedRowValue && root === compiler.propsName && t.isMemberExpression(expression.object);
    if (!root || (!bindings.has(root) && !isNestedProp && !isKeyedRowValue)) {
      codeFrame(
        compiler,
        expression,
        "$bind member expressions must be rooted in component state, nested props, or keyed-list row state",
      );
    }
    const target = expressionCode(expression, scope);
    return {
      read: target,
      write: `${target} = ${property === "checked" ? "Boolean(__sol_value)" : 'String(__sol_value ?? "")'}`,
    };
  }
  return codeFrame(
    compiler,
    expression,
    "$bind requires writable component state or an assignable member expression",
  );
}

export function meaningfulChildren(node: t.JSXElement): t.JSXElement["children"] {
  return node.children.filter(
    (child) => !t.isJSXText(child) || normalizeJsxText(child.value) !== "",
  );
}

export function namedAttribute(
  compiler: CompilerContext,
  node: t.JSXElement,
  name: string,
  required = false,
): t.JSXAttribute | undefined {
  const matches = node.openingElement.attributes.filter(
    (attribute): attribute is t.JSXAttribute =>
      t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name, { name }),
  );
  if (matches.length > 1)
    codeFrame(compiler, matches[1]!, `JSX property ${name} may only appear once`);
  if (required && !matches[0]) codeFrame(compiler, node, `JSX property ${name} is required`);
  return matches[0];
}

export function jsxAttributeExpression(
  compiler: CompilerContext,
  attribute: t.JSXAttribute,
): Expression {
  if (
    !t.isJSXExpressionContainer(attribute.value) ||
    (!t.isExpression(attribute.value.expression) &&
      !t.isJSXElement(attribute.value.expression) &&
      !t.isJSXFragment(attribute.value.expression))
  ) {
    codeFrame(compiler, attribute, "This JSX property requires an expression");
  }
  return attribute.value.expression;
}

export function childrenRoot(node: t.JSXElement): t.JSXFragment {
  return t.jsxFragment(t.jsxOpeningFragment(), t.jsxClosingFragment(), node.children);
}

export function blockFactory(
  compiler: CompilerContext,
  root: t.JSXElement | t.JSXFragment,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): string {
  return `(__sol_frame) => { ${compileBlockBody(compiler, root, bindings, scope)} }`;
}

export function jsxFactoryFromAttribute(
  compiler: CompilerContext,
  attribute: t.JSXAttribute,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): string {
  const expression = jsxAttributeExpression(compiler, attribute);
  if (!t.isJSXElement(expression) && !t.isJSXFragment(expression)) {
    codeFrame(
      compiler,
      expression,
      `JSX property ${getAttributeName(compiler, attribute.name)} must contain JSX`,
    );
  }
  return blockFactory(compiler, expression, bindings, scope);
}

export function renderFunctionFactory(
  compiler: CompilerContext,
  expression: Expression,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
  valueName: string,
): string {
  if (!t.isArrowFunctionExpression(expression) && !t.isFunctionExpression(expression)) {
    codeFrame(compiler, expression, "Error and data renderers must be inline functions");
  }
  if (expression.params.length !== 1 || !t.isIdentifier(expression.params[0])) {
    codeFrame(
      compiler,
      expression,
      "Error and data renderers require exactly one identifier parameter",
    );
  }
  let body: t.Node = expression.body;
  if (t.isBlockStatement(body)) {
    const returns = body.body.filter((statement): statement is t.ReturnStatement =>
      t.isReturnStatement(statement),
    );
    if (returns.length !== 1 || returns[0] !== body.body.at(-1) || !returns[0]!.argument) {
      codeFrame(compiler, body, "Error and data renderers require exactly one final JSX return");
    }
    if (body.body.length !== 1) {
      codeFrame(compiler, body, "Error and data renderer setup statements are not supported");
    }
    body = returns[0]!.argument;
  }
  if (!t.isJSXElement(body) && !t.isJSXFragment(body)) {
    codeFrame(compiler, body, "Error and data renderers must return JSX");
  }
  const renderScope = new Map(scope);
  renderScope.set(expression.params[0].name, valueName);
  return blockFactory(compiler, body, bindings, renderScope);
}

export function optionalErrorFactory(
  compiler: CompilerContext,
  node: t.JSXElement,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): string {
  const attribute = namedAttribute(compiler, node, "error");
  if (!attribute) return "undefined";
  return `(__sol_error, __sol_frame) => (${renderFunctionFactory(compiler, jsxAttributeExpression(compiler, attribute), bindings, scope, "__sol_error")})(__sol_frame)`;
}

export function validateBuiltinAttributes(
  compiler: CompilerContext,
  node: t.JSXElement,
  allowed: ReadonlySet<string>,
): void {
  for (const attribute of node.openingElement.attributes) {
    if (t.isJSXSpreadAttribute(attribute))
      codeFrame(compiler, attribute, "JSX spread attributes are not supported in v1");
    const name = getAttributeName(compiler, attribute.name);
    if (!allowed.has(name)) codeFrame(compiler, attribute, `Unexpected ${name} property`);
  }
}

export function isDefinitelyPrimitive(expression: Expression): boolean {
  return (
    t.isNullLiteral(expression) ||
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isBigIntLiteral(expression) ||
    t.isDecimalLiteral(expression) ||
    t.isTemplateLiteral(expression) ||
    t.isUnaryExpression(expression)
  );
}

export function compileBuiltinElement(
  compiler: CompilerContext,
  kind: "Suspense" | "Await" | "ErrorBoundary" | "Portal" | "GlobalPortal" | "Head",
  node: t.JSXElement,
  context: TemplateContext,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): void {
  if (kind === "Head") {
    validateBuiltinAttributes(compiler, node, new Set());
    const children = meaningfulChildren(node).filter(
      (child) => !t.isJSXExpressionContainer(child) || !t.isJSXEmptyExpression(child.expression),
    );
    if (children.length === 0) return;
    context.operations.push(
      mappedCode(
        compiler,
        node,
        `__sol_head(${blockFactory(compiler, childrenRoot(node), bindings, scope)}, __sol_cleanups, __sol_frame);`,
      ),
    );
    return;
  }
  const index = region(context);
  if (kind === "Portal" || kind === "GlobalPortal") {
    const allowed = kind === "Portal" ? new Set(["target", "key"]) : new Set(["key"]);
    validateBuiltinAttributes(compiler, node, allowed);
    const render = blockFactory(compiler, childrenRoot(node), bindings, scope);
    if (kind === "GlobalPortal") {
      context.operations.push(
        mappedCode(
          compiler,
          node,
          `__sol_global_portal(${render}, __sol_cleanups, __sol_lifecycle, __sol_frame);`,
        ),
      );
      return;
    }
    const target = jsxAttributeExpression(
      compiler,
      namedAttribute(compiler, node, "target", true)!,
    );
    if (t.isJSXElement(target) || t.isJSXFragment(target) || isDefinitelyPrimitive(target)) {
      codeFrame(compiler, target, "Portal target must be a DOM Element expression");
    }
    context.operations.push(
      mappedCode(
        compiler,
        node,
        `__sol_portal(() => (${expressionCode(target, scope)}), ${render}, __sol_cleanups, __sol_lifecycle, __sol_frame);`,
      ),
    );
    return;
  }
  if (kind === "Suspense") {
    validateBuiltinAttributes(compiler, node, new Set(["fallback", "error", "timeoutMs"]));
    const fallback = jsxFactoryFromAttribute(
      compiler,
      namedAttribute(compiler, node, "fallback", true)!,
      bindings,
      scope,
    );
    context.operations.push(
      mappedCode(
        compiler,
        node,
        `__sol_suspense(__sol_view.regions[${index}], ${blockFactory(compiler, childrenRoot(node), bindings, scope)}, ${fallback}, ${optionalErrorFactory(compiler, node, bindings, scope)}, __sol_cleanups, __sol_frame, ${suspenseTimeoutCode(compiler, node, scope)});`,
      ),
    );
    return;
  }
  if (kind === "ErrorBoundary") {
    validateBuiltinAttributes(compiler, node, new Set(["fallback"]));
    const fallbackAttribute = namedAttribute(compiler, node, "fallback", true)!;
    const fallback = renderFunctionFactory(
      compiler,
      jsxAttributeExpression(compiler, fallbackAttribute),
      bindings,
      scope,
      "__sol_error",
    );
    context.operations.push(
      mappedCode(
        compiler,
        node,
        `__sol_error_boundary(__sol_view.regions[${index}], ${blockFactory(compiler, childrenRoot(node), bindings, scope)}, (__sol_error, __sol_frame) => (${fallback})(__sol_frame), __sol_cleanups, __sol_frame);`,
      ),
    );
    return;
  }

  validateBuiltinAttributes(compiler, node, new Set(["$promise", "error"]));
  const promise = jsxAttributeExpression(
    compiler,
    namedAttribute(compiler, node, "$promise", true)!,
  );
  if (
    t.isJSXElement(promise) ||
    t.isJSXFragment(promise) ||
    t.isRegExpLiteral(promise) ||
    isDefinitelyPrimitive(promise)
  ) {
    codeFrame(compiler, promise, "Await $promise must be a promise expression");
  }
  const children = meaningfulChildren(node);
  if (
    children.length !== 1 ||
    !t.isJSXExpressionContainer(children[0]) ||
    (!t.isArrowFunctionExpression(children[0].expression) &&
      !t.isFunctionExpression(children[0].expression))
  ) {
    codeFrame(compiler, node, "Await requires exactly one inline data-renderer child");
  }
  const renderer = renderFunctionFactory(
    compiler,
    children[0].expression,
    bindings,
    scope,
    "__sol_value",
  );
  context.operations.push(
    mappedCode(
      compiler,
      node,
      `__sol_await(__sol_view.regions[${index}], () => (${expressionCode(promise, scope)}), (__sol_value, __sol_frame) => (${renderer})(__sol_frame), ${optionalErrorFactory(compiler, node, bindings, scope)}, __sol_cleanups, __sol_frame, ${JSON.stringify(nextAsyncSite(compiler))});`,
    ),
  );
}

function containsJsx(node: t.Node): boolean {
  let found = false;
  t.traverseFast(node, (child) => {
    if (t.isJSXElement(child) || t.isJSXFragment(child)) found = true;
  });
  return found;
}

function rawTextValues(
  compiler: CompilerContext,
  node: t.JSXElement,
  tag: string,
  scope: Scope,
): string[] {
  const values: string[] = [];
  for (const child of node.children) {
    if (t.isJSXText(child)) {
      const value =
        tag === "script" || tag === "style" ? child.value : normalizeJsxText(child.value);
      if (value) values.push(JSON.stringify(value));
      continue;
    }
    if (t.isJSXSpreadChild(child)) {
      codeFrame(compiler, child, "JSX spread children are not supported in v1");
    }
    if (t.isJSXExpressionContainer(child)) {
      if (t.isJSXEmptyExpression(child.expression)) continue;
      if (!t.isExpression(child.expression) || containsJsx(child.expression)) {
        codeFrame(compiler, child, "Raw-text element children must be text or expressions");
      }
      values.push(expressionCode(child.expression, scope));
      continue;
    }
    codeFrame(compiler, child, "Raw-text element children must be text or expressions");
  }
  return values;
}

export function compileProviderElement(
  compiler: CompilerContext,
  node: t.JSXElement,
  context: TemplateContext,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): boolean {
  const name = node.openingElement.name;
  if (
    !t.isJSXMemberExpression(name) ||
    !t.isJSXIdentifier(name.object) ||
    !t.isJSXIdentifier(name.property, { name: "Provider" })
  )
    return false;
  validateBuiltinAttributes(compiler, node, new Set(["data"]));
  const data = jsxAttributeExpression(compiler, namedAttribute(compiler, node, "data", true)!);
  if (
    t.isJSXElement(data) ||
    t.isJSXFragment(data) ||
    isDefinitelyPrimitive(data) ||
    t.isArrayExpression(data) ||
    t.isFunctionExpression(data) ||
    t.isArrowFunctionExpression(data) ||
    t.isClassExpression(data)
  )
    codeFrame(compiler, data, "Context Provider data must be an object expression");
  const contextName = expressionCode(t.identifier(name.object.name), scope);
  const index = region(context);
  context.operations.push(
    mappedCode(
      compiler,
      node,
      `__sol_context_provider(__sol_view.regions[${index}], ${contextName}, () => (${expressionCode(data, scope)}), ${blockFactory(compiler, childrenRoot(node), bindings, scope)}, __sol_cleanups, __sol_frame);`,
    ),
  );
  return true;
}

export function compileComponentElement(
  compiler: CompilerContext,
  node: t.JSXElement,
  context: TemplateContext,
  scope: Scope,
): void {
  const componentName = jsxName(compiler, node.openingElement.name);
  const meaningfulComponentChildren = node.children.filter((child) => {
    return !t.isJSXText(child) || normalizeJsxText(child.value) !== "";
  });
  if (meaningfulComponentChildren.length > 0) {
    codeFrame(
      compiler,
      node,
      "Component children are not supported in v1; pass an explicit prop instead",
    );
  }
  const props: string[] = [];
  for (const attribute of node.openingElement.attributes) {
    if (t.isJSXSpreadAttribute(attribute))
      codeFrame(compiler, attribute, "JSX spread attributes are not supported in v1");
    const name = getAttributeName(compiler, attribute.name);
    if (name === "key") continue;
    if (name === "$bind")
      codeFrame(compiler, attribute, "$bind is only valid on intrinsic form elements");
    if (name === "$transition")
      codeFrame(compiler, attribute, "$transition is only valid on intrinsic elements");
    if (name === "ref") codeFrame(compiler, attribute, "ref is only valid on intrinsic elements");
    const value = staticAttributeValue(compiler, attribute);
    const getter =
      value !== undefined
        ? `() => ${JSON.stringify(value)}`
        : `() => (${expressionCode(expressionAttribute(compiler, attribute), scope)})`;
    props.push(`${JSON.stringify(name)}: ${getter}`);
  }
  const index = region(context);
  context.operations.push(
    mappedCode(
      compiler,
      node,
      `__sol_child(__sol_view.regions[${index}], ${componentName}, { ${props.join(", ")} }, __sol_cleanups, __sol_frame);`,
    ),
  );
}

export function compileIntrinsicElement(
  compiler: CompilerContext,
  node: t.JSXElement,
  context: TemplateContext,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
  injectedOperations: ReadonlyArray<(element: number) => string> = [],
): void {
  const tag = jsxName(compiler, node.openingElement.name);
  if (!/^[a-z][a-z0-9-]*$/.test(tag))
    codeFrame(compiler, node, "Dynamic JSX tags are not supported in v1");
  const attributes: string[] = [];
  const deferredOperations: ((element: number) => string)[] = [];
  const inputTypeAttribute = node.openingElement.attributes.find(
    (attribute) =>
      t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name, { name: "type" }),
  );
  const inputType =
    inputTypeAttribute && t.isJSXAttribute(inputTypeAttribute)
      ? staticAttributeValue(compiler, inputTypeAttribute)
      : undefined;
  const classAttributes = node.openingElement.attributes.filter(
    (attribute) =>
      t.isJSXAttribute(attribute) &&
      t.isJSXIdentifier(attribute.name) &&
      ["class", "className", "classNames"].includes(attribute.name.name),
  );
  if (classAttributes.length > 1) {
    codeFrame(
      compiler,
      classAttributes[1]!,
      "Use only one of class, className, or classNames on an element",
    );
  }
  const formAttribute = node.openingElement.attributes.find(
    (attribute) =>
      t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name, { name: "$form" }),
  );
  if (formAttribute) {
    if (tag !== "form") codeFrame(compiler, formAttribute, "$form is only valid on form elements");
    const conflictingHandler = node.openingElement.attributes.find(
      (attribute) =>
        t.isJSXAttribute(attribute) &&
        t.isJSXIdentifier(attribute.name) &&
        ["onSubmit", "onInput"].includes(attribute.name.name),
    );
    if (
      conflictingHandler &&
      t.isJSXAttribute(conflictingHandler) &&
      t.isJSXIdentifier(conflictingHandler.name)
    ) {
      codeFrame(
        compiler,
        conflictingHandler,
        `$form already handles ${conflictingHandler.name.name}`,
      );
    }
  }

  for (const attribute of node.openingElement.attributes) {
    if (t.isJSXSpreadAttribute(attribute))
      codeFrame(compiler, attribute, "JSX spread attributes are not supported in v1");
    const sourceName = getAttributeName(compiler, attribute.name);
    if (sourceName === "key") continue;
    if (sourceName === "data-sol-e") {
      codeFrame(compiler, attribute, "data-sol-e is reserved for hydration metadata");
    }
    if (sourceName === "$form") {
      const controller = expressionCode(expressionAttribute(compiler, attribute), scope);
      deferredOperations.push(
        (element) =>
          `__sol_event(__sol_view.elements[${element}], "submit", () => ((${controller}).submit), __sol_cleanups);`,
        (element) =>
          `__sol_event(__sol_view.elements[${element}], "input", () => ((${controller}).handleInput), __sol_cleanups);`,
        (element) =>
          `__sol_event(__sol_view.elements[${element}], "focusout", () => ((${controller}).handleBlur), __sol_cleanups);`,
      );
      continue;
    }
    if (sourceName === "$bind") {
      if (!["input", "textarea", "select"].includes(tag)) {
        codeFrame(
          compiler,
          attribute,
          "$bind is only valid on input, textarea, and select elements",
        );
      }
      if (tag === "input" && inputTypeAttribute && inputType === undefined) {
        codeFrame(compiler, inputTypeAttribute, "$bind requires a static input type");
      }
      const property: "value" | "checked" =
        tag === "input" && (inputType === "checkbox" || inputType === "radio")
          ? "checked"
          : "value";
      const binding = compileBinding(
        compiler,
        expressionAttribute(compiler, attribute),
        property,
        bindings,
        scope,
      );
      deferredOperations.push((element) =>
        mappedCode(
          compiler,
          attribute,
          `__sol_bind(__sol_view.elements[${element}], ${JSON.stringify(property)}, () => (${binding.read}), (__sol_value: unknown) => { ${binding.write}; }, __sol_cleanups);`,
        ),
      );
      continue;
    }
    if (sourceName === "$transition") {
      const value = expressionCode(expressionAttribute(compiler, attribute), scope);
      deferredOperations.push((element) =>
        mappedCode(
          compiler,
          attribute,
          `__sol_transition(__sol_view.elements[${element}], () => (${value}));`,
        ),
      );
      continue;
    }
    if (sourceName === "ref") {
      const value = expressionCode(expressionAttribute(compiler, attribute), scope);
      deferredOperations.push((element) =>
        mappedCode(
          compiler,
          attribute,
          `__sol_ref(__sol_view.elements[${element}], () => (${value}), __sol_cleanups, __sol_lifecycle);`,
        ),
      );
      continue;
    }

    if (/^on/i.test(sourceName) && !/^on[A-Z][A-Za-z0-9]*$/.test(sourceName)) {
      codeFrame(
        compiler,
        attribute,
        `Event attribute ${sourceName} must use React-style onEvent capitalization`,
      );
    }

    if (/^on[A-Z]/.test(sourceName)) {
      const normalizedEventName = sourceName.slice(2).toLowerCase();
      const eventName = normalizedEventName === "doubleclick" ? "dblclick" : normalizedEventName;
      const handler = expressionCode(expressionAttribute(compiler, attribute), scope);
      deferredOperations.push((element) =>
        mappedCode(
          compiler,
          attribute,
          `__sol_event(__sol_view.elements[${element}], ${JSON.stringify(eventName)}, () => (${handler}), __sol_cleanups);`,
        ),
      );
      continue;
    }

    const isClass =
      sourceName === "class" || sourceName === "className" || sourceName === "classNames";
    const name = isClass ? "class" : sourceName === "htmlFor" ? "for" : sourceName;
    const staticValue = staticAttributeValue(compiler, attribute);
    const stringBoolean = name.startsWith("aria-") || name.startsWith("data-");
    if (typeof staticValue === "boolean" && stringBoolean) {
      attributes.push(`${name}="${String(staticValue)}"`);
    } else if (staticValue === true) attributes.push(name);
    else if (typeof staticValue === "string")
      attributes.push(`${name}="${escapeAttribute(staticValue)}"`);
    else if (staticValue === false) continue;
    else {
      const value = expressionCode(expressionAttribute(compiler, attribute), scope);
      deferredOperations.push((element) =>
        mappedCode(
          compiler,
          attribute,
          `__sol_attribute(__sol_view.elements[${element}], ${JSON.stringify(name)}, () => (${value}), __sol_cleanups);`,
        ),
      );
    }
  }

  if (RAW_TEXT_ELEMENTS.has(tag)) {
    const values = rawTextValues(compiler, node, tag, scope);
    if (values.length > 0) {
      deferredOperations.push(
        (element) =>
          `__sol_raw_text(__sol_view.elements[${element}], () => [${values.join(", ")}], __sol_cleanups);`,
      );
    }
  }

  deferredOperations.push(...injectedOperations);
  if (deferredOperations.length > 0) {
    const index = elementId(context, node.openingElement);
    context.elementTags[index] = tag;
    attributes.push(`data-sol-e="${index}"`);
    context.operations.push(...deferredOperations.map((operation) => operation(index)));
  }
  context.html.push(`<${tag}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>`);
  if (!VOID_ELEMENTS.has(tag)) {
    if (!RAW_TEXT_ELEMENTS.has(tag)) {
      for (const child of node.children) compileNode(compiler, child, context, bindings, scope);
    }
    context.html.push(`</${tag}>`);
  } else if (node.children.length > 0) {
    codeFrame(compiler, node, `Void element <${tag}> cannot have children`);
  }
}

export function compileLinkElement(
  compiler: CompilerContext,
  node: t.JSXElement,
  context: TemplateContext,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): void {
  const children = node.children.filter(
    (child) => !t.isJSXText(child) || normalizeJsxText(child.value) !== "",
  );
  if (children.length !== 1 || !t.isJSXElement(children[0])) {
    codeFrame(compiler, node, "Link requires exactly one anchor child");
  }
  const anchor = children[0];
  if (!t.isJSXIdentifier(anchor.openingElement.name, { name: "a" })) {
    codeFrame(compiler, anchor, "Link child must be an intrinsic anchor element");
  }
  const anchorHref = anchor.openingElement.attributes.find(
    (attribute) =>
      t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name, { name: "href" }),
  );
  if (anchorHref) codeFrame(compiler, anchorHref, "Link provides its anchor href");

  const attributes = new Map<string, t.JSXAttribute>();
  for (const attribute of node.openingElement.attributes) {
    if (t.isJSXSpreadAttribute(attribute)) {
      codeFrame(compiler, attribute, "JSX spread attributes are not supported in v1");
    }
    const name = getAttributeName(compiler, attribute.name);
    if (!["route", "params", "replace"].includes(name)) {
      codeFrame(compiler, attribute, `Unsupported Link property ${name}`);
    }
    if (attributes.has(name)) codeFrame(compiler, attribute, `Duplicate Link property ${name}`);
    attributes.set(name, attribute);
  }
  const routeAttribute = attributes.get("route");
  if (!routeAttribute) codeFrame(compiler, node.openingElement, "Link requires a route property");
  const route = expressionCode(expressionAttribute(compiler, routeAttribute), scope);
  const destinationProperties = ["params"].flatMap((name) => {
    const attribute = attributes.get(name);
    if (!attribute) return [];
    const value = expressionCode(expressionAttribute(compiler, attribute), scope);
    return [`${JSON.stringify(name)}: (${value})`];
  });
  const replaceAttribute = attributes.get("replace");
  const replace = replaceAttribute
    ? staticAttributeValue(compiler, replaceAttribute) === true
      ? "true"
      : expressionCode(expressionAttribute(compiler, replaceAttribute), scope)
    : "false";
  compileIntrinsicElement(compiler, anchor, context, bindings, scope, [
    (element) =>
      `__sol_link(__sol_view.elements[${element}], () => (${route}), () => ({ ${destinationProperties.join(", ")} }), () => Boolean(${replace}), __sol_cleanups);`,
  ]);
}

export function mapDetails(
  compiler: CompilerContext,
  expression: t.Expression,
):
  | {
      collection: t.Expression;
      itemName: string;
      indexName?: string;
      body: t.JSXElement | t.JSXFragment;
    }
  | undefined {
  if (
    !t.isCallExpression(expression) ||
    !t.isMemberExpression(expression.callee) ||
    expression.callee.computed ||
    !t.isIdentifier(expression.callee.property, { name: "map" }) ||
    !t.isExpression(expression.callee.object)
  )
    return undefined;
  const callback = expression.arguments[0];
  if (!t.isArrowFunctionExpression(callback) && !t.isFunctionExpression(callback)) {
    codeFrame(compiler, expression, "JSX .map() requires an inline function");
  }
  const [itemParameter, indexParameter] = callback.params;
  if (!t.isIdentifier(itemParameter) || (indexParameter && !t.isIdentifier(indexParameter))) {
    codeFrame(compiler, callback, "JSX .map() parameters must be identifiers");
  }
  let body: t.Node | null = callback.body;
  if (t.isBlockStatement(body)) {
    const directReturns = body.body.filter((statement): statement is t.ReturnStatement =>
      t.isReturnStatement(statement),
    );
    if (
      directReturns.length !== 1 ||
      directReturns[0] !== body.body.at(-1) ||
      !directReturns[0]!.argument
    ) {
      codeFrame(compiler, body, "JSX .map() callbacks require exactly one final return");
    }
    if (body.body.length > 1) {
      codeFrame(
        compiler,
        body.body[0]!,
        "JSX .map() setup statements are not supported in v1; move them into a component or $computed()",
      );
    }
    body = directReturns[0]!.argument;
  }
  if (!t.isJSXElement(body) && !t.isJSXFragment(body)) {
    codeFrame(compiler, body, "JSX .map() callbacks must return JSX");
  }
  return {
    collection: expression.callee.object,
    itemName: itemParameter.name,
    indexName: indexParameter?.name,
    body,
  };
}

export function compileRenderableFactory(
  compiler: CompilerContext,
  expression: Expression,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): string {
  if (t.isJSXElement(expression) || t.isJSXFragment(expression)) {
    return `(__sol_frame) => { ${compileBlockBody(compiler, expression, bindings, scope)} }`;
  }
  if (t.isNullLiteral(expression) || t.isBooleanLiteral(expression, { value: false })) {
    return "(__sol_frame) => __sol_empty_block(__sol_frame)";
  }
  return `(__sol_frame) => __sol_value_block(() => (${expressionCode(expression, scope)}), __sol_frame)`;
}

export function compileExpressionChild(
  compiler: CompilerContext,
  expression: t.Expression,
  context: TemplateContext,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): void {
  const map = mapDetails(compiler, expression);
  if (map) {
    const listId = compiler.nextListId;
    compiler.nextListId += 1;
    const itemReference = `__sol_item_${listId}`;
    const indexReference = `__sol_index_${listId}`;
    const rowScope = new Map(scope);
    rowScope.set(map.itemName, `${itemReference}.value`);
    if (map.indexName) rowScope.set(map.indexName, `${indexReference}.value`);
    const keyScope = new Map(scope);
    keyScope.set(map.itemName, "__sol_value");
    if (map.indexName) keyScope.set(map.indexName, "__sol_position");
    const key = keyCode(compiler, getKeyAttribute(compiler, map.body), keyScope);
    const factory = compileRenderableFactory(compiler, map.body, bindings, rowScope);
    const index = region(context);
    context.operations.push(
      mappedCode(
        compiler,
        expression,
        `__sol_list(__sol_view.regions[${index}], () => (${expressionCode(map.collection, scope)}), (__sol_value, __sol_position) => (${key}), (${itemReference}, ${indexReference}, __sol_frame) => (${factory})(__sol_frame), __sol_cleanups, __sol_frame);`,
      ),
    );
    return;
  }

  if (t.isConditionalExpression(expression)) {
    const index = region(context);
    context.operations.push(
      mappedCode(
        compiler,
        expression,
        `__sol_when(__sol_view.regions[${index}], () => (${expressionCode(expression.test, scope)}), ${compileRenderableFactory(compiler, expression.consequent, bindings, scope)}, ${compileRenderableFactory(compiler, expression.alternate, bindings, scope)}, __sol_cleanups, __sol_frame);`,
      ),
    );
    return;
  }

  if (t.isLogicalExpression(expression, { operator: "&&" })) {
    const index = region(context);
    context.operations.push(
      mappedCode(
        compiler,
        expression,
        `__sol_when(__sol_view.regions[${index}], () => (${expressionCode(expression.left, scope)}), ${compileRenderableFactory(compiler, expression.right, bindings, scope)}, (__sol_frame) => __sol_empty_block(__sol_frame), __sol_cleanups, __sol_frame);`,
      ),
    );
    return;
  }

  const index = region(context);
  context.operations.push(
    mappedCode(
      compiler,
      expression,
      `__sol_text(__sol_view.regions[${index}], () => (${expressionCode(expression, scope)}), __sol_cleanups);`,
    ),
  );
}

export function compileNode(
  compiler: CompilerContext,
  node: t.JSXElement | t.JSXFragment | t.JSXText | t.JSXExpressionContainer | t.JSXSpreadChild,
  context: TemplateContext,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): void {
  if (t.isJSXText(node)) {
    const text = normalizeJsxText(node.value);
    if (text) context.html.push(escapeText(text));
    return;
  }
  if (t.isJSXSpreadChild(node))
    codeFrame(compiler, node, "JSX spread children are not supported in v1");
  if (t.isJSXExpressionContainer(node)) {
    if (t.isJSXEmptyExpression(node.expression)) return;
    if (t.isStringLiteral(node.expression) || t.isNumericLiteral(node.expression)) {
      context.html.push(escapeText(String(node.expression.value)));
      return;
    }
    if (!t.isExpression(node.expression))
      codeFrame(compiler, node, "Unsupported JSX child expression");
    compileExpressionChild(compiler, node.expression, context, bindings, scope);
    return;
  }
  if (t.isJSXFragment(node)) {
    for (const child of node.children) compileNode(compiler, child, context, bindings, scope);
    return;
  }
  if (compileProviderElement(compiler, node, context, bindings, scope)) return;
  const name = jsxName(compiler, node.openingElement.name);
  const builtin = compiler.builtinElements.get(node);
  if (compiler.linkElements.has(node)) {
    compileLinkElement(compiler, node, context, bindings, scope);
  } else if (builtin) {
    compileBuiltinElement(compiler, builtin, node, context, bindings, scope);
  } else if (compiler.componentElements.has(node)) {
    compileComponentElement(compiler, node, context, scope);
  } else if (/^[a-z]/.test(name)) {
    compileIntrinsicElement(compiler, node, context, bindings, scope);
  } else {
    codeFrame(
      compiler,
      node,
      `JSX component ${name} must be declared with $component() or imported`,
    );
  }
}

export function compileBlockBody(
  compiler: CompilerContext,
  root: t.JSXElement | t.JSXFragment,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): string {
  const context: TemplateContext = {
    html: [],
    operations: [],
    elementTags: [],
    nextElement: 0,
    nextRegion: 0,
    elementIds: new WeakMap(),
  };
  compileNode(compiler, root, context, bindings, scope);
  const compiledTemplate = {
    html: context.html.join(""),
    elementTags: context.elementTags,
    regionCount: context.nextRegion,
    operations: context.operations,
  };
  let templateIndex = compiler.templates.findIndex(
    (template) =>
      template.html === compiledTemplate.html &&
      template.regionCount === compiledTemplate.regionCount &&
      template.elementTags.length === compiledTemplate.elementTags.length &&
      template.elementTags.every((tag, index) => tag === compiledTemplate.elementTags[index]) &&
      template.operations.length === compiledTemplate.operations.length &&
      template.operations.every(
        (operation, index) => operation === compiledTemplate.operations[index],
      ),
  );
  if (templateIndex < 0) templateIndex = compiler.templates.push(compiledTemplate) - 1;
  if (context.operations.length === 0) {
    return `
      const __sol_view = __sol_instantiate(__sol_template_${templateIndex}, __sol_frame);
      return __sol_block(__sol_view.fragment);
    `;
  }
  const hasLifecycle = context.operations.some((operation) =>
    operation.includes("__sol_lifecycle"),
  );
  return `
    const __sol_view = __sol_instantiate(__sol_template_${templateIndex}, __sol_frame);
    const __sol_cleanups: Array<() => void> = [];
    ${hasLifecycle ? "const __sol_lifecycle = __sol_block_lifecycle(__sol_frame);" : ""}
    try {
      ${context.operations.join("\n")}
      return __sol_block(__sol_view.fragment, __sol_cleanups${hasLifecycle ? ", __sol_lifecycle" : ""});
    } catch (__sol_render_error) {
      __sol_rethrow(__sol_render_error, __sol_cleanups);
    }
  `;
}

function suspenseTimeoutCode(compiler: CompilerContext, node: t.JSXElement, scope: Scope): string {
  const attribute = namedAttribute(compiler, node, "timeoutMs");
  if (!attribute) return "undefined";
  const value = staticAttributeValue(compiler, attribute);
  if (value !== undefined) {
    return codeFrame(compiler, attribute, "Suspense timeoutMs must be a number expression");
  }
  return expressionCode(expressionAttribute(compiler, attribute), scope);
}
