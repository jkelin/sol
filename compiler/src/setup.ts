import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import { generate, traverse } from "./ast.ts";
import {
  bindingRoot,
  expressionCode,
  reactiveHelperCall,
  referencedNames,
  statementCode,
  unwrapTransparentExpression,
  validateErasedFunctionScope,
  validateReservedIdentifier,
  type ReactiveKind,
} from "./codegen.ts";
import {
  nextAsyncSite,
  useRuntimeHelper,
  type CompiledFunction,
  type CompilerContext,
  type Scope,
} from "./context.ts";
import { codeFrame, mappedCode } from "./diagnostics.ts";
import { compileBlockBody } from "./jsx.ts";

const mutatingCollectionMethods = new Set([
  "add",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "set",
  "unshift",
]);
const globalMutationMethods = new Map([
  [
    "Object",
    new Set([
      "assign",
      "defineProperties",
      "defineProperty",
      "freeze",
      "preventExtensions",
      "seal",
      "setPrototypeOf",
    ]),
  ],
  [
    "Reflect",
    new Set(["defineProperty", "deleteProperty", "preventExtensions", "set", "setPrototypeOf"]),
  ],
]);

type MemberLike = t.MemberExpression | t.OptionalMemberExpression;

function memberMethodName(member: MemberLike): string | undefined {
  if (!member.computed && t.isIdentifier(member.property)) return member.property.name;
  if (member.computed && t.isStringLiteral(member.property)) return member.property.value;
  if (
    member.computed &&
    t.isTemplateLiteral(member.property) &&
    member.property.expressions.length === 0
  ) {
    return member.property.quasis[0]?.value.cooked ?? member.property.quasis[0]?.value.raw;
  }
  return undefined;
}

function isMemberLike(node: t.Node | null | undefined): node is MemberLike {
  return t.isMemberExpression(node) || t.isOptionalMemberExpression(node);
}

interface MutatingCall {
  target: t.Expression;
  kind: "collection" | "global";
}

function mutatingCall(
  path: NodePath,
  call: t.CallExpression | t.OptionalCallExpression,
  componentBindings?: ReadonlySet<string>,
): MutatingCall | undefined {
  if (!isMemberLike(call.callee) || !t.isExpression(call.callee.object)) return undefined;
  const method = memberMethodName(call.callee) ?? "";
  if (t.isIdentifier(call.callee.object)) {
    const methods = globalMutationMethods.get(call.callee.object.name);
    const [target] = call.arguments;
    if (
      methods?.has(method) &&
      !path.scope.getBinding(call.callee.object.name) &&
      !componentBindings?.has(call.callee.object.name) &&
      target &&
      t.isExpression(target)
    ) {
      return { target, kind: "global" };
    }
  }
  return mutatingCollectionMethods.has(method)
    ? { target: call.callee.object, kind: "collection" }
    : undefined;
}

function assignmentMemberTargets(node: t.Node, targets: t.Expression[] = []): t.Expression[] {
  if (t.isMemberExpression(node)) {
    targets.push(node);
  } else if (
    t.isTSAsExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSNonNullExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTypeCastExpression(node)
  ) {
    assignmentMemberTargets(node.expression, targets);
  } else if (t.isObjectPattern(node)) {
    for (const property of node.properties) {
      assignmentMemberTargets(
        t.isRestElement(property) ? property.argument : property.value,
        targets,
      );
    }
  } else if (t.isArrayPattern(node)) {
    for (const element of node.elements) {
      if (element) assignmentMemberTargets(element, targets);
    }
  } else if (t.isAssignmentPattern(node)) {
    assignmentMemberTargets(node.left, targets);
  } else if (t.isRestElement(node)) {
    assignmentMemberTargets(node.argument, targets);
  }
  return targets;
}

export function reactiveCallCode(
  call: t.CallExpression,
  runtimeName: "__sol_signal" | "__sol_computed",
  scope: Scope,
  extraArgument?: string,
): string {
  const cloned = t.cloneNode(call, true);
  cloned.callee = t.identifier(runtimeName);
  if (extraArgument) cloned.arguments.push(t.identifier(extraArgument));
  return expressionCode(cloned, scope);
}

export function typeParameterCode(identifier: t.Identifier): string {
  return identifier.typeAnnotation && t.isTSTypeAnnotation(identifier.typeAnnotation)
    ? `<${generate(identifier.typeAnnotation.typeAnnotation).code}>`
    : "";
}

export function validateComputedWrites(
  compiler: CompilerContext,
  setup: t.Statement[],
  bindings: ReadonlyMap<string, ReactiveKind>,
  returned?: t.JSXElement | t.JSXFragment,
): void {
  const returnedStatement = returned
    ? t.expressionStatement(t.cloneNode(returned, true))
    : undefined;
  const file = t.file(
    t.program([
      ...setup.map((statement) => t.cloneNode(statement, true)),
      ...(returnedStatement ? [returnedStatement] : []),
    ]),
  );
  const check = (path: NodePath, expression: t.Expression): void => {
    const root = bindingRoot(expression);
    if (!root || bindings.get(root) !== "computed") return;
    const binding = path.scope.getBinding(root);
    if (binding?.scope.path.isProgram()) {
      codeFrame(compiler, expression, `Computed component value ${root} is readonly`);
    }
  };
  const checkAssignmentTarget = (path: NodePath, target: t.Node): void => {
    if (t.isExpression(target)) {
      check(path, target);
      return;
    }
    for (const member of assignmentMemberTargets(target)) check(path, member);
    const reactiveBinding = Object.keys(t.getBindingIdentifiers(target)).find((name) => {
      if (!bindings.has(name)) return false;
      return path.scope.getBinding(name)?.scope.path.isProgram();
    });
    const insideReturned =
      returnedStatement && path.findParent((candidate) => candidate.node === returnedStatement);
    if (reactiveBinding && !insideReturned) {
      codeFrame(
        compiler,
        target,
        "Component setup assignments must not destructure reactive bindings; destructuring is not reactive in v1",
      );
    }
  };
  traverse(file, {
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      checkAssignmentTarget(path, path.node.left);
    },
    ForOfStatement(path: NodePath<t.ForOfStatement>) {
      if (!t.isVariableDeclaration(path.node.left)) checkAssignmentTarget(path, path.node.left);
    },
    ForInStatement(path: NodePath<t.ForInStatement>) {
      if (!t.isVariableDeclaration(path.node.left)) checkAssignmentTarget(path, path.node.left);
    },
    UpdateExpression(path: NodePath<t.UpdateExpression>) {
      if (t.isExpression(path.node.argument)) check(path, path.node.argument);
    },
    UnaryExpression(path: NodePath<t.UnaryExpression>) {
      if (path.node.operator === "delete") check(path, path.node.argument);
    },
    CallExpression(path: NodePath<t.CallExpression>) {
      const mutation = mutatingCall(path, path.node);
      if (mutation) check(path, mutation.target);
    },
    OptionalCallExpression(path: NodePath<t.OptionalCallExpression>) {
      const mutation = mutatingCall(path, path.node);
      if (mutation) check(path, mutation.target);
    },
  });
}

function validateConstSignalWrites(
  compiler: CompilerContext,
  setup: t.Statement[],
  names: ReadonlySet<string>,
): void {
  if (names.size === 0) return;
  const file = t.file(t.program(setup.map((statement) => t.cloneNode(statement, true))));
  const check = (path: NodePath, target: t.Node): void => {
    const name = Object.keys(t.getBindingIdentifiers(target)).find(
      (candidate) =>
        names.has(candidate) && path.scope.getBinding(candidate)?.scope.path.isProgram(),
    );
    if (name) {
      codeFrame(compiler, target, `Component setup const binding ${name} cannot be reassigned`);
    }
  };
  traverse(file, {
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      check(path, path.node.left);
    },
    UpdateExpression(path: NodePath<t.UpdateExpression>) {
      check(path, path.node.argument);
    },
    ForOfStatement(path: NodePath<t.ForOfStatement>) {
      if (!t.isVariableDeclaration(path.node.left)) check(path, path.node.left);
    },
    ForInStatement(path: NodePath<t.ForInStatement>) {
      if (!t.isVariableDeclaration(path.node.left)) check(path, path.node.left);
    },
  });
}

export function validatePropWrites(
  compiler: CompilerContext,
  body: t.BlockStatement,
  propsName: string | undefined,
): void {
  if (!propsName) return;
  const clonedComponent = t.functionExpression(null, [], t.cloneNode(body, true));
  const file = t.file(t.program([t.expressionStatement(clonedComponent)]));
  const isDirectPropMember = (path: NodePath, expression: t.Expression): boolean => {
    if (!t.isMemberExpression(expression) && !t.isOptionalMemberExpression(expression))
      return false;
    const object = t.isExpression(expression.object)
      ? unwrapTransparentExpression(expression.object)
      : expression.object;
    return t.isIdentifier(object, { name: propsName }) && !path.scope.getBinding(propsName);
  };
  const reject = (node: t.Node): never =>
    codeFrame(
      compiler,
      node,
      `Component props are readonly; ${propsName} members cannot be assigned directly`,
    );
  const checkMutatingCall = (
    path: NodePath,
    call: t.CallExpression | t.OptionalCallExpression,
  ): void => {
    const mutation = mutatingCall(path, call);
    const target = mutation?.kind === "global" ? mutation.target : undefined;
    if (
      target &&
      t.isIdentifier(unwrapTransparentExpression(target), { name: propsName }) &&
      !path.scope.getBinding(propsName)
    ) {
      reject(target);
    }
  };

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
      checkMutatingCall(path, path.node);
    },
    OptionalCallExpression(path: NodePath<t.OptionalCallExpression>) {
      checkMutatingCall(path, path.node);
    },
  });
}

export function validateDerivedInitializer(
  compiler: CompilerContext,
  expression: t.Expression,
  componentBindings: ReadonlySet<string>,
): void {
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
      const mutation = mutatingCall(path, path.node, componentBindings);
      if (mutation)
        codeFrame(
          compiler,
          path.node,
          mutation.kind === "global"
            ? "Derived component initializers must not call global mutation APIs"
            : "Derived component initializers must not call mutating collection methods",
        );
    },
    OptionalCallExpression(path: NodePath<t.OptionalCallExpression>) {
      const mutation = mutatingCall(path, path.node, componentBindings);
      if (mutation) {
        codeFrame(
          compiler,
          path.node,
          mutation.kind === "global"
            ? "Derived component initializers must not call global mutation APIs"
            : "Derived component initializers must not call mutating collection methods",
        );
      }
    },
  });
}

export function compileSetup(
  compiler: CompilerContext,
  setup: t.Statement[],
  propsName: string | undefined,
  returned?: t.JSXElement | t.JSXFragment,
): { bindings: Map<string, ReactiveKind>; code: string; scope: Map<string, string> } {
  const bindings = new Map<string, ReactiveKind>();
  const declarationKinds = new WeakMap<
    t.VariableDeclarator,
    ReactiveKind | "function" | "stable"
  >();
  const stablePrimitiveNames = new Set<string>();
  const constSignalNames = new Set<string>();
  const remainingDataNames = new Set<string>();
  const componentBindingNames = new Set<string>();
  for (const statement of setup) {
    if (t.isVariableDeclaration(statement)) {
      if (statement.kind !== "let" && statement.kind !== "const") {
        codeFrame(
          compiler,
          statement,
          "Component setup declarations must use let or const; var, using, and await using are not supported",
        );
      }
      for (const declaration of statement.declarations) {
        for (const name of Object.keys(t.getBindingIdentifiers(declaration.id))) {
          componentBindingNames.add(name);
          if (t.isIdentifier(declaration.id)) remainingDataNames.add(name);
        }
      }
    } else if (
      (t.isFunctionDeclaration(statement) || t.isClassDeclaration(statement)) &&
      statement.id
    ) {
      componentBindingNames.add(statement.id.name);
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
      if (t.isCallExpression(initializer) && compiler.refCreatorCalls.has(initializer)) {
        declarationKinds.set(declaration, "stable");
        continue;
      }
      const unwrappedInitializer =
        initializer && t.isExpression(initializer)
          ? unwrapTransparentExpression(initializer)
          : undefined;
      if (
        statement.kind === "const" &&
        unwrappedInitializer &&
        t.isCallExpression(unwrappedInitializer) &&
        compiler.requestControllerCalls.has(unwrappedInitializer)
      ) {
        declarationKinds.set(declaration, "controller");
        bindings.set(declaration.id.name, "controller");
        constSignalNames.add(declaration.id.name);
        continue;
      }
      if (
        statement.kind === "const" &&
        unwrappedInitializer &&
        (t.isStringLiteral(unwrappedInitializer) ||
          t.isNumericLiteral(unwrappedInitializer) ||
          t.isBooleanLiteral(unwrappedInitializer) ||
          t.isNullLiteral(unwrappedInitializer) ||
          t.isBigIntLiteral(unwrappedInitializer))
      ) {
        declarationKinds.set(declaration, "stable");
        stablePrimitiveNames.add(declaration.id.name);
        continue;
      }
      const expression = initializer && t.isExpression(initializer) ? initializer : undefined;
      const references = expression ? referencedNames(expression) : undefined;
      if (references?.has(declaration.id.name)) {
        codeFrame(
          compiler,
          expression!,
          `Reactive component declaration ${declaration.id.name} cannot reference itself`,
        );
      }
      if (references) {
        const forwardReference = [...references].find((name) => remainingDataNames.has(name));
        if (forwardReference) {
          codeFrame(
            compiler,
            expression!,
            `Reactive component declarations cannot reference later binding ${forwardReference}`,
          );
        }
      }
      const kind: ReactiveKind = reactiveHelperCall(compiler, initializer, "$computed")
        ? "computed"
        : reactiveHelperCall(compiler, initializer, "$signal")
          ? "signal"
          : t.isAwaitExpression(initializer)
            ? "signal"
            : statement.kind === "const" &&
                references &&
                [...references].some((name) => name === propsName || bindings.has(name))
              ? "computed"
              : "signal";
      declarationKinds.set(declaration, kind);
      bindings.set(declaration.id.name, kind);
      if (statement.kind === "const" && kind === "signal") {
        constSignalNames.add(declaration.id.name);
      }
      if (
        kind === "computed" &&
        initializer &&
        !reactiveHelperCall(compiler, initializer, "$computed")
      ) {
        validateDerivedInitializer(compiler, initializer, componentBindingNames);
      }
    }
  }

  const validatedStatements = returned ? [...setup, t.expressionStatement(returned)] : setup;
  validateConstSignalWrites(compiler, validatedStatements, constSignalNames);
  validateComputedWrites(compiler, setup, bindings, returned);
  const scope = new Map<string, string>();
  for (const [name, kind] of bindings) {
    scope.set(name, kind === "controller" ? name : `${name}.value`);
  }
  for (const name of stablePrimitiveNames) scope.set(name, name);
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
      if (kind === "function" || kind === "stable" || kind === "controller") {
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
      const signalCall = reactiveHelperCall(compiler, initializer, "$signal");
      const computedCall = reactiveHelperCall(compiler, initializer, "$computed");
      if (kind === "signal" && signalCall) {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = ${reactiveCallCode(signalCall, useRuntimeHelper(compiler, "__sol_signal"), scope)};`,
          ),
        );
      } else if (kind === "computed" && computedCall) {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = ${reactiveCallCode(computedCall, useRuntimeHelper(compiler, "__sol_computed"), scope, "__sol_frame")};`,
          ),
        );
      } else if (kind === "computed") {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = ${useRuntimeHelper(compiler, "__sol_computed")}${typeParameterCode(identifier)}(() => (${expressionCode(initializer, scope)}), __sol_frame);`,
          ),
        );
      } else {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = ${useRuntimeHelper(compiler, "__sol_signal")}${typeParameterCode(identifier)}(${expressionCode(initializer, scope)});`,
          ),
        );
      }
    }
  }
  return { bindings, code: generated.join("\n"), scope };
}

export function compileFunction(
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
  if (declaration.generator)
    codeFrame(compiler, declaration, "Components must not be generator functions");
  validateErasedFunctionScope(compiler, declaration, true);
  validateReplayableAsyncIteration(compiler, declaration);
  instrumentRequestSources(compiler, declaration);
  instrumentAwaitExpressions(compiler, declaration);
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
  const compiledSetup = compileSetup(compiler, setup, parameter?.name, returned);
  const parameterCode = parameter ? generate(parameter).code : "__sol_props";
  const previousPropsName = compiler.propsName;
  compiler.propsName = parameter?.name;
  const body = compileBlockBody(compiler, returned, compiledSetup.bindings, compiledSetup.scope);
  compiler.propsName = previousPropsName;
  useRuntimeHelper(compiler, "__sol_component");
  return {
    code: `${exported ? "export " : ""}const ${name} = ${compiler.routeMode === "handle" ? "/*#__PURE__*/ " : ""}__sol_component(${declaration.async ? "async " : ""}(${parameterCode}, __sol_frame) => {
      ${compiledSetup.code}
      ${body}
    }, { name: ${JSON.stringify(name)}, file: ${JSON.stringify(compiler.filename)}, line: ${declaration.loc?.start.line ?? 0} });`,
    returned,
  };
}

function instrumentRequestSources(
  compiler: CompilerContext,
  declaration: t.FunctionExpression,
): void {
  const file = t.file(t.program([t.expressionStatement(declaration)]));
  traverse(file, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const call = path.node;
      const helper = t.isIdentifier(call.callee)
        ? compiler.requestHelpers.get(call.callee.name)
        : undefined;
      if (!t.isIdentifier(call.callee) || !helper || path.scope.getBinding(call.callee.name)) {
        return;
      }
      compiler.requestControllerCalls.add(call);
      if (helper === "$form") {
        useRuntimeHelper(compiler, "__sol_form");
        call.arguments.unshift(t.identifier("__sol_frame"));
        call.callee = t.identifier("__sol_form");
        return;
      }
      const config = call.arguments[0];
      if (!config || !t.isExpression(config)) return;
      useRuntimeHelper(compiler, "__sol_request_source");
      useRuntimeHelper(compiler, helper === "$query" ? "__sol_query" : "__sol_mutation");
      call.arguments[0] = t.callExpression(t.identifier("__sol_request_source"), [
        config,
        t.objectExpression([
          t.objectProperty(t.identifier("file"), t.stringLiteral(compiler.filename)),
          t.objectProperty(t.identifier("line"), t.numericLiteral(call.loc?.start.line ?? 0)),
          t.objectProperty(t.identifier("column"), t.numericLiteral(call.loc?.start.column ?? 0)),
        ]),
      ]);
      call.arguments.splice(1, 0, t.identifier("__sol_frame"));
      call.callee = t.identifier(helper === "$query" ? "__sol_query" : "__sol_mutation");
    },
  });
}

function ancestorWithinFunction<T extends t.Node>(
  path: NodePath,
  matches: (candidate: NodePath) => candidate is NodePath<T>,
): NodePath<T> | undefined {
  const owner = path.getFunctionParent();
  for (
    let candidate = path.parentPath;
    candidate && candidate !== owner;
    candidate = candidate.parentPath
  ) {
    if (matches(candidate)) return candidate;
  }
  return undefined;
}

function instrumentContextCall(
  compiler: CompilerContext,
  path: NodePath<t.CallExpression | t.OptionalCallExpression>,
  optionalMethod: boolean,
): void {
  if (path.node.arguments.length !== 0) return;
  const callee = path.node.callee;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) return;
  if (!t.isExpression(callee.object)) return;
  const method = !callee.computed
    ? t.isIdentifier(callee.property)
      ? callee.property.name
      : undefined
    : t.isStringLiteral(callee.property)
      ? callee.property.value
      : undefined;
  if (method !== "use" && method !== "useOptional") return;
  const optionalCandidate = t.isOptionalMemberExpression(callee) && callee.optional;
  let outer: NodePath<t.Expression> | undefined;
  if (optionalCandidate || optionalMethod) {
    const extent = optionalChainExtent(path as NodePath<t.Expression>);
    if (extent.outer !== path) outer = extent.outer;
    const parent = outer?.parentPath?.node ?? path.parentPath?.node;
    if (
      (!outer &&
        (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
        parent.callee === path.node) ||
      (t.isTaggedTemplateExpression(parent) && parent.tag === (outer?.node ?? path.node)) ||
      (t.isUnaryExpression(parent, { operator: "delete" }) &&
        parent.argument === (outer?.node ?? path.node))
    ) {
      return;
    }
  }
  const callArguments: t.Expression[] = [
    callee.object,
    t.identifier("__sol_frame"),
    t.booleanLiteral(method === "useOptional"),
  ];
  if (optionalCandidate || optionalMethod) {
    callArguments.push(t.booleanLiteral(optionalCandidate), t.booleanLiteral(optionalMethod));
  }
  if (outer) {
    useRuntimeHelper(compiler, "__sol_context_use");
    const value = t.identifier("__sol_context_value");
    callArguments.push(
      t.arrowFunctionExpression([value], replaceOptionalChainBase(outer.node, path.node, value)),
    );
    outer.replaceWith(t.callExpression(t.identifier("__sol_context_use"), callArguments));
    outer.skip();
  } else {
    useRuntimeHelper(compiler, "__sol_context_use");
    path.replaceWith(t.callExpression(t.identifier("__sol_context_use"), callArguments));
    path.skip();
  }
}

function instrumentContextMethod(
  compiler: CompilerContext,
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
): void {
  if (!path.isReferenced() || !t.isExpression(path.node.object)) return;
  const method = staticMemberName(path.node);
  if (method !== "use" && method !== "useOptional") return;
  const optionalCandidate = t.isOptionalMemberExpression(path.node) && path.node.optional;
  const extent = optionalCandidate
    ? optionalChainExtent(path as NodePath<t.Expression>)
    : undefined;
  const outer = extent && extent.outer !== path ? extent.outer : undefined;
  const parent = outer?.parentPath?.node ?? path.parentPath?.node;
  if (
    (!outer &&
      (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
      parent.callee === path.node) ||
    (t.isTaggedTemplateExpression(parent) && parent.tag === (outer?.node ?? path.node)) ||
    (t.isUnaryExpression(parent, { operator: "delete" }) &&
      parent.argument === (outer?.node ?? path.node))
  ) {
    return;
  }
  const callArguments: t.Expression[] = [
    path.node.object,
    t.stringLiteral(method),
    t.identifier("__sol_frame"),
  ];
  if (optionalCandidate) {
    callArguments.push(t.booleanLiteral(true));
  }
  if (outer) {
    useRuntimeHelper(compiler, "__sol_context_method");
    const value = t.identifier("__sol_context_method_value");
    callArguments.push(
      t.arrowFunctionExpression([value], replaceOptionalChainBase(outer.node, path.node, value)),
    );
    outer.replaceWith(t.callExpression(t.identifier("__sol_context_method"), callArguments));
    outer.skip();
  } else {
    useRuntimeHelper(compiler, "__sol_context_method");
    path.replaceWith(t.callExpression(t.identifier("__sol_context_method"), callArguments));
    path.skip();
  }
}

function optionalChainExtent(path: NodePath<t.Expression>): {
  outer: NodePath<t.Expression>;
  hasMemberContinuation: boolean;
} {
  let outer = path;
  let hasMemberContinuation = false;
  for (;;) {
    const parent = outer.parentPath;
    if (
      parent &&
      (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
      parent.node.object === outer.node
    ) {
      outer = parent as NodePath<t.Expression>;
      hasMemberContinuation = true;
      continue;
    }
    if (
      hasMemberContinuation &&
      parent &&
      (parent.isCallExpression() || parent.isOptionalCallExpression()) &&
      parent.node.callee === outer.node
    ) {
      outer = parent as NodePath<t.Expression>;
      continue;
    }
    break;
  }
  return { outer, hasMemberContinuation };
}

function staticMemberName(
  member: t.MemberExpression | t.OptionalMemberExpression,
): string | undefined {
  return memberMethodName(member);
}

function replaceOptionalChainBase(
  expression: t.Expression,
  target: t.Expression,
  replacement: t.Identifier,
): t.Expression {
  if (expression === target) return replacement;
  if (t.isMemberExpression(expression) || t.isOptionalMemberExpression(expression)) {
    if (!t.isExpression(expression.object)) throw new Error("Expected a member expression object");
    const cloned = t.cloneNode(expression, false);
    cloned.object = replaceOptionalChainBase(expression.object, target, replacement);
    return cloned;
  }
  if (t.isCallExpression(expression) || t.isOptionalCallExpression(expression)) {
    if (!t.isExpression(expression.callee)) throw new Error("Expected a call expression callee");
    const cloned = t.cloneNode(expression, false);
    cloned.callee = replaceOptionalChainBase(expression.callee, target, replacement);
    return cloned;
  }
  throw new Error("Expected a direct optional expression chain");
}

function instrumentAwaitExpressions(
  compiler: CompilerContext,
  declaration: t.FunctionExpression,
): void {
  const file = t.file(t.program([t.expressionStatement(declaration)]));
  type LocalFunction = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;
  const functionsByIdentifier = new WeakMap<t.Identifier, LocalFunction>();
  const localFunctions = new Set<LocalFunction>();
  traverse(file, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (!path.node.id) return;
      functionsByIdentifier.set(path.node.id, path.node);
      localFunctions.add(path.node);
    },
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (
        t.isIdentifier(path.node.id) &&
        (t.isFunctionExpression(path.node.init) || t.isArrowFunctionExpression(path.node.init))
      ) {
        functionsByIdentifier.set(path.node.id, path.node.init);
        localFunctions.add(path.node.init);
      }
    },
  });

  const callTargets = new WeakMap<t.CallExpression, LocalFunction>();
  const callsByOwner = new Map<LocalFunction | t.FunctionExpression, Set<LocalFunction>>();
  const targetForCall = (path: NodePath<t.CallExpression>): LocalFunction | undefined => {
    if (!t.isIdentifier(path.node.callee)) return undefined;
    const binding = path.scope.getBinding(path.node.callee.name);
    return binding ? functionsByIdentifier.get(binding.identifier) : undefined;
  };
  const reachable = new Set<LocalFunction>();
  traverse(file, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const target = targetForCall(path);
      if (!target) return;
      callTargets.set(path.node, target);
      const owner = path.getFunctionParent()?.node;
      if (owner === declaration || localFunctions.has(owner as LocalFunction)) {
        const calls = callsByOwner.get(owner as LocalFunction | t.FunctionExpression) ?? new Set();
        calls.add(target);
        callsByOwner.set(owner as LocalFunction | t.FunctionExpression, calls);
      }
      const awaited = ancestorWithinFunction(
        path,
        (candidate): candidate is NodePath<t.AwaitExpression> => candidate.isAwaitExpression(),
      );
      if (owner === declaration && awaited) {
        reachable.add(target);
      }
    },
  });
  const awaitedInitializers = new WeakMap<t.AwaitExpression, t.VariableDeclarator>();
  const awaitedInitializerDeclarations = new WeakSet<t.VariableDeclarator>();
  traverse(file, {
    AwaitExpression(path: NodePath<t.AwaitExpression>) {
      if (path.getFunctionParent()?.node !== declaration) return;
      const argument = unwrapTransparentExpression(path.node.argument);
      if (!t.isIdentifier(argument)) return;
      const binding = path.scope.getBinding(argument.name);
      if (!binding?.constant || !binding.path.isVariableDeclarator()) return;
      const variable = binding.path.node;
      if (!t.isExpression(variable.init)) return;
      awaitedInitializers.set(path.node, variable);
      awaitedInitializerDeclarations.add(variable);
      if (t.isCallExpression(variable.init)) {
        const helper = callTargets.get(variable.init);
        if (helper) reachable.add(helper);
      }
    },
  });
  const queue = [...reachable];
  for (let index = 0; index < queue.length; index += 1) {
    for (const helper of callsByOwner.get(queue[index]!) ?? []) {
      if (reachable.has(helper)) continue;
      reachable.add(helper);
      queue.push(helper);
    }
  }

  const ownAwait = new Set<LocalFunction>();
  traverse(file, {
    AwaitExpression(path: NodePath<t.AwaitExpression>) {
      const owner = path.getFunctionParent()?.node;
      if (owner && owner !== declaration && reachable.has(owner as LocalFunction)) {
        ownAwait.add(owner as LocalFunction);
      }
    },
  });
  const callersByHelper = new Map<LocalFunction, Set<LocalFunction>>();
  for (const caller of reachable) {
    for (const called of callsByOwner.get(caller) ?? []) {
      if (!reachable.has(called)) continue;
      const callers = callersByHelper.get(called) ?? new Set();
      callers.add(caller);
      callersByHelper.set(called, callers);
    }
  }
  const capturedAwaitHelpers = new Set(ownAwait);
  const capturedQueue = [...ownAwait];
  for (let index = 0; index < capturedQueue.length; index += 1) {
    for (const caller of callersByHelper.get(capturedQueue[index]!) ?? []) {
      if (capturedAwaitHelpers.has(caller)) continue;
      capturedAwaitHelpers.add(caller);
      capturedQueue.push(caller);
    }
  }

  const directlyAwaitedHelper = (argument: t.Expression): LocalFunction | undefined => {
    const expression = unwrapTransparentExpression(argument);
    if (!t.isCallExpression(expression) || !t.isIdentifier(expression.callee)) return undefined;
    return callTargets.get(expression);
  };

  const capturedHelperAggregate = (
    path: NodePath<t.AwaitExpression>,
    argument: t.Expression,
  ): boolean => {
    const expression = unwrapTransparentExpression(argument);
    if (
      path.scope.getBinding("Promise") ||
      !t.isCallExpression(expression) ||
      !t.isMemberExpression(expression.callee) ||
      expression.callee.computed ||
      !t.isIdentifier(expression.callee.object, { name: "Promise" }) ||
      !t.isIdentifier(expression.callee.property, { name: "all" }) ||
      expression.arguments.length !== 1 ||
      !t.isArrayExpression(expression.arguments[0]) ||
      expression.arguments[0].elements.length === 0
    ) {
      return false;
    }
    return expression.arguments[0].elements.every((element) => {
      if (!element || t.isSpreadElement(element)) return false;
      const helper = directlyAwaitedHelper(element);
      return helper !== undefined && capturedAwaitHelpers.has(helper);
    });
  };

  const capturedInitializers = new WeakSet<t.VariableDeclarator>();
  traverse(file, {
    AwaitExpression(path: NodePath<t.AwaitExpression>) {
      const owner = path.getFunctionParent()?.node;
      if (owner !== declaration && !reachable.has(owner as LocalFunction)) return;
      const argument = path.node.argument;
      const initializer = awaitedInitializers.get(path.node);
      if (initializer && t.isExpression(initializer.init)) {
        const helper = t.isCallExpression(initializer.init)
          ? callTargets.get(initializer.init)
          : undefined;
        if (!(helper && capturedAwaitHelpers.has(helper))) {
          if (!capturedInitializers.has(initializer)) {
            useRuntimeHelper(compiler, "__sol_async_value");
            initializer.init = t.callExpression(t.identifier("__sol_async_value"), [
              t.identifier("__sol_frame"),
              t.stringLiteral(nextAsyncSite(compiler)),
              t.arrowFunctionExpression([], initializer.init),
            ]);
            capturedInitializers.add(initializer);
          }
        }
        return;
      }
      const helper = directlyAwaitedHelper(argument);
      if (helper && capturedAwaitHelpers.has(helper)) return;
      if (capturedHelperAggregate(path, argument)) return;
      useRuntimeHelper(compiler, "__sol_async_value");
      const captured = t.callExpression(t.identifier("__sol_async_value"), [
        t.identifier("__sol_frame"),
        t.stringLiteral(nextAsyncSite(compiler)),
        t.arrowFunctionExpression([], argument),
      ]);
      path.node.argument =
        owner === declaration
          ? captured
          : t.conditionalExpression(t.identifier("__sol_capture_enabled"), captured, argument);
      path.skip();
    },
  });

  for (const helper of reachable) {
    if (!capturedAwaitHelpers.has(helper)) continue;
    useRuntimeHelper(compiler, "__sol_async_capture_active");
    if (t.isArrowFunctionExpression(helper) && !t.isBlockStatement(helper.body)) {
      helper.body = t.blockStatement([t.returnStatement(helper.body)]);
    }
    if (!t.isBlockStatement(helper.body)) continue;
    helper.body.body.unshift(
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.identifier("__sol_capture_enabled"),
          t.callExpression(t.identifier("__sol_async_capture_active"), []),
        ),
      ]),
    );
  }

  traverse(file, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const helper = callTargets.get(path.node);
      if (!helper || !capturedAwaitHelpers.has(helper)) return;
      const owner = path.getFunctionParent()?.node;
      const awaited = ancestorWithinFunction(
        path,
        (candidate): candidate is NodePath<t.AwaitExpression> => candidate.isAwaitExpression(),
      );
      const awaitedOwner = awaited ? owner : undefined;
      const initializer = ancestorWithinFunction(
        path,
        (candidate): candidate is NodePath<t.VariableDeclarator> =>
          candidate.isVariableDeclarator(),
      );
      const returned = ancestorWithinFunction(
        path,
        (candidate): candidate is NodePath<t.ReturnStatement> => candidate.isReturnStatement(),
      );
      const capture = Boolean(
        awaitedOwner === declaration ||
        (awaitedOwner !== undefined && reachable.has(awaitedOwner as LocalFunction)) ||
        (initializer?.isVariableDeclarator() &&
          awaitedInitializerDeclarations.has(initializer.node)) ||
        (returned?.isReturnStatement() && reachable.has(owner as LocalFunction)),
      );
      const captureExpression =
        capture && owner !== declaration && reachable.has(owner as LocalFunction)
          ? t.identifier("__sol_capture_enabled")
          : t.booleanLiteral(capture);
      const call = path.node;
      useRuntimeHelper(compiler, "__sol_async_capture_call");
      path.replaceWith(
        t.callExpression(t.identifier("__sol_async_capture_call"), [
          t.arrowFunctionExpression([], call),
          captureExpression,
        ]),
      );
      path.skip();
    },
  });

  traverse(file, {
    CallExpression(path: NodePath<t.CallExpression>) {
      instrumentContextCall(compiler, path, false);
    },
    OptionalCallExpression(path: NodePath<t.OptionalCallExpression>) {
      instrumentContextCall(compiler, path, path.node.optional);
    },
    MemberExpression(path: NodePath<t.MemberExpression>) {
      instrumentContextMethod(compiler, path);
    },
    OptionalMemberExpression(path: NodePath<t.OptionalMemberExpression>) {
      instrumentContextMethod(compiler, path);
    },
  });

  if (!declaration.async) return;
  const routeReadKeys = new Set([
    "pathname",
    "search",
    "hash",
    "searchParams",
    "params",
    "query",
    "route",
    "isActive",
    "isActivePrefix",
  ]);
  const isProvablyOrdinaryRouteObject = (path: NodePath, expression: t.Expression): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    if (
      t.isObjectExpression(candidate) ||
      t.isArrayExpression(candidate) ||
      t.isFunctionExpression(candidate) ||
      t.isArrowFunctionExpression(candidate)
    ) {
      return true;
    }
    const signalInitializer = (identifier: t.Identifier): boolean => {
      const binding = path.scope.getBinding(identifier.name);
      if (!binding?.constant || !binding.path.isVariableDeclarator()) return false;
      const initializer = binding.path.node.init;
      if (!initializer || !t.isExpression(initializer)) return false;
      const value = unwrapTransparentExpression(initializer);
      if (
        t.isObjectExpression(value) ||
        t.isArrayExpression(value) ||
        t.isFunctionExpression(value) ||
        t.isArrowFunctionExpression(value)
      ) {
        return true;
      }
      return (
        t.isCallExpression(value) &&
        t.isIdentifier(value.callee, { name: "__sol_signal" }) &&
        value.arguments.length > 0 &&
        t.isExpression(value.arguments[0]) &&
        isProvablyOrdinaryRouteObject(path, value.arguments[0])
      );
    };
    if (t.isIdentifier(candidate)) return signalInitializer(candidate);
    return (
      t.isMemberExpression(candidate) &&
      staticMemberName(candidate) === "value" &&
      t.isIdentifier(candidate.object) &&
      signalInitializer(candidate.object)
    );
  };
  const instrumentRouteRead = (path: NodePath<t.MemberExpression>): void => {
    if (!path.isReferenced() || !t.isExpression(path.node.object)) return;
    if (isProvablyOrdinaryRouteObject(path, path.node.object)) return;
    const parent = path.parentPath?.node;
    if (
      ((t.isCallExpression(parent) ||
        t.isOptionalCallExpression(parent) ||
        t.isNewExpression(parent)) &&
        parent.callee === path.node) ||
      (t.isTaggedTemplateExpression(parent) && parent.tag === path.node)
    ) {
      return;
    }
    const key = staticMemberName(path.node);
    if (!key || !routeReadKeys.has(key)) return;
    const callArguments: t.Expression[] = [
      path.node.object,
      t.stringLiteral(key),
      t.identifier("__sol_frame"),
    ];
    useRuntimeHelper(compiler, "__sol_route_read");
    path.replaceWith(t.callExpression(t.identifier("__sol_route_read"), callArguments));
    path.skip();
  };
  traverse(file, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (!t.isObjectPattern(path.node.id) || !t.isExpression(path.node.init)) return;
      if (isProvablyOrdinaryRouteObject(path, path.node.init)) return;
      useRuntimeHelper(compiler, "__sol_route_object");
      path.node.init = t.callExpression(t.identifier("__sol_route_object"), [
        path.node.init,
        t.identifier("__sol_frame"),
      ]);
    },
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      if (!t.isObjectPattern(path.node.left) || !t.isExpression(path.node.right)) return;
      if (isProvablyOrdinaryRouteObject(path, path.node.right)) return;
      useRuntimeHelper(compiler, "__sol_route_object");
      path.node.right = t.callExpression(t.identifier("__sol_route_object"), [
        path.node.right,
        t.identifier("__sol_frame"),
      ]);
    },
    SpreadElement(path: NodePath<t.SpreadElement>) {
      if (!path.parentPath?.isObjectExpression() || !t.isExpression(path.node.argument)) return;
      if (isProvablyOrdinaryRouteObject(path, path.node.argument)) return;
      useRuntimeHelper(compiler, "__sol_route_object");
      path.node.argument = t.callExpression(t.identifier("__sol_route_object"), [
        path.node.argument,
        t.identifier("__sol_frame"),
      ]);
    },
    MemberExpression(path: NodePath<t.MemberExpression>) {
      instrumentRouteRead(path);
    },
    OptionalMemberExpression(path: NodePath<t.OptionalMemberExpression>) {
      if (!path.node.optional || !t.isExpression(path.node.object)) return;
      if (isProvablyOrdinaryRouteObject(path, path.node.object)) return;
      const key = staticMemberName(path.node);
      if (!key || !routeReadKeys.has(key)) return;
      const { outer, hasMemberContinuation } = optionalChainExtent(path as NodePath<t.Expression>);
      const parent = outer.parentPath?.node;
      if (
        (!hasMemberContinuation &&
          (t.isCallExpression(parent) ||
            t.isOptionalCallExpression(parent) ||
            t.isNewExpression(parent)) &&
          parent.callee === outer.node) ||
        (t.isTaggedTemplateExpression(parent) && parent.tag === outer.node) ||
        (t.isUnaryExpression(parent, { operator: "delete" }) && parent.argument === outer.node)
      ) {
        return;
      }
      const value = t.identifier("__sol_route_value");
      const continuation =
        outer.node === path.node ? value : replaceOptionalChainBase(outer.node, path.node, value);
      useRuntimeHelper(compiler, "__sol_route_read");
      outer.replaceWith(
        t.callExpression(t.identifier("__sol_route_read"), [
          path.node.object,
          t.stringLiteral(key),
          t.identifier("__sol_frame"),
          t.arrowFunctionExpression([value], continuation),
        ]),
      );
      outer.skip();
    },
  });
}

function validateReplayableAsyncIteration(
  compiler: CompilerContext,
  declaration: t.FunctionExpression,
): void {
  traverse(t.file(t.program([t.expressionStatement(declaration)])), {
    ForOfStatement(path: NodePath<t.ForOfStatement>) {
      if (path.node.await) {
        codeFrame(compiler, path.node, "for await...of is not replayable in components");
      }
    },
  });
}
