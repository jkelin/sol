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
import type { CompiledFunction, CompilerContext, Scope } from "./context.ts";
import { codeFrame, mappedCode } from "./diagnostics.ts";
import { compileBlockBody } from "./jsx.ts";

export function reactiveCallCode(
  call: t.CallExpression,
  runtimeName: "__solix_signal" | "__solix_computed",
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
      if (
        t.isCallExpression(initializer) &&
        t.isIdentifier(initializer.callee) &&
        compiler.refCreatorNames.has(initializer.callee.name)
      ) {
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
      const kind: ReactiveKind = isHelperCall(initializer, "$computed")
        ? "computed"
        : isHelperCall(initializer, "$signal")
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
      if (kind === "signal" && isHelperCall(initializer, "$signal")) {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = ${reactiveCallCode(initializer, "__solix_signal", scope)};`,
          ),
        );
      } else if (kind === "computed" && isHelperCall(initializer, "$computed")) {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = ${reactiveCallCode(initializer, "__solix_computed", scope, "__solix_frame")};`,
          ),
        );
      } else if (kind === "computed") {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = __solix_computed${typeParameterCode(identifier)}(() => (${expressionCode(initializer, scope)}), __solix_frame);`,
          ),
        );
      } else {
        generated.push(
          mappedCode(
            compiler,
            declaration,
            `const ${identifier.name} = __solix_signal${typeParameterCode(identifier)}(${expressionCode(initializer, scope)});`,
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
  const parameterCode = parameter ? generate(parameter).code : "__solix_props";
  const previousPropsName = compiler.propsName;
  compiler.propsName = parameter?.name;
  const body = compileBlockBody(compiler, returned, compiledSetup.bindings, compiledSetup.scope);
  compiler.propsName = previousPropsName;
  return {
    code: `${exported ? "export " : ""}const ${name} = __solix_component(${declaration.async ? "async " : ""}(${parameterCode}, __solix_frame) => {
      ${compiledSetup.code}
      ${body}
    });`,
    returned,
  };
}

function instrumentAwaitExpressions(
  compiler: CompilerContext,
  declaration: t.FunctionExpression,
): void {
  const file = t.file(t.program([t.expressionStatement(declaration)]));
  traverse(file, {
    AwaitExpression(path: NodePath<t.AwaitExpression>) {
      if (path.getFunctionParent()?.node !== declaration) return;
      const argument = path.node.argument;
      path.node.argument = t.callExpression(t.identifier("__solix_async_value"), [
        t.identifier("__solix_frame"),
        t.stringLiteral(`await:${compiler.nextAsyncId++}`),
        t.arrowFunctionExpression([], argument),
      ]);
    },
  });
}
