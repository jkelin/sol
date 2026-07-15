import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import { generate, traverse } from "./ast.ts";
import {
  bindingRoot,
  expressionCode,
  isHelperCall,
  referencedNames,
  referencesReactive,
  statementCode,
  validateReservedIdentifier,
  type ReactiveKind,
} from "./codegen.ts";
import {
  nextAsyncSite,
  type CompiledFunction,
  type CompilerContext,
  type Scope,
} from "./context.ts";
import { codeFrame, mappedCode } from "./diagnostics.ts";
import { compileBlockBody } from "./jsx.ts";

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

export function validatePropWrites(
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

export function validateDerivedInitializer(
  compiler: CompilerContext,
  expression: t.Expression,
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

export function compileSetup(
  compiler: CompilerContext,
  setup: t.Statement[],
  propsName: string | undefined,
): { bindings: Map<string, ReactiveKind>; code: string; scope: Map<string, string> } {
  const bindings = new Map<string, ReactiveKind>();
  const declarationKinds = new WeakMap<
    t.VariableDeclarator,
    ReactiveKind | "function" | "stable"
  >();
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
      if (t.isCallExpression(initializer) && compiler.refCreatorCalls.has(initializer)) {
        declarationKinds.set(declaration, "stable");
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
      const kind: ReactiveKind = isHelperCall(compiler, initializer, "$computed")
        ? "computed"
        : isHelperCall(compiler, initializer, "$signal")
          ? "signal"
          : t.isAwaitExpression(initializer)
            ? "signal"
            : statement.kind === "const" &&
                initializer &&
                referencesReactive(initializer, new Set(bindings.keys()), propsName)
              ? "computed"
              : "signal";
      declarationKinds.set(declaration, kind);
      bindings.set(declaration.id.name, kind);
      if (kind === "computed" && initializer && !isHelperCall(compiler, initializer, "$computed")) {
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
      if (kind === "function" || kind === "stable") {
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
      if (kind === "signal" && isHelperCall(compiler, initializer, "$signal")) {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = ${reactiveCallCode(initializer, "__sol_signal", scope)};`,
          ),
        );
      } else if (kind === "computed" && isHelperCall(compiler, initializer, "$computed")) {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = ${reactiveCallCode(initializer, "__sol_computed", scope, "__sol_frame")};`,
          ),
        );
      } else if (kind === "computed") {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = __sol_computed${typeParameterCode(identifier)}(() => (${expressionCode(initializer, scope)}), __sol_frame);`,
          ),
        );
      } else {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = __sol_signal${typeParameterCode(identifier)}(${expressionCode(initializer, scope)});`,
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
  const compiledSetup = compileSetup(compiler, setup, parameter?.name);
  const parameterCode = parameter ? generate(parameter).code : "__sol_props";
  const previousPropsName = compiler.propsName;
  compiler.propsName = parameter?.name;
  const body = compileBlockBody(compiler, returned, compiledSetup.bindings, compiledSetup.scope);
  compiler.propsName = previousPropsName;
  return {
    code: `${exported ? "export " : ""}const ${name} = __sol_component(${declaration.async ? "async " : ""}(${parameterCode}, __sol_frame) => {
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
      if (!t.isIdentifier(call.callee) || !helper || path.scope.hasBinding(call.callee.name)) {
        return;
      }
      const config = call.arguments[0];
      if (!config || !t.isExpression(config)) return;
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
      let argument = path.node.argument;
      while (
        t.isTSAsExpression(argument) ||
        t.isTSTypeAssertion(argument) ||
        t.isTSNonNullExpression(argument)
      ) {
        argument = argument.expression;
      }
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
  const hasCapturedAwait = (helper: LocalFunction, seen = new Set<LocalFunction>()): boolean => {
    if (ownAwait.has(helper)) return true;
    if (seen.has(helper)) return false;
    seen.add(helper);
    return [...(callsByOwner.get(helper) ?? [])].some(
      (called) => reachable.has(called) && hasCapturedAwait(called, seen),
    );
  };

  const directlyAwaitedHelper = (argument: t.Expression): LocalFunction | undefined => {
    let expression = argument;
    while (
      t.isTSAsExpression(expression) ||
      t.isTSTypeAssertion(expression) ||
      t.isTSNonNullExpression(expression)
    ) {
      expression = expression.expression;
    }
    if (!t.isCallExpression(expression) || !t.isIdentifier(expression.callee)) return undefined;
    return callTargets.get(expression);
  };

  const capturedHelperAggregate = (argument: t.Expression): boolean => {
    let expression = argument;
    while (
      t.isTSAsExpression(expression) ||
      t.isTSTypeAssertion(expression) ||
      t.isTSNonNullExpression(expression)
    ) {
      expression = expression.expression;
    }
    if (
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
      return helper !== undefined && reachable.has(helper) && hasCapturedAwait(helper);
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
        if (!(helper && reachable.has(helper) && hasCapturedAwait(helper))) {
          if (!capturedInitializers.has(initializer)) {
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
      if (helper && reachable.has(helper) && hasCapturedAwait(helper)) return;
      if (capturedHelperAggregate(argument)) return;
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
    if (!hasCapturedAwait(helper)) continue;
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
      if (!helper || !reachable.has(helper) || !hasCapturedAwait(helper)) return;
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
      if (
        path.node.arguments.length !== 0 ||
        !t.isMemberExpression(path.node.callee) ||
        path.node.callee.computed ||
        !t.isIdentifier(path.node.callee.property) ||
        (path.node.callee.property.name !== "use" &&
          path.node.callee.property.name !== "useOptional")
      ) {
        return;
      }
      path.replaceWith(
        t.callExpression(t.identifier("__sol_context_use"), [
          path.node.callee.object as t.Expression,
          t.identifier("__sol_frame"),
          t.booleanLiteral(path.node.callee.property.name === "useOptional"),
        ]),
      );
      path.skip();
    },
  });
}
