import * as t from "@babel/types";
import {
  bindingRoot,
  containsJsx,
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
  validateErasedFunctionScope,
  type ReactiveKind,
} from "./codegen.ts";
import {
  nextAsyncSite,
  useRuntimeHelper,
  type CompilerContext,
  type Expression,
  type Scope,
  type TemplateContext,
} from "./context.ts";
import { codeFrame, mappedCode, unmappedCode } from "./diagnostics.ts";
import { escapeAttribute, escapeText, normalizeHtmlString, VOID_ELEMENTS } from "./html.ts";

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);
const TEXT_VALUE_ELEMENTS = new Set(["input", "textarea", "select", "option"]);
const BOOLEAN_ATTRIBUTES = new Set([
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "disablepictureinpicture",
  "disableremoteplayback",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
]);
const ENUMERATED_BOOLEAN_ATTRIBUTES = new Map<string, readonly [string, string]>([
  ["contenteditable", ["true", "false"]],
  ["draggable", ["true", "false"]],
  ["spellcheck", ["true", "false"]],
  ["translate", ["yes", "no"]],
]);

function enumeratedBooleanToken(name: string, value: boolean): string | undefined {
  return ENUMERATED_BOOLEAN_ATTRIBUTES.get(name)?.[value ? 0 : 1];
}

function validateSynchronousCallback(
  compiler: CompilerContext,
  expression: t.ArrowFunctionExpression | t.FunctionExpression,
  subject: string,
): void {
  if (expression.async || (t.isFunctionExpression(expression) && expression.generator)) {
    codeFrame(compiler, expression, `${subject} must be synchronous non-generator functions`);
  }
}

function asciiLower(value: string): string {
  return value.replaceAll(/[A-Z]/g, (character) => character.toLowerCase());
}

function intrinsicAttributeTarget(sourceName: string): string {
  if (sourceName === "class" || sourceName === "className" || sourceName === "classNames") {
    return "class";
  }
  if (sourceName === "htmlFor") return "for";
  if (/^on[A-Z]/.test(sourceName)) {
    const eventName = sourceName.slice(2).toLowerCase();
    return `event:${eventName === "doubleclick" ? "dblclick" : eventName}`;
  }
  return asciiLower(sourceName);
}

function findIntrinsicAttribute(
  compiler: CompilerContext,
  node: t.JSXElement,
  target: string,
): t.JSXAttribute | undefined {
  return node.openingElement.attributes.find(
    (attribute): attribute is t.JSXAttribute =>
      t.isJSXAttribute(attribute) &&
      intrinsicAttributeTarget(getAttributeName(compiler, attribute.name)) === target,
  );
}

function findDescendantOptionSelected(
  compiler: CompilerContext,
  node: t.JSXElement,
): t.JSXAttribute | undefined {
  let selected: t.JSXAttribute | undefined;
  t.traverseFast(node, (descendant) => {
    if (
      t.isJSXElement(descendant) &&
      t.isJSXIdentifier(descendant.openingElement.name, { name: "option" })
    ) {
      selected = findIntrinsicAttribute(compiler, descendant, "selected");
    }
    return selected ? t.traverseFast.stop : undefined;
  });
  return selected;
}

function validateUniqueAttributes(
  compiler: CompilerContext,
  node: t.JSXElement,
  intrinsic: boolean,
): void {
  const sources = new Map<string, string>();
  for (const attribute of node.openingElement.attributes) {
    if (!t.isJSXAttribute(attribute)) continue;
    const sourceName = getAttributeName(compiler, attribute.name);
    if (!intrinsic && ["$bind", "$transition", "ref"].includes(sourceName)) continue;
    const target = intrinsic ? intrinsicAttributeTarget(sourceName) : sourceName;
    const previous = sources.get(target);
    if (previous !== undefined) {
      codeFrame(compiler, attribute, `JSX attribute ${sourceName} conflicts with ${previous}`);
    }
    sources.set(target, sourceName);
  }
}

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
    if (kind === "controller")
      codeFrame(compiler, expression, "$bind cannot replace a request controller");
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
  validateSynchronousCallback(compiler, expression, "Error and data renderers");
  if (t.isFunctionExpression(expression)) validateErasedFunctionScope(compiler, expression);
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

function staticExpressionText(expression: Expression): string | undefined {
  if (t.isStringLiteral(expression) || t.isNumericLiteral(expression)) {
    return String(expression.value);
  }
  if (t.isBooleanLiteral(expression) || t.isNullLiteral(expression)) return "";
  if (t.isBigIntLiteral(expression)) {
    return String(BigInt(expression.value.replaceAll("_", "")));
  }
  if (t.isTemplateLiteral(expression) && expression.expressions.length === 0) {
    return expression.quasis[0]!.value.cooked ?? "";
  }
  if (
    t.isUnaryExpression(expression) &&
    (expression.operator === "+" || expression.operator === "-") &&
    t.isNumericLiteral(expression.argument)
  ) {
    const number = expression.argument.value;
    return String(expression.operator === "-" ? -number : number);
  }
  return undefined;
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
    useRuntimeHelper(compiler, "__sol_head");
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
      useRuntimeHelper(compiler, "__sol_global_portal");
      context.operations.push(
        mappedCode(
          compiler,
          node,
          `__sol_global_portal(${render}, __sol_cleanups, __sol_lifecycle, __sol_frame);`,
        ),
      );
      return;
    }
    useRuntimeHelper(compiler, "__sol_portal");
    const target = jsxAttributeExpression(
      compiler,
      namedAttribute(compiler, node, "target", true)!,
    );
    if (containsJsx(target)) {
      codeFrame(compiler, target, "Nested JSX is not supported in this expression");
    }
    if (isDefinitelyPrimitive(target)) {
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
    useRuntimeHelper(compiler, "__sol_suspense");
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
    useRuntimeHelper(compiler, "__sol_error_boundary");
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
  if (containsJsx(promise)) {
    codeFrame(compiler, promise, "Nested JSX is not supported in this expression");
  }
  if (t.isRegExpLiteral(promise) || isDefinitelyPrimitive(promise)) {
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
  useRuntimeHelper(compiler, "__sol_await");
  context.operations.push(
    mappedCode(
      compiler,
      node,
      `__sol_await(__sol_view.regions[${index}], () => (${expressionCode(promise, scope)}), (__sol_value, __sol_frame) => (${renderer})(__sol_frame), ${optionalErrorFactory(compiler, node, bindings, scope)}, __sol_cleanups, __sol_frame, ${JSON.stringify(nextAsyncSite(compiler))});`,
    ),
  );
}

function rawTextValues(
  compiler: CompilerContext,
  node: t.JSXElement,
  tag: string,
  scope: Scope,
): { codes: string[]; staticValue?: string } {
  const values: string[] = [];
  let staticValue = "";
  let isStatic = true;
  for (const child of node.children) {
    if (t.isJSXText(child)) {
      const value =
        tag === "script" || tag === "style" ? child.value : normalizeJsxText(child.value);
      if (value) {
        values.push(JSON.stringify(value));
        staticValue += value;
      }
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
      const staticText = staticExpressionText(child.expression);
      if (staticText === undefined) isStatic = false;
      else staticValue += staticText;
      continue;
    }
    codeFrame(compiler, child, "Raw-text element children must be text or expressions");
  }
  return { codes: values, staticValue: isStatic ? staticValue : undefined };
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
  if (containsJsx(data)) {
    codeFrame(compiler, data, "Nested JSX is not supported in this expression");
  }
  if (
    isDefinitelyPrimitive(data) ||
    t.isArrayExpression(data) ||
    t.isFunctionExpression(data) ||
    t.isArrowFunctionExpression(data) ||
    t.isClassExpression(data)
  )
    codeFrame(compiler, data, "Context Provider data must be an object expression");
  const contextName = expressionCode(t.identifier(name.object.name), scope);
  const index = region(context);
  useRuntimeHelper(compiler, "__sol_context_provider");
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
  validateUniqueAttributes(compiler, node, false);
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
  useRuntimeHelper(compiler, "__sol_child");
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
  if (!/^[a-z][A-Za-z0-9-]*$/.test(tag))
    codeFrame(compiler, node, "Dynamic JSX tags are not supported in v1");
  const attributes: string[] = [];
  const deferredOperations: ((element: number) => string)[] = [];
  let propertyValueElement = false;
  const inputTypeAttribute = findIntrinsicAttribute(compiler, node, "type");
  const inputType = inputTypeAttribute
    ? staticAttributeValue(compiler, inputTypeAttribute)
    : undefined;
  const normalizedInputType = typeof inputType === "string" ? inputType.toLowerCase() : inputType;
  const bindAttributes = node.openingElement.attributes.filter(
    (attribute): attribute is t.JSXAttribute =>
      t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name, { name: "$bind" }),
  );
  if (bindAttributes.length > 1) {
    codeFrame(compiler, bindAttributes[1]!, "Use only one $bind attribute on an element");
  }
  let bindProperty: "value" | "checked" | undefined;
  if (bindAttributes.length === 1) {
    const bindAttribute = bindAttributes[0]!;
    if (!["input", "textarea", "select"].includes(tag)) {
      codeFrame(
        compiler,
        bindAttribute,
        "$bind is only valid on input, textarea, and select elements",
      );
    }
    if (tag === "input" && inputTypeAttribute && inputType === undefined) {
      codeFrame(compiler, inputTypeAttribute, "$bind requires a static input type");
    }
    bindProperty =
      tag === "input" && (normalizedInputType === "checkbox" || normalizedInputType === "radio")
        ? "checked"
        : "value";
    const competingAttribute = findIntrinsicAttribute(compiler, node, bindProperty);
    if (competingAttribute) {
      codeFrame(compiler, competingAttribute, `$bind already controls ${bindProperty}`);
    }
  }
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
  validateUniqueAttributes(compiler, node, true);
  const rawText = RAW_TEXT_ELEMENTS.has(tag)
    ? rawTextValues(compiler, node, tag, scope)
    : { codes: [] };
  const rawValues = rawText.codes;
  const safeStaticRawText =
    rawText.staticValue !== undefined &&
    !rawText.staticValue.toLowerCase().includes(`</${tag.toLowerCase()}`)
      ? rawText.staticValue
      : undefined;
  const valueAttribute = findIntrinsicAttribute(compiler, node, "value");
  if (tag === "input" && valueAttribute && inputTypeAttribute && inputType === undefined) {
    codeFrame(compiler, inputTypeAttribute, "Controlled input value requires a static type");
  }
  if (
    tag === "input" &&
    normalizedInputType === "file" &&
    (valueAttribute || bindProperty === "value")
  ) {
    codeFrame(
      compiler,
      valueAttribute ?? bindAttributes[0]!,
      "File input value cannot be controlled",
    );
  }
  if (tag === "textarea" && rawValues.length > 0 && (valueAttribute || bindProperty === "value")) {
    codeFrame(
      compiler,
      valueAttribute ?? bindAttributes[0]!,
      "Textarea children conflict with value or $bind",
    );
  }
  if (tag === "select" && (valueAttribute || bindProperty === "value")) {
    const selected = findDescendantOptionSelected(compiler, node);
    if (selected) {
      codeFrame(
        compiler,
        selected,
        "Controlled select cannot contain an option selected attribute",
      );
    }
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
        ["event:submit", "event:input"].includes(
          intrinsicAttributeTarget(getAttributeName(compiler, attribute.name)),
        ),
    );
    if (conflictingHandler && t.isJSXAttribute(conflictingHandler)) {
      const handlerName = getAttributeName(compiler, conflictingHandler.name);
      codeFrame(compiler, conflictingHandler, `$form already handles ${handlerName}`);
    }
  }

  for (const attribute of node.openingElement.attributes) {
    if (t.isJSXSpreadAttribute(attribute))
      codeFrame(compiler, attribute, "JSX spread attributes are not supported in v1");
    const sourceName = getAttributeName(compiler, attribute.name);
    const targetName = intrinsicAttributeTarget(sourceName);
    if (sourceName === "key") continue;
    if (targetName === "data-sol-e" || targetName === "data-sol-hydration") {
      codeFrame(compiler, attribute, `${targetName} is reserved for hydration metadata`);
    }
    if (sourceName === "$form") {
      useRuntimeHelper(compiler, "__sol_event");
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
      useRuntimeHelper(compiler, "__sol_bind");
      const property = bindProperty!;
      if (property === "value") propertyValueElement = true;
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
      useRuntimeHelper(compiler, "__sol_transition");
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
      useRuntimeHelper(compiler, "__sol_ref");
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
      useRuntimeHelper(compiler, "__sol_event");
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

    const isClass = targetName === "class";
    const name = isClass
      ? "class"
      : targetName === "for" ||
          targetName === "value" ||
          targetName.startsWith("aria-") ||
          targetName.startsWith("data-")
        ? targetName
        : sourceName;
    const staticValue = staticAttributeValue(compiler, attribute);
    const stringBoolean = targetName.startsWith("aria-") || targetName.startsWith("data-");
    const enumeratedBoolean =
      typeof staticValue === "boolean"
        ? enumeratedBooleanToken(targetName, staticValue)
        : undefined;
    const expressionStringBoolean =
      BOOLEAN_ATTRIBUTES.has(targetName) &&
      t.isJSXExpressionContainer(attribute.value) &&
      t.isStringLiteral(attribute.value.expression);
    if (
      name === "value" &&
      (tag === "textarea" ||
        tag === "select" ||
        (TEXT_VALUE_ELEMENTS.has(tag) && typeof staticValue === "boolean"))
    ) {
      useRuntimeHelper(compiler, "__sol_attribute");
      const value =
        staticValue !== undefined
          ? JSON.stringify(staticValue)
          : expressionCode(expressionAttribute(compiler, attribute), scope);
      propertyValueElement = true;
      deferredOperations.push((element) =>
        mappedCode(
          compiler,
          attribute,
          `__sol_attribute(__sol_view.elements[${element}], "value", () => (${value}), __sol_cleanups);`,
        ),
      );
    } else if (typeof staticValue === "boolean" && stringBoolean) {
      attributes.push(`${name}="${String(staticValue)}"`);
    } else if (enumeratedBoolean !== undefined) {
      attributes.push(`${name}="${enumeratedBoolean}"`);
    } else if (staticValue === true) attributes.push(name);
    else if (typeof staticValue === "string" && !expressionStringBoolean)
      attributes.push(`${name}="${escapeAttribute(staticValue)}"`);
    else if (
      t.isJSXExpressionContainer(attribute.value) &&
      t.isNumericLiteral(attribute.value.expression) &&
      !BOOLEAN_ATTRIBUTES.has(targetName)
    ) {
      attributes.push(`${name}="${escapeAttribute(String(attribute.value.expression.value))}"`);
    } else if (staticValue === false) continue;
    else {
      useRuntimeHelper(compiler, "__sol_attribute");
      const value = expressionCode(expressionAttribute(compiler, attribute), scope);
      if (targetName === "value") propertyValueElement = true;
      deferredOperations.push((element) =>
        mappedCode(
          compiler,
          attribute,
          `__sol_attribute(__sol_view.elements[${element}], ${JSON.stringify(name)}, () => (${value}), __sol_cleanups);`,
        ),
      );
    }
  }

  if (rawValues.length > 0 && safeStaticRawText === undefined) {
    useRuntimeHelper(compiler, "__sol_raw_text");
    propertyValueElement = true;
    deferredOperations.push(
      (element) =>
        `__sol_raw_text(__sol_view.elements[${element}], () => [${rawValues.join(", ")}], __sol_cleanups);`,
    );
  }

  deferredOperations.push(...injectedOperations);
  if (deferredOperations.length > 0) {
    const index = elementId(context, node.openingElement);
    context.elementTags[index] = tag;
    if (propertyValueElement) context.propertyValueElements.add(index);
    attributes.push(`data-sol-e="${index}"`);
    context.operations.push(...deferredOperations.map((operation) => operation(index)));
  }
  context.html.push(`<${tag}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>`);
  if (!VOID_ELEMENTS.has(tag)) {
    if (safeStaticRawText !== undefined) {
      let serialized =
        tag === "script" || tag === "style"
          ? normalizeHtmlString(safeStaticRawText)
          : escapeText(safeStaticRawText);
      serialized = serialized.replaceAll(/\r\n?/g, "\n");
      if (tag === "textarea" && serialized.startsWith("\n")) serialized = `\n${serialized}`;
      context.html.push(serialized);
    } else if (!RAW_TEXT_ELEMENTS.has(tag)) {
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
  const anchorHref = findIntrinsicAttribute(compiler, anchor, "href");
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
  useRuntimeHelper(compiler, "__sol_link");
  compileIntrinsicElement(compiler, anchor, context, bindings, scope, [
    (element) =>
      `__sol_link(__sol_view.elements[${element}], () => (${route}), () => ({ ${destinationProperties.join(", ")} }), () => (${replace}), __sol_cleanups);`,
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
  if (expression.arguments.length !== 1) {
    codeFrame(compiler, expression, "JSX .map() accepts exactly one inline callback argument");
  }
  const callback = expression.arguments[0];
  if (!t.isArrowFunctionExpression(callback) && !t.isFunctionExpression(callback)) {
    codeFrame(compiler, expression, "JSX .map() requires an inline function");
  }
  validateSynchronousCallback(compiler, callback, "JSX .map() callbacks");
  if (callback.params.length > 2) {
    codeFrame(
      compiler,
      callback.params[2]!,
      "JSX .map() callbacks accept only item and index parameters",
    );
  }
  if (t.isFunctionExpression(callback)) validateErasedFunctionScope(compiler, callback);
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
    useRuntimeHelper(compiler, "__sol_empty_block");
    return "(__sol_frame) => __sol_empty_block(__sol_frame)";
  }
  if (containsJsx(expression)) {
    codeFrame(compiler, expression, "Nested JSX is not supported in this expression");
  }
  useRuntimeHelper(compiler, "__sol_value_block");
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
    if (containsJsx(map.collection)) {
      codeFrame(compiler, map.collection, "Nested JSX is not supported in this expression");
    }
    useRuntimeHelper(compiler, "__sol_list");
    const scopeValues = new Set(scope.values());
    let listDepth = 0;
    while (
      scopeValues.has(`__sol_item_${listDepth}.value`) ||
      scopeValues.has(`__sol_index_${listDepth}.value`)
    ) {
      listDepth += 1;
    }
    const itemReference = `__sol_item_${listDepth}`;
    const indexReference = `__sol_index_${listDepth}`;
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
    if (containsJsx(expression.test)) {
      codeFrame(compiler, expression.test, "Nested JSX is not supported in this expression");
    }
    useRuntimeHelper(compiler, "__sol_when");
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
    if (containsJsx(expression.left)) {
      codeFrame(compiler, expression.left, "Nested JSX is not supported in this expression");
    }
    useRuntimeHelper(compiler, "__sol_when");
    useRuntimeHelper(compiler, "__sol_empty_block");
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

  if (containsJsx(expression)) {
    codeFrame(compiler, expression, "Nested JSX is not supported in this expression");
  }

  const index = region(context);
  if (t.isIdentifier(expression) && scope.get(expression.name) === expression.name) {
    useRuntimeHelper(compiler, "__sol_static_text");
    context.operations.push(
      mappedCode(
        compiler,
        expression,
        `__sol_static_text(__sol_view.regions[${index}], ${expression.name});`,
      ),
    );
    return;
  }
  useRuntimeHelper(compiler, "__sol_text");
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
    if (!t.isExpression(node.expression)) {
      codeFrame(compiler, node, "Unsupported JSX child expression");
    }
    const staticText = staticExpressionText(node.expression);
    if (staticText !== undefined) {
      if (staticText) context.html.push(escapeText(staticText));
      return;
    }
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
    propertyValueElements: new Set(),
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
    propertyValueElements: [...context.propertyValueElements].toSorted(
      (left, right) => left - right,
    ),
  };
  const templateSignature = JSON.stringify([
    compiledTemplate.html,
    compiledTemplate.regionCount,
    compiledTemplate.elementTags,
    compiledTemplate.operations.map((operation) => unmappedCode(compiler, operation)),
  ]);
  let templateIndex = compiler.templateIndexes.get(templateSignature);
  if (templateIndex === undefined) {
    templateIndex = compiler.templates.push(compiledTemplate) - 1;
    compiler.templateIndexes.set(templateSignature, templateIndex);
  }
  const owner = compiler.activeArtifactOwner;
  if (owner) {
    let owners = compiler.templateOwners.get(templateIndex);
    if (!owners) {
      owners = new Set();
      compiler.templateOwners.set(templateIndex, owners);
    }
    owners.add(owner);
  }
  if (context.operations.length === 0) {
    useRuntimeHelper(compiler, "__sol_instantiate");
    useRuntimeHelper(compiler, "__sol_block");
    return `
      const __sol_view = __sol_instantiate(__sol_template_${templateIndex}, __sol_frame);
      return __sol_block(__sol_view.fragment);
    `;
  }
  const hasLifecycle = context.operations.some((operation) =>
    operation.includes("__sol_lifecycle"),
  );
  useRuntimeHelper(compiler, "__sol_instantiate");
  useRuntimeHelper(compiler, "__sol_block");
  useRuntimeHelper(compiler, "__sol_rethrow");
  if (hasLifecycle) useRuntimeHelper(compiler, "__sol_block_lifecycle");
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
