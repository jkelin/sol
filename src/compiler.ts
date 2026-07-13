import generateModule from "@babel/generator";
import { parse, parseExpression } from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import MagicString from "magic-string";

const generate = (
  (generateModule as unknown as { default?: typeof generateModule }).default ?? generateModule
);
const traverse = (
  (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule
);

const RUNTIME_IMPORT = `import {
  attribute as __ff_attribute,
  bindValue as __ff_bind,
  block as __ff_block,
  child as __ff_child,
  component as __ff_component,
  emptyBlock as __ff_empty_block,
  event as __ff_event,
  instantiate as __ff_instantiate,
  list as __ff_list,
  template as __ff_template,
  text as __ff_text,
  valueBlock as __ff_value_block,
  when as __ff_when
} from "frontend-framework/runtime";`;

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
  "source", "track", "wbr",
]);

type Expression = t.Expression | t.JSXElement | t.JSXFragment;
type Scope = ReadonlyMap<string, string>;

export interface CompileResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]> | null;
}

interface Edit {
  start: number;
  end: number;
  code: string;
}

interface CompiledFunction {
  body: string;
  finalReturn: t.ReturnStatement;
  header: string;
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

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(name);
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

function escapeTemplate(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function normalizeJsxText(value: string): string {
  if (!value.includes("\n") && !value.includes("\r")) return value;
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function expressionCode(expression: t.Expression, scope: Scope): string {
  const cloned = t.cloneNode(expression, true);
  const file = t.file(t.program([t.expressionStatement(cloned)]));
  traverse(file, {
    ReferencedIdentifier(path: NodePath<t.Identifier | t.JSXIdentifier>) {
      if (!t.isIdentifier(path.node)) return;
      const replacement = scope.get(path.node.name);
      if (!replacement || path.scope.hasBinding(path.node.name)) return;
      if (t.isObjectProperty(path.parent) && path.parent.shorthand) path.parent.shorthand = false;
      path.replaceWith(parseExpression(replacement, { plugins: ["typescript"] }));
      path.skip();
    },
  });
  return generate((file.program.body[0] as t.ExpressionStatement).expression).code;
}

function jsxName(
  context: CompilerContext,
  name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName,
): string {
  if (!t.isJSXIdentifier(name)) codeFrame(context, name, "Dynamic and namespaced JSX tag names are not supported in v1");
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
  if (name.namespace.name !== "bind") codeFrame(context, name, "Only the bind: JSX namespace is supported");
  return `bind:${name.name.name}`;
}

function staticAttributeValue(
  context: CompilerContext,
  attribute: t.JSXAttribute,
): string | boolean | undefined {
  if (!attribute.value) return true;
  if (t.isStringLiteral(attribute.value)) return attribute.value.value;
  if (
    t.isJSXExpressionContainer(attribute.value)
    && t.isStringLiteral(attribute.value.expression)
  ) return attribute.value.expression.value;
  if (t.isJSXExpressionContainer(attribute.value) && t.isBooleanLiteral(attribute.value.expression)) {
    return attribute.value.expression.value;
  }
  return undefined;
}

function expressionAttribute(
  context: CompilerContext,
  attribute: t.JSXAttribute,
): t.Expression {
  if (!t.isJSXExpressionContainer(attribute.value) || !t.isExpression(attribute.value.expression)) {
    codeFrame(context, attribute, "This JSX attribute requires an expression");
  }
  return attribute.value.expression;
}

function getKeyAttribute(
  context: CompilerContext,
  node: t.JSXElement | t.JSXFragment,
): t.JSXAttribute {
  if (t.isJSXFragment(node)) codeFrame(context, node, "A keyed list row must have a single element or component root");
  for (const attribute of node.openingElement.attributes) {
    if (t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name, { name: "key" })) return attribute;
  }
  codeFrame(context, node, "Every JSX .map() row requires a key attribute");
}

function keyCode(context: CompilerContext, attribute: t.JSXAttribute, scope: Scope): string {
  const value = staticAttributeValue(context, attribute);
  if (value !== undefined) return JSON.stringify(value);
  return expressionCode(expressionAttribute(context, attribute), scope);
}

function findSignalNames(statements: t.Statement[]): Set<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    if (!t.isVariableDeclaration(statement)) continue;
    for (const declaration of statement.declarations) {
      if (
        t.isIdentifier(declaration.id)
        && t.isCallExpression(declaration.init)
        && t.isIdentifier(declaration.init.callee, { name: "signal" })
      ) names.add(declaration.id.name);
    }
  }
  return names;
}

function compileBinding(
  compiler: CompilerContext,
  expression: t.Expression,
  property: "value" | "checked",
  signals: ReadonlySet<string>,
  scope: Scope,
): { read: string; write: string } {
  if (t.isIdentifier(expression)) {
    if (!signals.has(expression.name)) {
      codeFrame(compiler, expression, "A binding identifier must be declared by signal()");
    }
    const reference = expressionCode(expression, scope);
    return {
      read: `${reference}.value`,
      write: `${reference}.value = ${property === "checked" ? "Boolean(__ff_value)" : "String(__ff_value ?? \"\")"}`,
    };
  }
  if (t.isMemberExpression(expression) && !expression.optional) {
    const target = expressionCode(expression, scope);
    return {
      read: target,
      write: `${target} = ${property === "checked" ? "Boolean(__ff_value)" : "String(__ff_value ?? \"\")"}`,
    };
  }
  codeFrame(compiler, expression, "Bindings require a signal identifier or assignable member expression");
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
    codeFrame(compiler, node, "Component children are not supported in v1; pass an explicit prop instead");
  }
  const props: string[] = [];
  for (const attribute of node.openingElement.attributes) {
    if (t.isJSXSpreadAttribute(attribute)) codeFrame(compiler, attribute, "JSX spread attributes are not supported in v1");
    const name = getAttributeName(compiler, attribute.name);
    if (name === "key") continue;
    if (name.startsWith("bind:")) codeFrame(compiler, attribute, "Two-way bindings are only valid on intrinsic form elements");
    const value = staticAttributeValue(compiler, attribute);
    const getter = value !== undefined
      ? `() => ${JSON.stringify(value)}`
      : `() => (${expressionCode(expressionAttribute(compiler, attribute), scope)})`;
    props.push(`${JSON.stringify(name)}: ${getter}`);
  }
  const index = region(context);
  context.operations.push(
    `__ff_child(__ff_view.regions[${index}], ${componentName}, { ${props.join(", ")} }, __ff_cleanups);`,
  );
}

function compileIntrinsicElement(
  compiler: CompilerContext,
  node: t.JSXElement,
  context: TemplateContext,
  signals: ReadonlySet<string>,
  scope: Scope,
): void {
  const tag = jsxName(compiler, node.openingElement.name);
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) codeFrame(compiler, node, "Dynamic JSX tags are not supported in v1");
  const attributes: string[] = [];
  const deferredOperations: ((element: number) => string)[] = [];
  const inputTypeAttribute = node.openingElement.attributes.find((attribute) =>
    t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name, { name: "type" })
  );
  const inputType = inputTypeAttribute && t.isJSXAttribute(inputTypeAttribute)
    ? staticAttributeValue(compiler, inputTypeAttribute)
    : undefined;

  for (const attribute of node.openingElement.attributes) {
    if (t.isJSXSpreadAttribute(attribute)) codeFrame(compiler, attribute, "JSX spread attributes are not supported in v1");
    const sourceName = getAttributeName(compiler, attribute.name);
    if (sourceName === "key") continue;
    if (sourceName.startsWith("bind:")) {
      const property = sourceName.slice(5);
      if (property !== "value" && property !== "checked") {
        codeFrame(compiler, attribute, "Only bind:value and bind:checked are supported");
      }
      if (
        (property === "value" && !["input", "textarea", "select"].includes(tag))
        || (
          property === "checked"
          && (tag !== "input" || (inputType !== "checkbox" && inputType !== "radio"))
        )
      ) codeFrame(compiler, attribute, `${sourceName} is not valid on <${tag}>`);
      const binding = compileBinding(
        compiler,
        expressionAttribute(compiler, attribute),
        property,
        signals,
        scope,
      );
      deferredOperations.push((element) =>
        `__ff_bind(__ff_view.elements[${element}], ${JSON.stringify(property)}, () => (${binding.read}), (__ff_value: unknown) => { ${binding.write}; }, __ff_cleanups);`,
      );
      continue;
    }

    if (/^on[A-Z]/.test(sourceName)) {
      const normalizedEventName = sourceName.slice(2).toLowerCase();
      const eventName = normalizedEventName === "doubleclick" ? "dblclick" : normalizedEventName;
      const handler = expressionCode(expressionAttribute(compiler, attribute), scope);
      deferredOperations.push((element) =>
        `__ff_event(__ff_view.elements[${element}], ${JSON.stringify(eventName)}, () => (${handler}), __ff_cleanups);`,
      );
      continue;
    }

    const name = sourceName === "className" ? "class" : sourceName === "htmlFor" ? "for" : sourceName;
    const staticValue = staticAttributeValue(compiler, attribute);
    if (staticValue === true) attributes.push(name);
    else if (typeof staticValue === "string") attributes.push(`${name}="${escapeAttribute(staticValue)}"`);
    else if (staticValue === false) continue;
    else {
      const value = expressionCode(expressionAttribute(compiler, attribute), scope);
      deferredOperations.push((element) =>
        `__ff_attribute(__ff_view.elements[${element}], ${JSON.stringify(sourceName)}, () => (${value}), __ff_cleanups);`,
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
    for (const child of node.children) compileNode(compiler, child, context, signals, scope);
    context.html.push(`</${tag}>`);
  } else if (node.children.length > 0) {
    codeFrame(compiler, node, `Void element <${tag}> cannot have children`);
  }
}

function mapDetails(
  compiler: CompilerContext,
  expression: t.Expression,
): {
  collection: t.Expression;
  itemName: string;
  indexName?: string;
  body: t.JSXElement | t.JSXFragment;
} | undefined {
  if (
    !t.isCallExpression(expression)
    || !t.isMemberExpression(expression.callee)
    || expression.callee.computed
    || !t.isIdentifier(expression.callee.property, { name: "map" })
    || !t.isExpression(expression.callee.object)
  ) return undefined;
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
    const directReturns = body.body.filter((statement): statement is t.ReturnStatement => t.isReturnStatement(statement));
    if (directReturns.length !== 1 || directReturns[0] !== body.body.at(-1) || !directReturns[0]!.argument) {
      codeFrame(compiler, body, "JSX .map() callbacks require exactly one final return");
    }
    if (body.body.length > 1) {
      codeFrame(
        compiler,
        body.body[0]!,
        "JSX .map() setup statements are not supported in v1; move them into a component or computed()",
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
  signals: ReadonlySet<string>,
  scope: Scope,
): string {
  if (t.isJSXElement(expression) || t.isJSXFragment(expression)) {
    return `() => { ${compileBlockBody(compiler, expression, signals, scope)} }`;
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
  signals: ReadonlySet<string>,
  scope: Scope,
): void {
  const map = mapDetails(compiler, expression);
  if (map) {
    const rowScope = new Map(scope);
    rowScope.set(map.itemName, "__ff_item.value");
    if (map.indexName) rowScope.set(map.indexName, "__ff_index.value");
    const keyScope = new Map(scope);
    keyScope.set(map.itemName, "__ff_value");
    if (map.indexName) keyScope.set(map.indexName, "__ff_position");
    const key = keyCode(compiler, getKeyAttribute(compiler, map.body), keyScope);
    const factory = compileRenderableFactory(compiler, map.body, signals, rowScope);
    const index = region(context);
    context.operations.push(
      `__ff_list(__ff_view.regions[${index}], () => (${expressionCode(map.collection, scope)}), (__ff_value, __ff_position) => (${key}), (__ff_item, __ff_index) => (${factory})(), __ff_cleanups);`,
    );
    return;
  }

  if (t.isConditionalExpression(expression)) {
    const index = region(context);
    context.operations.push(
      `__ff_when(__ff_view.regions[${index}], () => (${expressionCode(expression.test, scope)}), ${compileRenderableFactory(compiler, expression.consequent as Expression, signals, scope)}, ${compileRenderableFactory(compiler, expression.alternate as Expression, signals, scope)}, __ff_cleanups);`,
    );
    return;
  }

  if (t.isLogicalExpression(expression, { operator: "&&" })) {
    const index = region(context);
    context.operations.push(
      `__ff_when(__ff_view.regions[${index}], () => (${expressionCode(expression.left, scope)}), ${compileRenderableFactory(compiler, expression.right as Expression, signals, scope)}, () => __ff_empty_block(), __ff_cleanups);`,
    );
    return;
  }

  const index = region(context);
  context.operations.push(
    `__ff_text(__ff_view.regions[${index}], () => (${expressionCode(expression, scope)}), __ff_cleanups);`,
  );
}

function compileNode(
  compiler: CompilerContext,
  node: t.JSXElement | t.JSXFragment | t.JSXText | t.JSXExpressionContainer | t.JSXSpreadChild,
  context: TemplateContext,
  signals: ReadonlySet<string>,
  scope: Scope,
): void {
  if (t.isJSXText(node)) {
    const text = normalizeJsxText(node.value);
    if (text) context.html.push(escapeText(text));
    return;
  }
  if (t.isJSXSpreadChild(node)) codeFrame(compiler, node, "JSX spread children are not supported in v1");
  if (t.isJSXExpressionContainer(node)) {
    if (t.isJSXEmptyExpression(node.expression)) return;
    if (t.isStringLiteral(node.expression) || t.isNumericLiteral(node.expression)) {
      context.html.push(escapeText(String(node.expression.value)));
      return;
    }
    if (!t.isExpression(node.expression)) codeFrame(compiler, node, "Unsupported JSX child expression");
    compileExpressionChild(compiler, node.expression, context, signals, scope);
    return;
  }
  if (t.isJSXFragment(node)) {
    for (const child of node.children) compileNode(compiler, child, context, signals, scope);
    return;
  }
  const name = jsxName(compiler, node.openingElement.name);
  if (isPascalCase(name)) compileComponentElement(compiler, node, context, scope);
  else compileIntrinsicElement(compiler, node, context, signals, scope);
}

function compileBlockBody(
  compiler: CompilerContext,
  root: t.JSXElement | t.JSXFragment,
  signals: ReadonlySet<string>,
  scope: Scope,
): string {
  const context: TemplateContext = {
    html: [],
    operations: [],
    nextElement: 0,
    nextRegion: 0,
    elementIds: new WeakMap(),
  };
  compileNode(compiler, root, context, signals, scope);
  const templateIndex = compiler.templates.push(context.html.join("")) - 1;
  return `
    const __ff_view = __ff_instantiate(__ff_template_${templateIndex});
    const __ff_cleanups: Array<() => void> = [];
    ${context.operations.join("\n")}
    return __ff_block(__ff_view.fragment, __ff_cleanups);
  `;
}

function compileFunction(
  compiler: CompilerContext,
  declaration: t.FunctionDeclaration,
  exported: boolean,
): CompiledFunction {
  const name = declaration.id?.name;
  if (!name) codeFrame(compiler, declaration, "Components require a name");
  if (declaration.async || declaration.generator) codeFrame(compiler, declaration, "Components must be synchronous functions");
  if (declaration.params.length > 1) codeFrame(compiler, declaration, "Components accept at most one props parameter");
  const parameter = declaration.params[0];
  if (parameter && !t.isIdentifier(parameter)) {
    codeFrame(compiler, parameter, "Component props must use one identifier; destructuring is not reactive in v1");
  }
  const directReturns = declaration.body.body.filter((statement): statement is t.ReturnStatement => t.isReturnStatement(statement));
  if (directReturns.length !== 1 || directReturns[0] !== declaration.body.body.at(-1)) {
    codeFrame(compiler, declaration, "Components require exactly one final JSX return");
  }
  const clonedDeclaration = t.cloneNode(declaration, true);
  const clonedFinalReturn = clonedDeclaration.body.body.at(-1);
  let earlyReturn: t.ReturnStatement | undefined;
  traverse(t.file(t.program([clonedDeclaration])), {
    ReturnStatement(path: NodePath<t.ReturnStatement>) {
      const owner = path.getFunctionParent();
      if (owner?.node === clonedDeclaration && path.node !== clonedFinalReturn) {
        earlyReturn = path.node;
        path.stop();
      }
    },
  });
  if (earlyReturn) codeFrame(compiler, earlyReturn, "Early component returns are not supported in v1");
  const returned = directReturns[0]!.argument;
  if (!t.isJSXElement(returned) && !t.isJSXFragment(returned)) {
    codeFrame(compiler, directReturns[0]!, "The final component return must be JSX");
  }
  const setup = declaration.body.body.slice(0, -1);
  const signals = findSignalNames(setup);
  const parameterCode = parameter ? generate(parameter).code : "__ff_props";
  const body = compileBlockBody(compiler, returned, signals, new Map());
  return {
    header: `${exported ? "export " : ""}const ${name} = __ff_component((${parameterCode}) => {`,
    body,
    finalReturn: directReturns[0]!,
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
  const compiler: CompilerContext = { filename, source, templates: [] };
  const edits: Edit[] = [];
  const compiledJsxRanges: Array<{ start: number; end: number }> = [];

  for (const statement of ast.program.body) {
    if (t.isFunctionDeclaration(statement) && statement.id && isPascalCase(statement.id.name)) {
      const compiled = compileFunction(compiler, statement, false);
      const returned = compiled.finalReturn.argument;
      edits.push(
        { start: statement.start!, end: statement.body.start! + 1, code: compiled.header },
        { start: compiled.finalReturn.start!, end: compiled.finalReturn.end!, code: compiled.body },
        { start: statement.body.end! - 1, end: statement.end!, code: "});" },
      );
      if (returned?.start != null && returned.end != null) compiledJsxRanges.push({ start: returned.start, end: returned.end });
    } else if (
      t.isExportNamedDeclaration(statement)
      && t.isFunctionDeclaration(statement.declaration)
      && statement.declaration.id
      && isPascalCase(statement.declaration.id.name)
    ) {
      const compiled = compileFunction(compiler, statement.declaration, true);
      const returned = compiled.finalReturn.argument;
      edits.push(
        { start: statement.start!, end: statement.declaration.body.start! + 1, code: compiled.header },
        { start: compiled.finalReturn.start!, end: compiled.finalReturn.end!, code: compiled.body },
        { start: statement.declaration.body.end! - 1, end: statement.end!, code: "});" },
      );
      if (returned?.start != null && returned.end != null) compiledJsxRanges.push({ start: returned.start, end: returned.end });
    }
  }

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
      codeFrame(compiler, survivingJsx, "JSX must be returned from a top-level PascalCase function component");
    }
    return { code: source, map: null };
  }

  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      const covered = compiledJsxRanges.some((range) => path.node.start! >= range.start && path.node.end! <= range.end);
      if (!covered) codeFrame(compiler, path.node, "JSX survived compilation; use a top-level PascalCase function declaration");
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      const covered = compiledJsxRanges.some((range) => path.node.start! >= range.start && path.node.end! <= range.end);
      if (!covered) codeFrame(compiler, path.node, "JSX survived compilation; use a top-level PascalCase function declaration");
    },
  });

  const transformedSource = new MagicString(source);
  for (const edit of edits) transformedSource.overwrite(edit.start, edit.end, edit.code);
  const templates = compiler.templates
    .map((html, index) => `const __ff_template_${index} = __ff_template(\`${escapeTemplate(html)}\`);`)
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
    map: transformedSource.generateMap({
      hires: true,
      source: filename,
      includeContent: true,
    }),
  };
}
