import generateModule from "@babel/generator";
import { parse, parseExpression } from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import MagicString, { SourceMap } from "magic-string";

const generate =
  (generateModule as unknown as { default?: typeof generateModule }).default ?? generateModule;
const traverse =
  (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule;

const RUNTIME_IMPORT = `import {
  $computed as __ff_computed,
  $signal as __ff_signal,
  attribute as __ff_attribute,
  bindValue as __ff_bind,
  block as __ff_block,
  child as __ff_child,
  component as __ff_component,
  emptyBlock as __ff_empty_block,
  event as __ff_event,
  instantiate as __ff_instantiate,
  list as __ff_list,
  route as __ff_route,
  template as __ff_template,
  text as __ff_text,
  valueBlock as __ff_value_block,
  when as __ff_when
} from "frontend-framework/runtime";`;

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

type Expression = t.Expression | t.JSXElement | t.JSXFragment;
type Scope = ReadonlyMap<string, string>;

export interface CompileResult {
  code: string;
  map: SourceMap | null;
}

interface Edit {
  start: number;
  end: number;
  code: string;
}

interface CompiledFunction {
  code: string;
  returned: t.JSXElement | t.JSXFragment;
}

interface TemplateContext {
  html: string[];
  operations: string[];
  nextElement: number;
  nextRegion: number;
  elementIds: WeakMap<t.JSXOpeningElement, number>;
}

interface CompilerContext {
  filename: string;
  source: string;
  templates: string[];
  componentNames: Set<string>;
  propsName?: string;
  mappingOrigins: Array<{ marker: string; originalOffset: number }>;
  nextListId: number;
}

function mappedCode(compiler: CompilerContext, node: t.Node, code: string): string {
  const marker = `/*__ff_source_${compiler.mappingOrigins.length}__*/`;
  compiler.mappingOrigins.push({ marker, originalOffset: node.start ?? 0 });
  return `${marker}${code}`;
}

function offsetPosition(source: string, offset: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart };
}

function generatedSourceMap(
  transformedSource: MagicString,
  transformed: string,
  compiler: CompilerContext,
): SourceMap {
  const decoded = transformedSource.generateDecodedMap({
    hires: true,
    source: compiler.filename,
    includeContent: true,
  });
  for (const origin of compiler.mappingOrigins) {
    const markerOffset = transformed.indexOf(origin.marker);
    if (markerOffset < 0) continue;
    const generated = offsetPosition(transformed, markerOffset + origin.marker.length);
    const original = offsetPosition(compiler.source, origin.originalOffset);
    const segments = decoded.mappings[generated.line] ?? (decoded.mappings[generated.line] = []);
    const existing = segments.findIndex((segment) => segment[0] === generated.column);
    if (existing >= 0) segments.splice(existing, 1);
    segments.push([generated.column, 0, original.line, original.column]);
    segments.sort((left, right) => left[0] - right[0]);
  }
  return new SourceMap({
    ...decoded,
    sourcesContent: (decoded.sourcesContent ?? [compiler.source]).map((content) => content ?? ""),
  });
}

function codeFrame(context: CompilerContext, node: t.Node, message: string): never {
  const line = node.loc?.start.line ?? 1;
  const column = node.loc?.start.column ?? 0;
  const sourceLine = context.source.split(/\r?\n/)[line - 1] ?? "";
  const error = new SyntaxError(
    `${context.filename}:${line}:${column + 1} ${message}\n${sourceLine}\n${" ".repeat(column)}^`,
  );
  throw error;
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

function escapeTemplate(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ParsedRoutePath {
  pattern: string;
  parameterNames: string[];
  specificity: number[];
}

function parseRoutePath(context: CompilerContext, node: t.StringLiteral): ParsedRoutePath {
  const path = node.value;
  if (!path.startsWith("/") || path.startsWith("//")) {
    codeFrame(context, node, "Route paths must start with exactly one slash");
  }
  if (path.includes("?") || path.includes("#")) {
    codeFrame(context, node, "Route paths must not contain a query string or hash");
  }
  if (path !== "/" && (path.endsWith("/") || path.includes("//"))) {
    codeFrame(context, node, "Route paths must not contain empty or trailing segments");
  }
  if (path === "/") return { pattern: "^/$", parameterNames: [], specificity: [] };

  const parameterNames: string[] = [];
  const specificity: number[] = [];
  const pattern = path
    .slice(1)
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) {
        specificity.push(1);
        return escapeRegExp(segment);
      }
      const name = segment.slice(1);
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        codeFrame(context, node, `Invalid route parameter ${segment}`);
      }
      if (parameterNames.includes(name)) {
        codeFrame(context, node, `Duplicate route parameter ${name}`);
      }
      parameterNames.push(name);
      specificity.push(0);
      return "([^/]+)";
    })
    .join("/");
  return { pattern: `^/${pattern}$`, parameterNames, specificity };
}

function isRouteFilename(filename: string): boolean {
  return /\.route\.[jt]sx?$/i.test(filename.replaceAll("\\", "/"));
}

function normalizeJsxText(value: string): string {
  if (!value.includes("\n") && !value.includes("\r")) return value;
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function rewriteIdentifiers(file: t.File, scope: Scope): void {
  traverse(file, {
    Identifier(path: NodePath<t.Identifier>) {
      const replacement = scope.get(path.node.name);
      if (!replacement || path.scope.hasBinding(path.node.name)) return;
      const isAssignment = t.isAssignmentExpression(path.parent) && path.parent.left === path.node;
      const isUpdate = t.isUpdateExpression(path.parent) && path.parent.argument === path.node;
      if (!path.isReferencedIdentifier() && !isAssignment && !isUpdate) return;
      if (t.isObjectProperty(path.parent) && path.parent.shorthand) path.parent.shorthand = false;
      path.replaceWith(parseExpression(replacement, { plugins: ["typescript"] }));
      path.skip();
    },
  });
}

function expressionCode(expression: t.Expression, scope: Scope): string {
  const cloned = t.cloneNode(expression, true);
  const file = t.file(t.program([t.expressionStatement(cloned)]));
  rewriteIdentifiers(file, scope);
  return generate((file.program.body[0] as t.ExpressionStatement).expression).code;
}

function statementCode(statement: t.Statement, scope: Scope): string {
  const file = t.file(t.program([t.cloneNode(statement, true)]));
  rewriteIdentifiers(file, scope);
  return generate(file.program.body[0]!).code;
}

function jsxName(
  context: CompilerContext,
  name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName,
): string {
  if (!t.isJSXIdentifier(name))
    codeFrame(context, name, "Dynamic and namespaced JSX tag names are not supported in v1");
  return name.name;
}

function region(context: TemplateContext): number {
  const index = context.nextRegion++;
  context.html.push(`<!--ff:s:${index}--><!--ff:e:${index}-->`);
  return index;
}

function elementId(context: TemplateContext, opening: t.JSXOpeningElement): number {
  const existing = context.elementIds.get(opening);
  if (existing !== undefined) return existing;
  const index = context.nextElement++;
  context.elementIds.set(opening, index);
  return index;
}

function getAttributeName(
  context: CompilerContext,
  name: t.JSXIdentifier | t.JSXNamespacedName,
): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (name.namespace.name === "bind") {
    codeFrame(
      context,
      name,
      "bind:* was removed; use $bind={value} and let the compiler infer the DOM property",
    );
  }
  return codeFrame(context, name, "JSX namespaces are not supported");
}

function staticAttributeValue(
  context: CompilerContext,
  attribute: t.JSXAttribute,
): string | boolean | undefined {
  if (!attribute.value) return true;
  if (t.isStringLiteral(attribute.value)) return attribute.value.value;
  if (t.isJSXExpressionContainer(attribute.value) && t.isStringLiteral(attribute.value.expression))
    return attribute.value.expression.value;
  if (
    t.isJSXExpressionContainer(attribute.value) &&
    t.isBooleanLiteral(attribute.value.expression)
  ) {
    return attribute.value.expression.value;
  }
  return undefined;
}

function expressionAttribute(context: CompilerContext, attribute: t.JSXAttribute): t.Expression {
  if (!t.isJSXExpressionContainer(attribute.value) || !t.isExpression(attribute.value.expression)) {
    codeFrame(context, attribute, "This JSX attribute requires an expression");
  }
  return attribute.value.expression;
}

function getKeyAttribute(
  context: CompilerContext,
  node: t.JSXElement | t.JSXFragment,
): t.JSXAttribute {
  if (t.isJSXFragment(node))
    codeFrame(context, node, "A keyed list row must have a single element or component root");
  for (const attribute of node.openingElement.attributes) {
    if (t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name, { name: "key" }))
      return attribute;
  }
  return codeFrame(context, node, "Every JSX .map() row requires a key attribute");
}

function keyCode(context: CompilerContext, attribute: t.JSXAttribute, scope: Scope): string {
  const value = staticAttributeValue(context, attribute);
  if (value !== undefined) return JSON.stringify(value);
  return expressionCode(expressionAttribute(context, attribute), scope);
}

type ReactiveKind = "signal" | "computed";

function isReservedCompilerName(name: string): boolean {
  return name.startsWith("__ff_");
}

function validateReservedIdentifier(compiler: CompilerContext, identifier: t.Identifier): void {
  if (isReservedCompilerName(identifier.name)) {
    codeFrame(
      compiler,
      identifier,
      `Identifier ${identifier.name} uses the reserved compiler prefix __ff_`,
    );
  }
}

function isHelperCall(
  expression: t.Expression | null | undefined,
  name: "$signal" | "$computed",
): expression is t.CallExpression {
  return t.isCallExpression(expression) && t.isIdentifier(expression.callee, { name });
}

function referencesReactive(
  expression: t.Expression,
  reactiveNames: ReadonlySet<string>,
  propsName: string | undefined,
): boolean {
  let found = false;
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(expression, true))]));
  traverse(file, {
    ReferencedIdentifier(path: NodePath<t.Identifier | t.JSXIdentifier>) {
      if (!t.isIdentifier(path.node)) return;
      if (path.scope.hasBinding(path.node.name)) return;
      if (path.node.name === propsName || reactiveNames.has(path.node.name)) {
        found = true;
        path.stop();
      }
    },
  });
  return found;
}

function referencedNames(expression: t.Expression): Set<string> {
  const names = new Set<string>();
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(expression, true))]));
  traverse(file, {
    ReferencedIdentifier(path: NodePath<t.Identifier | t.JSXIdentifier>) {
      if (!t.isIdentifier(path.node) || path.scope.hasBinding(path.node.name)) return;
      names.add(path.node.name);
    },
  });
  return names;
}

function bindingRoot(expression: t.Expression): string | undefined {
  let current: t.Expression = expression;
  while (t.isMemberExpression(current) && t.isExpression(current.object)) current = current.object;
  return t.isIdentifier(current) ? current.name : undefined;
}

function compileBinding(
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
      write: `${reference} = ${property === "checked" ? "Boolean(__ff_value)" : 'String(__ff_value ?? "")'}`,
    };
  }
  if (t.isMemberExpression(expression) && !expression.optional) {
    const root = bindingRoot(expression);
    const scopedRoot = root ? scope.get(root) : undefined;
    const isKeyedRowValue =
      scopedRoot !== undefined && /^__ff_(?:item|index)_\d+\.value$/.test(scopedRoot);
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
      write: `${target} = ${property === "checked" ? "Boolean(__ff_value)" : 'String(__ff_value ?? "")'}`,
    };
  }
  return codeFrame(
    compiler,
    expression,
    "$bind requires writable component state or an assignable member expression",
  );
}

function compileComponentElement(
  compiler: CompilerContext,
  node: t.JSXElement,
  context: TemplateContext,
  scope: Scope,
): void {
  const componentName = jsxName(compiler, node.openingElement.name);
  const meaningfulChildren = node.children.filter((child) => {
    return !t.isJSXText(child) || normalizeJsxText(child.value) !== "";
  });
  if (meaningfulChildren.length > 0) {
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
      `__ff_child(__ff_view.regions[${index}], ${componentName}, { ${props.join(", ")} }, __ff_cleanups);`,
    ),
  );
}

function compileIntrinsicElement(
  compiler: CompilerContext,
  node: t.JSXElement,
  context: TemplateContext,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
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

  for (const attribute of node.openingElement.attributes) {
    if (t.isJSXSpreadAttribute(attribute))
      codeFrame(compiler, attribute, "JSX spread attributes are not supported in v1");
    const sourceName = getAttributeName(compiler, attribute.name);
    if (sourceName === "key") continue;
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
          `__ff_bind(__ff_view.elements[${element}], ${JSON.stringify(property)}, () => (${binding.read}), (__ff_value: unknown) => { ${binding.write}; }, __ff_cleanups);`,
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
          `__ff_event(__ff_view.elements[${element}], ${JSON.stringify(eventName)}, () => (${handler}), __ff_cleanups);`,
        ),
      );
      continue;
    }

    const isClass =
      sourceName === "class" || sourceName === "className" || sourceName === "classNames";
    const name = isClass ? "class" : sourceName === "htmlFor" ? "for" : sourceName;
    const staticValue = staticAttributeValue(compiler, attribute);
    if (staticValue === true) attributes.push(name);
    else if (typeof staticValue === "string")
      attributes.push(`${name}="${escapeAttribute(staticValue)}"`);
    else if (staticValue === false) continue;
    else {
      const value = expressionCode(expressionAttribute(compiler, attribute), scope);
      deferredOperations.push((element) =>
        mappedCode(
          compiler,
          attribute,
          `__ff_attribute(__ff_view.elements[${element}], ${JSON.stringify(name)}, () => (${value}), __ff_cleanups);`,
        ),
      );
    }
  }

  if (deferredOperations.length > 0) {
    const index = elementId(context, node.openingElement);
    attributes.push(`data-ff-e="${index}"`);
    context.operations.push(...deferredOperations.map((operation) => operation(index)));
  }
  context.html.push(`<${tag}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>`);
  if (!VOID_ELEMENTS.has(tag)) {
    for (const child of node.children) compileNode(compiler, child, context, bindings, scope);
    context.html.push(`</${tag}>`);
  } else if (node.children.length > 0) {
    codeFrame(compiler, node, `Void element <${tag}> cannot have children`);
  }
}

function mapDetails(
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

function compileRenderableFactory(
  compiler: CompilerContext,
  expression: Expression,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): string {
  if (t.isJSXElement(expression) || t.isJSXFragment(expression)) {
    return `() => { ${compileBlockBody(compiler, expression, bindings, scope)} }`;
  }
  if (t.isNullLiteral(expression) || t.isBooleanLiteral(expression, { value: false })) {
    return "() => __ff_empty_block()";
  }
  return `() => __ff_value_block(() => (${expressionCode(expression, scope)}))`;
}

function compileExpressionChild(
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
    const itemReference = `__ff_item_${listId}`;
    const indexReference = `__ff_index_${listId}`;
    const rowScope = new Map(scope);
    rowScope.set(map.itemName, `${itemReference}.value`);
    if (map.indexName) rowScope.set(map.indexName, `${indexReference}.value`);
    const keyScope = new Map(scope);
    keyScope.set(map.itemName, "__ff_value");
    if (map.indexName) keyScope.set(map.indexName, "__ff_position");
    const key = keyCode(compiler, getKeyAttribute(compiler, map.body), keyScope);
    const factory = compileRenderableFactory(compiler, map.body, bindings, rowScope);
    const index = region(context);
    context.operations.push(
      mappedCode(
        compiler,
        expression,
        `__ff_list(__ff_view.regions[${index}], () => (${expressionCode(map.collection, scope)}), (__ff_value, __ff_position) => (${key}), (${itemReference}, ${indexReference}) => (${factory})(), __ff_cleanups);`,
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
        `__ff_when(__ff_view.regions[${index}], () => (${expressionCode(expression.test, scope)}), ${compileRenderableFactory(compiler, expression.consequent, bindings, scope)}, ${compileRenderableFactory(compiler, expression.alternate, bindings, scope)}, __ff_cleanups);`,
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
        `__ff_when(__ff_view.regions[${index}], () => (${expressionCode(expression.left, scope)}), ${compileRenderableFactory(compiler, expression.right, bindings, scope)}, () => __ff_empty_block(), __ff_cleanups);`,
      ),
    );
    return;
  }

  const index = region(context);
  context.operations.push(
    mappedCode(
      compiler,
      expression,
      `__ff_text(__ff_view.regions[${index}], () => (${expressionCode(expression, scope)}), __ff_cleanups);`,
    ),
  );
}

function compileNode(
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
  const name = jsxName(compiler, node.openingElement.name);
  if (compiler.componentNames.has(name)) {
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

function compileBlockBody(
  compiler: CompilerContext,
  root: t.JSXElement | t.JSXFragment,
  bindings: ReadonlyMap<string, ReactiveKind>,
  scope: Scope,
): string {
  const context: TemplateContext = {
    html: [],
    operations: [],
    nextElement: 0,
    nextRegion: 0,
    elementIds: new WeakMap(),
  };
  compileNode(compiler, root, context, bindings, scope);
  const templateIndex = compiler.templates.push(context.html.join("")) - 1;
  return `
    const __ff_view = __ff_instantiate(__ff_template_${templateIndex});
    const __ff_cleanups: Array<() => void> = [];
    ${context.operations.join("\n")}
    return __ff_block(__ff_view.fragment, __ff_cleanups);
  `;
}

function reactiveCallCode(
  call: t.CallExpression,
  runtimeName: "__ff_signal" | "__ff_computed",
  scope: Scope,
): string {
  const cloned = t.cloneNode(call, true);
  cloned.callee = t.identifier(runtimeName);
  return expressionCode(cloned, scope);
}

function typeParameterCode(identifier: t.Identifier): string {
  return identifier.typeAnnotation && t.isTSTypeAnnotation(identifier.typeAnnotation)
    ? `<${generate(identifier.typeAnnotation.typeAnnotation).code}>`
    : "";
}

function validateComputedWrites(
  compiler: CompilerContext,
  setup: t.Statement[],
  bindings: ReadonlyMap<string, ReactiveKind>,
): void {
  const file = t.file(t.program(setup.map((statement) => t.cloneNode(statement, true))));
  const check = (path: NodePath, expression: t.Expression): void => {
    const root = bindingRoot(expression);
    if (!root || bindings.get(root) !== "computed") return;
    const binding = path.scope.getBinding(root);
    if (binding?.scope.path.isProgram()) {
      codeFrame(compiler, expression, `Computed component value ${root} is readonly`);
    }
  };
  traverse(file, {
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      if (t.isExpression(path.node.left)) check(path, path.node.left);
    },
    UpdateExpression(path: NodePath<t.UpdateExpression>) {
      if (t.isExpression(path.node.argument)) check(path, path.node.argument);
    },
    CallExpression(path: NodePath<t.CallExpression>) {
      if (
        t.isMemberExpression(path.node.callee) &&
        t.isExpression(path.node.callee.object) &&
        t.isIdentifier(path.node.callee.property) &&
        [
          "copyWithin",
          "fill",
          "pop",
          "push",
          "reverse",
          "shift",
          "sort",
          "splice",
          "unshift",
        ].includes(path.node.callee.property.name)
      )
        check(path, path.node.callee.object);
    },
  });
}

function validatePropWrites(
  compiler: CompilerContext,
  body: t.BlockStatement,
  propsName: string | undefined,
): void {
  if (!propsName) return;
  const clonedComponent = t.functionExpression(null, [], t.cloneNode(body, true));
  const file = t.file(t.program([t.expressionStatement(clonedComponent)]));
  const isDirectPropMember = (path: NodePath, expression: t.Expression): boolean =>
    t.isMemberExpression(expression) &&
    t.isIdentifier(expression.object, { name: propsName }) &&
    !path.scope.hasBinding(propsName);
  const reject = (node: t.Node): never =>
    codeFrame(
      compiler,
      node,
      `Component props are readonly; ${propsName} members cannot be assigned directly`,
    );

  traverse(file, {
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      if (t.isExpression(path.node.left) && isDirectPropMember(path, path.node.left))
        reject(path.node.left);
    },
    UpdateExpression(path: NodePath<t.UpdateExpression>) {
      if (t.isExpression(path.node.argument) && isDirectPropMember(path, path.node.argument)) {
        reject(path.node.argument);
      }
    },
    UnaryExpression(path: NodePath<t.UnaryExpression>) {
      if (
        path.node.operator === "delete" &&
        t.isExpression(path.node.argument) &&
        isDirectPropMember(path, path.node.argument)
      )
        reject(path.node.argument);
    },
    CallExpression(path: NodePath<t.CallExpression>) {
      const [target] = path.node.arguments;
      if (
        !target ||
        !t.isExpression(target) ||
        !t.isIdentifier(target, { name: propsName }) ||
        path.scope.hasBinding(propsName)
      )
        return;
      if (
        t.isMemberExpression(path.node.callee) &&
        !path.node.callee.computed &&
        t.isIdentifier(path.node.callee.object) &&
        t.isIdentifier(path.node.callee.property) &&
        ["defineProperty", "setPrototypeOf", "preventExtensions"].includes(
          path.node.callee.property.name,
        ) &&
        (path.node.callee.object.name === "Object" || path.node.callee.object.name === "Reflect") &&
        !path.scope.getBinding(path.node.callee.object.name)
      )
        reject(target);
    },
  });
}

function validateDerivedInitializer(compiler: CompilerContext, expression: t.Expression): void {
  const file = t.file(t.program([t.expressionStatement(t.cloneNode(expression, true))]));
  traverse(file, {
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      codeFrame(compiler, path.node, "Derived component initializers must not assign values");
    },
    UpdateExpression(path: NodePath<t.UpdateExpression>) {
      codeFrame(compiler, path.node, "Derived component initializers must not update values");
    },
    UnaryExpression(path: NodePath<t.UnaryExpression>) {
      if (path.node.operator === "delete") {
        codeFrame(compiler, path.node, "Derived component initializers must not delete values");
      }
    },
    CallExpression(path: NodePath<t.CallExpression>) {
      if (
        t.isMemberExpression(path.node.callee) &&
        t.isIdentifier(path.node.callee.property) &&
        [
          "copyWithin",
          "fill",
          "pop",
          "push",
          "reverse",
          "shift",
          "sort",
          "splice",
          "unshift",
        ].includes(path.node.callee.property.name)
      )
        codeFrame(
          compiler,
          path.node,
          "Derived component initializers must not call mutating collection methods",
        );
    },
  });
}

function compileSetup(
  compiler: CompilerContext,
  setup: t.Statement[],
  propsName: string | undefined,
): { bindings: Map<string, ReactiveKind>; code: string; scope: Map<string, string> } {
  const bindings = new Map<string, ReactiveKind>();
  const declarationKinds = new WeakMap<t.VariableDeclarator, ReactiveKind | "function">();
  const remainingDataNames = new Set<string>();
  for (const statement of setup) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declaration of statement.declarations) {
      if (t.isIdentifier(declaration.id)) remainingDataNames.add(declaration.id.name);
    }
  }

  for (const statement of setup) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declaration of statement.declarations) {
      if (!t.isIdentifier(declaration.id)) {
        codeFrame(
          compiler,
          declaration.id,
          "Component setup declarations must use identifiers; destructuring is not reactive in v1",
        );
      }
      const initializer = declaration.init;
      remainingDataNames.delete(declaration.id.name);
      if (t.isFunctionExpression(initializer) || t.isArrowFunctionExpression(initializer)) {
        declarationKinds.set(declaration, "function");
        continue;
      }
      if (
        initializer &&
        t.isExpression(initializer) &&
        referencedNames(initializer).has(declaration.id.name)
      ) {
        codeFrame(
          compiler,
          initializer,
          `Reactive component declaration ${declaration.id.name} cannot reference itself`,
        );
      }
      if (initializer && t.isExpression(initializer)) {
        const forwardReference = [...referencedNames(initializer)].find((name) =>
          remainingDataNames.has(name),
        );
        if (forwardReference) {
          codeFrame(
            compiler,
            initializer,
            `Reactive component declarations cannot reference later binding ${forwardReference}`,
          );
        }
      }
      const kind: ReactiveKind = isHelperCall(initializer, "$computed")
        ? "computed"
        : isHelperCall(initializer, "$signal")
          ? "signal"
          : statement.kind === "const" &&
              initializer &&
              referencesReactive(initializer, new Set(bindings.keys()), propsName)
            ? "computed"
            : "signal";
      declarationKinds.set(declaration, kind);
      bindings.set(declaration.id.name, kind);
      if (kind === "computed" && initializer && !isHelperCall(initializer, "$computed")) {
        validateDerivedInitializer(compiler, initializer);
      }
    }
  }

  validateComputedWrites(compiler, setup, bindings);
  const scope = new Map<string, string>();
  for (const name of bindings.keys()) scope.set(name, `${name}.value`);
  const generated: string[] = [];

  for (const statement of setup) {
    if (!t.isVariableDeclaration(statement)) {
      generated.push(mappedCode(compiler, statement, statementCode(statement, scope)));
      continue;
    }
    for (const declaration of statement.declarations) {
      const identifier = declaration.id;
      if (!t.isIdentifier(identifier)) {
        codeFrame(
          compiler,
          identifier,
          "Component setup declarations must use identifier bindings",
        );
      }
      const kind = declarationKinds.get(declaration)!;
      if (kind === "function") {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `${statement.kind} ${identifier.name} = ${expressionCode(declaration.init as t.Expression, scope)};`,
          ),
        );
        continue;
      }
      const initializer =
        declaration.init && t.isExpression(declaration.init)
          ? declaration.init
          : t.identifier("undefined");
      if (kind === "signal" && isHelperCall(initializer, "$signal")) {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = ${reactiveCallCode(initializer, "__ff_signal", scope)};`,
          ),
        );
      } else if (kind === "computed" && isHelperCall(initializer, "$computed")) {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = ${reactiveCallCode(initializer, "__ff_computed", scope)};`,
          ),
        );
      } else if (kind === "computed") {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = __ff_computed${typeParameterCode(identifier)}(() => (${expressionCode(initializer, scope)}));`,
          ),
        );
      } else {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = __ff_signal${typeParameterCode(identifier)}(${expressionCode(initializer, scope)});`,
          ),
        );
      }
    }
  }
  return { bindings, code: generated.join("\n"), scope };
}

function compileFunction(
  compiler: CompilerContext,
  name: string,
  declaration: t.FunctionExpression,
  exported: boolean,
): CompiledFunction {
  if (!declaration.id)
    codeFrame(compiler, declaration, "$component() requires a named function expression");
  validateReservedIdentifier(compiler, declaration.id);
  if (declaration.id.name !== name) {
    codeFrame(
      compiler,
      declaration.id,
      `$component() function name ${declaration.id.name} must match binding ${name}`,
    );
  }
  if (declaration.async || declaration.generator)
    codeFrame(compiler, declaration, "Components must be synchronous functions");
  if (declaration.params.length > 1)
    codeFrame(compiler, declaration, "Components accept at most one props parameter");
  const parameter = declaration.params[0];
  if (parameter && !t.isIdentifier(parameter)) {
    codeFrame(
      compiler,
      parameter,
      "Component props must use one identifier; destructuring is not reactive in v1",
    );
  }
  if (parameter) validateReservedIdentifier(compiler, parameter);
  const directReturns = declaration.body.body.filter((statement): statement is t.ReturnStatement =>
    t.isReturnStatement(statement),
  );
  if (directReturns.length !== 1 || directReturns[0] !== declaration.body.body.at(-1)) {
    codeFrame(compiler, declaration, "Components require exactly one final JSX return");
  }
  const clonedDeclaration = t.cloneNode(declaration, true);
  const clonedFinalReturn = clonedDeclaration.body.body.at(-1);
  let earlyReturn: t.ReturnStatement | undefined;
  traverse(t.file(t.program([t.expressionStatement(clonedDeclaration)])), {
    ReturnStatement(path: NodePath<t.ReturnStatement>) {
      const owner = path.getFunctionParent();
      if (owner?.node === clonedDeclaration && path.node !== clonedFinalReturn) {
        earlyReturn = path.node;
        path.stop();
      }
    },
  });
  if (earlyReturn)
    codeFrame(compiler, earlyReturn, "Early component returns are not supported in v1");
  const returned = directReturns[0]!.argument;
  if (!t.isJSXElement(returned) && !t.isJSXFragment(returned)) {
    codeFrame(compiler, directReturns[0]!, "The final component return must be JSX");
  }
  const setup = declaration.body.body.slice(0, -1);
  validatePropWrites(compiler, declaration.body, parameter?.name);
  for (const statement of setup) {
    if (t.isVariableDeclaration(statement)) {
      for (const variable of statement.declarations) {
        if (t.isIdentifier(variable.id)) validateReservedIdentifier(compiler, variable.id);
      }
    } else if (
      (t.isFunctionDeclaration(statement) || t.isClassDeclaration(statement)) &&
      statement.id
    ) {
      validateReservedIdentifier(compiler, statement.id);
    }
  }
  const compiledSetup = compileSetup(compiler, setup, parameter?.name);
  const parameterCode = parameter ? generate(parameter).code : "__ff_props";
  const previousPropsName = compiler.propsName;
  compiler.propsName = parameter?.name;
  const body = compileBlockBody(compiler, returned, compiledSetup.bindings, compiledSetup.scope);
  compiler.propsName = previousPropsName;
  return {
    code: `${exported ? "export " : ""}const ${name} = __ff_component((${parameterCode}) => {
      ${compiledSetup.code}
      ${body}
    });`,
    returned,
  };
}

export function compile(source: string, filename = "component.tsx"): CompileResult {
  if (typeof source !== "string") throw new TypeError("compile() expects source code as a string");
  if (!filename) throw new TypeError("compile() expects a filename");
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ["typescript", "jsx"],
  });
  const compiler: CompilerContext = {
    filename,
    source,
    templates: [],
    componentNames: new Set(),
    mappingOrigins: [],
    nextListId: 0,
  };
  const edits: Edit[] = [];
  const compiledJsxRanges: Array<{ start: number; end: number }> = [];
  const componentCallRanges = new Set<string>();
  const routeCallRanges = new Set<string>();

  traverse(ast, {
    Program(path) {
      for (const binding of Object.values(path.scope.bindings)) {
        validateReservedIdentifier(compiler, binding.identifier);
      }
      path.stop();
    },
  });

  for (const statement of ast.program.body) {
    if (t.isImportDeclaration(statement)) {
      if (statement.source.value === "frontend-framework") {
        for (const specifier of statement.specifiers) {
          if (
            t.isImportSpecifier(specifier) &&
            t.isIdentifier(specifier.imported) &&
            (specifier.imported.name === "signal" || specifier.imported.name === "computed")
          ) {
            codeFrame(
              compiler,
              specifier,
              `${specifier.imported.name}() was renamed to $${specifier.imported.name}()`,
            );
          }
        }
      }
      const isFrameworkHelperModule =
        statement.source.value === "frontend-framework" ||
        statement.source.value.startsWith("frontend-framework/");
      if (statement.importKind !== "type" && !isFrameworkHelperModule) {
        for (const specifier of statement.specifiers) {
          if (t.isImportSpecifier(specifier) && specifier.importKind === "type") continue;
          compiler.componentNames.add(specifier.local.name);
        }
      } else if (statement.source.value === "frontend-framework") {
        for (const specifier of statement.specifiers) {
          if (
            t.isImportSpecifier(specifier) &&
            t.isIdentifier(specifier.imported, { name: "Route" })
          ) {
            compiler.componentNames.add(specifier.local.name);
          }
        }
      }
    }
    const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
    if (!t.isVariableDeclaration(declaration)) continue;
    for (const variable of declaration.declarations) {
      if (
        t.isIdentifier(variable.id) &&
        t.isCallExpression(variable.init) &&
        t.isIdentifier(variable.init.callee, { name: "$component" })
      )
        compiler.componentNames.add(variable.id.name);
    }
  }

  for (const statement of ast.program.body) {
    const exported = t.isExportNamedDeclaration(statement);
    const declaration = exported ? statement.declaration : statement;
    if (!t.isVariableDeclaration(declaration)) continue;
    const componentVariables = declaration.declarations.filter(
      (variable) =>
        t.isCallExpression(variable.init) &&
        t.isIdentifier(variable.init.callee, { name: "$component" }),
    );
    if (componentVariables.length === 0) continue;
    if (declaration.kind !== "const" || declaration.declarations.length !== 1) {
      codeFrame(
        compiler,
        declaration,
        "$component() must be the sole initializer in a top-level const declaration",
      );
    }
    const variable = componentVariables[0]!;
    if (!t.isIdentifier(variable.id))
      codeFrame(compiler, variable.id, "$component() declarations require an identifier");
    const call = variable.init;
    if (!t.isCallExpression(call)) {
      codeFrame(compiler, variable, "$component() initializer must be a call expression");
    }
    if (call.arguments.length !== 1 || !t.isFunctionExpression(call.arguments[0])) {
      codeFrame(compiler, call, "$component() expects exactly one named function expression");
    }
    const compiled = compileFunction(compiler, variable.id.name, call.arguments[0], exported);
    edits.push({ start: statement.start!, end: statement.end!, code: compiled.code });
    componentCallRanges.add(`${call.start}:${call.end}`);
    if (compiled.returned.start != null && compiled.returned.end != null) {
      compiledJsxRanges.push({ start: compiled.returned.start, end: compiled.returned.end });
    }
  }

  for (const statement of ast.program.body) {
    const exported = t.isExportNamedDeclaration(statement);
    const declaration = exported ? statement.declaration : statement;
    if (!t.isVariableDeclaration(declaration)) continue;
    const routeVariables = declaration.declarations.filter(
      (variable) =>
        t.isCallExpression(variable.init) &&
        t.isIdentifier(variable.init.callee, { name: "$route" }),
    );
    if (routeVariables.length === 0) continue;
    const variable = routeVariables[0]!;
    if (!isRouteFilename(filename)) {
      codeFrame(compiler, variable, "$route() is only valid in *.route.[jt]sx? files");
    }
    if (!exported) codeFrame(compiler, declaration, "$route() declarations must be exported");
    if (declaration.kind !== "const" || declaration.declarations.length !== 1) {
      codeFrame(
        compiler,
        declaration,
        "$route() must be the sole initializer in an exported top-level const declaration",
      );
    }
    if (!t.isIdentifier(variable.id)) {
      codeFrame(compiler, variable.id, "$route() declarations require an identifier");
    }
    const call = variable.init;
    if (!t.isCallExpression(call) || call.arguments.length !== 2) {
      codeFrame(compiler, variable, "$route() expects a config object and a component");
    }
    const config = call.arguments[0]!;
    const candidate = call.arguments[1]!;
    if (!t.isObjectExpression(config)) {
      codeFrame(compiler, call, "$route() config must be an object literal");
    }
    if (config.properties.length !== 1) {
      codeFrame(compiler, config, "$route() config must contain only a path property");
    }
    const property = config.properties[0];
    if (
      !t.isObjectProperty(property) ||
      property.computed ||
      !t.isIdentifier(property.key, { name: "path" }) ||
      !t.isStringLiteral(property.value)
    ) {
      codeFrame(compiler, config, "$route() path must be a string literal");
    }
    if (!t.isIdentifier(candidate) || !compiler.componentNames.has(candidate.name)) {
      codeFrame(compiler, candidate, "$route() component must reference a compiled component");
    }
    const parsedPath = parseRoutePath(compiler, property.value);
    edits.push({
      start: statement.start!,
      end: statement.end!,
      code: `export const ${variable.id.name} = __ff_route(${generate(config).code}, ${candidate.name}, ${JSON.stringify(parsedPath)});`,
    });
    routeCallRanges.add(`${call.start}:${call.end}`);
  }

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      if (t.isIdentifier(path.node.callee, { name: "$component" })) {
        if (componentCallRanges.has(`${path.node.start}:${path.node.end}`)) return;
        codeFrame(
          compiler,
          path.node,
          "$component() is only valid as a direct top-level const initializer",
        );
      }
      if (t.isIdentifier(path.node.callee, { name: "$route" })) {
        if (routeCallRanges.has(`${path.node.start}:${path.node.end}`)) return;
        codeFrame(
          compiler,
          path.node,
          isRouteFilename(filename)
            ? "$route() is only valid as an exported top-level const initializer"
            : "$route() is only valid in *.route.[jt]sx? files",
        );
      }
    },
  });

  if (edits.length === 0) {
    let survivingJsx: t.JSXElement | t.JSXFragment | undefined;
    traverse(ast, {
      JSXElement(path: NodePath<t.JSXElement>) {
        survivingJsx = path.node;
        path.stop();
      },
      JSXFragment(path: NodePath<t.JSXFragment>) {
        survivingJsx = path.node;
        path.stop();
      },
    });
    if (survivingJsx) {
      codeFrame(
        compiler,
        survivingJsx,
        "JSX must be returned from a top-level $component(function Name() {}) declaration",
      );
    }
    return { code: source, map: null };
  }

  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      const covered = compiledJsxRanges.some(
        (range) => path.node.start! >= range.start && path.node.end! <= range.end,
      );
      if (!covered)
        codeFrame(
          compiler,
          path.node,
          "JSX survived compilation; wrap a named function with $component()",
        );
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      const covered = compiledJsxRanges.some(
        (range) => path.node.start! >= range.start && path.node.end! <= range.end,
      );
      if (!covered)
        codeFrame(
          compiler,
          path.node,
          "JSX survived compilation; wrap a named function with $component()",
        );
    },
  });

  const transformedSource = new MagicString(source);
  for (const edit of edits) transformedSource.overwrite(edit.start, edit.end, edit.code);
  const templates = compiler.templates
    .map(
      (html, index) => `const __ff_template_${index} = __ff_template(\`${escapeTemplate(html)}\`);`,
    )
    .join("\n");
  transformedSource.prepend(`${RUNTIME_IMPORT}\n${templates}\n`);
  const transformed = transformedSource.toString();

  const outputAst = parse(transformed, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ["typescript"],
  });
  void outputAst;
  return {
    code: transformed,
    map: generatedSourceMap(transformedSource, transformed, compiler),
  };
}
