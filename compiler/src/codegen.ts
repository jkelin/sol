import { parseExpression } from "@babel/parser";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { generate, traverse } from "./ast.ts";
import type { CompilerContext, Scope, TemplateContext } from "./context.ts";
import { codeFrame } from "./diagnostics.ts";

export function isSolFilename(filename: string): boolean {
  return /\.sol\.tsx?$/i.test(filename.replaceAll("\\", "/"));
}

export function normalizeJsxText(value: string): string {
  if (!value.includes("\n") && !value.includes("\r")) return value;
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

export function containsJsx(node: t.Node): boolean {
  let found = false;
  t.traverseFast(node, (child) => {
    if (t.isJSXElement(child) || t.isJSXFragment(child)) found = true;
  });
  return found;
}

export function rewriteIdentifiers(file: t.File, scope: Scope): void {
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

export function expressionCode(expression: t.Expression, scope: Scope): string {
  const cloned = t.cloneNode(expression, true);
  const file = t.file(t.program([t.expressionStatement(cloned)]));
  rewriteIdentifiers(file, scope);
  return generate((file.program.body[0] as t.ExpressionStatement).expression).code;
}

export function statementCode(statement: t.Statement, scope: Scope): string {
  const file = t.file(t.program([t.cloneNode(statement, true)]));
  rewriteIdentifiers(file, scope);
  return generate(file.program.body[0]!).code;
}

export function jsxName(
  context: CompilerContext,
  name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName,
): string {
  if (!t.isJSXIdentifier(name))
    codeFrame(context, name, "Dynamic and namespaced JSX tag names are not supported in v1");
  return name.name;
}

export function region(context: TemplateContext): number {
  const index = context.nextRegion++;
  context.html.push(`<!--sol:s:${index}--><!--sol:e:${index}-->`);
  return index;
}

export function elementId(context: TemplateContext, opening: t.JSXOpeningElement): number {
  const existing = context.elementIds.get(opening);
  if (existing !== undefined) return existing;
  const index = context.nextElement++;
  context.elementIds.set(opening, index);
  return index;
}

export function getAttributeName(
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

export function staticAttributeValue(
  context: CompilerContext,
  attribute: t.JSXAttribute,
): string | boolean | undefined {
  if (!attribute.value) return true;
  if (t.isStringLiteral(attribute.value)) return attribute.value.value;
  if (t.isJSXExpressionContainer(attribute.value) && t.isStringLiteral(attribute.value.expression))
    return attribute.value.expression.value;
  if (
    t.isJSXExpressionContainer(attribute.value) &&
    t.isTemplateLiteral(attribute.value.expression) &&
    attribute.value.expression.expressions.length === 0
  ) {
    return attribute.value.expression.quasis[0]!.value.cooked ?? "";
  }
  if (
    t.isJSXExpressionContainer(attribute.value) &&
    t.isBooleanLiteral(attribute.value.expression)
  ) {
    return attribute.value.expression.value;
  }
  return undefined;
}

export function expressionAttribute(
  context: CompilerContext,
  attribute: t.JSXAttribute,
): t.Expression {
  if (!t.isJSXExpressionContainer(attribute.value) || !t.isExpression(attribute.value.expression)) {
    codeFrame(context, attribute, "This JSX attribute requires an expression");
  }
  if (containsJsx(attribute.value.expression)) {
    codeFrame(
      context,
      attribute.value.expression,
      "Nested JSX is not supported in this expression",
    );
  }
  return attribute.value.expression;
}

export function getKeyAttribute(
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

export function keyCode(context: CompilerContext, attribute: t.JSXAttribute, scope: Scope): string {
  const value = staticAttributeValue(context, attribute);
  if (value !== undefined) return JSON.stringify(value);
  return expressionCode(expressionAttribute(context, attribute), scope);
}

export type ReactiveKind = "signal" | "computed" | "controller";

export function isReservedCompilerName(name: string): boolean {
  return name.startsWith("__sol_");
}

export function validateReservedIdentifier(
  compiler: CompilerContext,
  identifier: t.Identifier,
): void {
  if (isReservedCompilerName(identifier.name)) {
    codeFrame(
      compiler,
      identifier,
      `Identifier ${identifier.name} uses the reserved compiler prefix __sol_`,
    );
  }
}

export function validateErasedFunctionScope(
  compiler: CompilerContext,
  declaration: t.FunctionExpression,
  preserveName = false,
): void {
  const cloned = t.cloneNode(declaration, true);
  const file = t.file(t.program([t.expressionStatement(cloned)]));
  const belongsToErasedFunction = (path: NodePath): boolean => {
    let owner = path.getFunctionParent();
    while (owner?.isArrowFunctionExpression()) owner = owner.getFunctionParent();
    return owner?.node === cloned;
  };
  traverse(file, {
    ReferencedIdentifier(path: NodePath<t.Identifier | t.JSXIdentifier>) {
      if (!t.isIdentifier(path.node)) return;
      if (
        !preserveName &&
        cloned.id &&
        path.node.name === cloned.id.name &&
        path.scope.getBinding(path.node.name)?.identifier === cloned.id
      ) {
        codeFrame(
          compiler,
          path.node,
          `Function name ${path.node.name} cannot be used because its binding is compiled away`,
        );
      }
      if (path.node.name !== "arguments") return;
      if (belongsToErasedFunction(path)) {
        codeFrame(
          compiler,
          path.node,
          "arguments cannot be used because its function scope is compiled away",
        );
      }
    },
    MetaProperty(path: NodePath<t.MetaProperty>) {
      if (
        t.isIdentifier(path.node.meta, { name: "new" }) &&
        t.isIdentifier(path.node.property, { name: "target" }) &&
        belongsToErasedFunction(path)
      ) {
        codeFrame(
          compiler,
          path.node,
          "new.target cannot be used because its function scope is compiled away",
        );
      }
    },
  });
}

export function reactiveHelperCall(
  compiler: CompilerContext,
  expression: t.Expression | null | undefined,
  name: "$signal" | "$computed",
): t.CallExpression | undefined {
  if (!expression) return undefined;
  const call = unwrapTransparentExpression(expression);
  return t.isCallExpression(call) && compiler.reactiveHelperCalls.get(call) === name.slice(1)
    ? call
    : undefined;
}

export function referencedNames(expression: t.Expression): Set<string> {
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

export function unwrapTransparentExpression(expression: t.Expression): t.Expression {
  let current = expression;
  while (
    t.isTSAsExpression(current) ||
    t.isTSTypeAssertion(current) ||
    t.isTSNonNullExpression(current) ||
    t.isTSSatisfiesExpression(current) ||
    t.isTypeCastExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function bindingRoot(expression: t.Expression): string | undefined {
  let current = unwrapTransparentExpression(expression);
  for (;;) {
    if (
      (t.isMemberExpression(current) || t.isOptionalMemberExpression(current)) &&
      t.isExpression(current.object)
    ) {
      current = unwrapTransparentExpression(current.object);
    } else {
      break;
    }
  }
  return t.isIdentifier(current) ? current.name : undefined;
}
