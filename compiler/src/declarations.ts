import * as t from "@babel/types";
import { generate, traverse } from "./ast.ts";
import { isSolFilename } from "./codegen.ts";
import type { CompilationState } from "./context.ts";
import { codeFrame } from "./diagnostics.ts";
import { canonicalHttpRoutePath } from "./http-path.ts";
import { parseRoutePath } from "./route-path.ts";
import { compileFunction } from "./setup.ts";

type DeclarationHelper = "$route" | "$rpcQuery" | "$rpcMutation" | "$httpRoute";

export function declarationCallHelper(
  compiler: CompilationState["compiler"],
  callee: t.Expression | t.V8IntrinsicIdentifier,
): DeclarationHelper | undefined {
  if (t.isIdentifier(callee)) return compiler.declarationHelperNames.get(callee.name);
  if (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object) &&
    compiler.declarationHelperNamespaces.has(callee.object.name)
  ) {
    const property =
      !callee.computed && t.isIdentifier(callee.property)
        ? callee.property.name
        : callee.computed && t.isStringLiteral(callee.property)
          ? callee.property.value
          : undefined;
    return property && ["$route", "$rpcQuery", "$rpcMutation", "$httpRoute"].includes(property)
      ? (property as DeclarationHelper)
      : undefined;
  }
  return undefined;
}

function exportedLocalNames(ast: t.File): Set<string> {
  const names = new Set<string>();
  for (const statement of ast.program.body) {
    if (!t.isExportNamedDeclaration(statement) || statement.source) continue;
    if (statement.declaration) {
      for (const name of Object.keys(t.getBindingIdentifiers(statement.declaration)))
        names.add(name);
    }
    for (const specifier of statement.specifiers) {
      if (t.isExportSpecifier(specifier) && t.isIdentifier(specifier.local)) {
        names.add(specifier.local.name);
      }
    }
  }
  return names;
}

export function compileComponentDeclarations(state: CompilationState): void {
  const { ast, compiler, edits, compiledJsxRanges, componentCallRanges } = state;
  for (const statement of ast.program.body) {
    const exported = t.isExportNamedDeclaration(statement);
    const declaration = exported ? statement.declaration : statement;
    if (!t.isVariableDeclaration(declaration)) continue;
    const componentVariables = declaration.declarations.filter(
      (variable) => t.isCallExpression(variable.init) && compiler.componentCalls.has(variable.init),
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
    if (!t.isIdentifier(variable.id)) {
      codeFrame(compiler, variable.id, "$component() declarations require an identifier");
    }
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
}

export function compileRouteDeclarations(state: CompilationState): void {
  const { ast, compiler, edits, routeCallRanges } = state;
  const exportedNames = exportedLocalNames(ast);
  for (const statement of ast.program.body) {
    const exported = t.isExportNamedDeclaration(statement);
    const declaration = exported ? statement.declaration : statement;
    if (!t.isVariableDeclaration(declaration)) continue;
    const routeVariables = declaration.declarations.filter(
      (variable) =>
        t.isCallExpression(variable.init) &&
        declarationCallHelper(compiler, variable.init.callee) === "$route",
    );
    if (routeVariables.length === 0) continue;
    const variable = routeVariables[0]!;
    if (!isSolFilename(compiler.filename)) {
      codeFrame(compiler, variable, "$route() is only valid in *.sol.ts or *.sol.tsx files");
    }
    if (!t.isIdentifier(variable.id) || !exportedNames.has(variable.id.name)) {
      codeFrame(compiler, declaration, "$route() declarations must be exported");
    }
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
    const configProperties = new Map<string, t.ObjectProperty>();
    for (const configProperty of config.properties) {
      if (
        !t.isObjectProperty(configProperty) ||
        configProperty.computed ||
        !t.isIdentifier(configProperty.key) ||
        !["path", "schema"].includes(configProperty.key.name)
      ) {
        codeFrame(compiler, configProperty, "$route() config may contain only path and schema");
      }
      if (configProperties.has(configProperty.key.name)) {
        codeFrame(
          compiler,
          configProperty,
          `Duplicate $route() ${configProperty.key.name} property`,
        );
      }
      configProperties.set(configProperty.key.name, configProperty);
    }
    const property = configProperties.get("path");
    if (!property || !t.isStringLiteral(property.value)) {
      codeFrame(compiler, config, "$route() path must be a string literal");
    }
    if (!t.isIdentifier(candidate) || !compiler.componentNames.has(candidate.name)) {
      codeFrame(compiler, candidate, "$route() component must reference a compiled component");
    }
    const parsedPath = parseRoutePath(compiler, property.value);
    edits.push({
      start: statement.start!,
      end: statement.end!,
      code: `${exported ? "export " : ""}const ${variable.id.name} = __sol_route(${generate(config).code}, ${candidate.name}, ${JSON.stringify(parsedPath)});`,
    });
    routeCallRanges.add(`${call.start}:${call.end}`);
  }
}

function rangeWithOwnedComments(node: t.Node, source: string): { start: number; end: number } {
  const commentStart = node.leadingComments
    ?.filter((comment) => comment.start !== null && comment.start !== undefined)
    .reduce((start, comment) => Math.min(start, comment.start!), node.start!);
  const commentEnd = node.trailingComments
    ?.filter(
      (comment) =>
        comment.end !== null &&
        comment.end !== undefined &&
        source.slice(comment.end).trim() === "",
    )
    .reduce((end, comment) => Math.max(end, comment.end!), node.end!);
  return { start: commentStart ?? node.start!, end: commentEnd ?? node.end! };
}

function isSimpleServerEffectArgument(argument: t.Node | null): boolean {
  return (
    argument !== null &&
    (t.isIdentifier(argument) ||
      t.isLiteral(argument) ||
      (t.isMemberExpression(argument) && !argument.computed))
  );
}

export function compileServerDeclarations(state: CompilationState): void {
  const { ast, compiler, edits, serverCallRanges } = state;
  const exportedNames = exportedLocalNames(ast);
  for (const statement of ast.program.body) {
    const exported = t.isExportNamedDeclaration(statement);
    const declaration = exported ? statement.declaration : statement;
    if (!t.isVariableDeclaration(declaration)) continue;
    const variables = declaration.declarations.filter(
      (variable) =>
        t.isCallExpression(variable.init) &&
        declarationCallHelper(compiler, variable.init.callee) !== undefined &&
        declarationCallHelper(compiler, variable.init.callee) !== "$route",
    );
    if (variables.length === 0) continue;
    const variable = variables[0]!;
    const call = variable.init as t.CallExpression;
    const helper = declarationCallHelper(compiler, call.callee)!;
    if (!isSolFilename(compiler.filename)) {
      codeFrame(compiler, variable, `${helper}() is only valid in *.sol.ts or *.sol.tsx files`);
    }
    if (!t.isIdentifier(variable.id) || !exportedNames.has(variable.id.name)) {
      codeFrame(compiler, declaration, `${helper}() declarations must be exported`);
    }
    if (declaration.kind !== "const" || declaration.declarations.length !== 1) {
      codeFrame(
        compiler,
        declaration,
        `${helper}() must be the sole initializer in an exported top-level const declaration`,
      );
    }
    if (!t.isIdentifier(variable.id)) {
      codeFrame(compiler, variable.id, `${helper}() declarations require an identifier`);
    }
    if (call.arguments.length !== (helper === "$httpRoute" ? 2 : 3)) {
      codeFrame(
        compiler,
        call,
        helper === "$httpRoute"
          ? "$httpRoute() expects a config object and handler"
          : `${helper}() expects a name, config object, and handler`,
      );
    }
    const configIndex = helper === "$httpRoute" ? 0 : 1;
    const config = call.arguments[configIndex]!;
    const handler = call.arguments[configIndex + 1]!;
    if (!t.isObjectExpression(config))
      codeFrame(compiler, config, `${helper}() config must be an object literal`);
    if (!t.isExpression(handler))
      codeFrame(compiler, handler, `${helper}() handler must be an expression`);
    if (
      t.isLiteral(handler) ||
      t.isObjectExpression(handler) ||
      t.isArrayExpression(handler) ||
      t.isTemplateLiteral(handler)
    ) {
      codeFrame(compiler, handler, `${helper}() handler must be callable`);
    }
    const properties = new Map<string, t.ObjectProperty>();
    const allowed = helper === "$httpRoute" ? ["method", "path", "schema", "body"] : ["schema"];
    for (const property of config.properties) {
      if (
        !t.isObjectProperty(property) ||
        property.computed ||
        !t.isIdentifier(property.key) ||
        !allowed.includes(property.key.name)
      ) {
        codeFrame(compiler, property, `${helper}() config may contain only ${allowed.join(", ")}`);
      }
      if (properties.has(property.key.name)) {
        codeFrame(compiler, property, `Duplicate ${helper}() ${property.key.name} property`);
      }
      properties.set(property.key.name, property);
    }
    if (!properties.has("schema")) codeFrame(compiler, config, `${helper}() requires a schema`);
    let nameCode: string | undefined;
    let canonicalPath: string | undefined;
    if (helper !== "$httpRoute") {
      const name = call.arguments[0]!;
      if (!t.isStringLiteral(name) || !/^[A-Za-z0-9_-]+$/.test(name.value)) {
        codeFrame(compiler, name, `${helper}() name must be a URL-safe string literal`);
      }
      nameCode = JSON.stringify(name.value);
    } else {
      const method = properties.get("method")?.value;
      const path = properties.get("path")?.value;
      const body = properties.get("body")?.value;
      if (
        !t.isStringLiteral(method) ||
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method.value)
      ) {
        codeFrame(
          compiler,
          method ?? config,
          "$httpRoute() method must be a supported uppercase string literal",
        );
      }
      if (!t.isStringLiteral(path) || !path.value.startsWith("/")) {
        codeFrame(
          compiler,
          path ?? config,
          "$httpRoute() path must be a root-relative string literal",
        );
      }
      if (t.isStringLiteral(path)) {
        try {
          canonicalPath = canonicalHttpRoutePath(path.value);
        } catch (error) {
          codeFrame(compiler, path, error instanceof Error ? error.message : String(error));
        }
      }
      if (t.isStringLiteral(path) && path.value.startsWith("/api/rpc/")) {
        codeFrame(compiler, path, "$httpRoute() path uses the reserved /api/rpc namespace");
      }
      if (body && (!t.isStringLiteral(body) || !["auto", "bytes"].includes(body.value))) {
        codeFrame(compiler, body, '$httpRoute() body must be "auto" or "bytes"');
      }
    }
    const runtime =
      helper === "$rpcQuery"
        ? compiler.target === "server"
          ? "__sol_rpc_query_server"
          : "__sol_rpc_query_client"
        : helper === "$rpcMutation"
          ? compiler.target === "server"
            ? "__sol_rpc_mutation_server"
            : "__sol_rpc_mutation_client"
          : compiler.target === "server"
            ? "__sol_http_route_server"
            : "__sol_http_route_client";
    const emittedArguments = call.arguments.map((argument) => argument as t.Node);
    if (helper === "$httpRoute") {
      const emittedConfig = t.cloneNode(config, true);
      const path = emittedConfig.properties.find(
        (property) =>
          t.isObjectProperty(property) && t.isIdentifier(property.key, { name: "path" }),
      );
      if (path && t.isObjectProperty(path)) path.value = t.stringLiteral(canonicalPath!);
      emittedArguments[0] = emittedConfig;
    }
    const code =
      compiler.target === "server"
        ? `${exported ? "export " : ""}const ${variable.id.name} = ${runtime}(${emittedArguments.map((argument) => generate(argument).code).join(", ")});`
        : helper === "$httpRoute"
          ? `${exported ? "export " : ""}const ${variable.id.name} = ${runtime}({ method: ${generate(properties.get("method")!.value).code}, path: ${JSON.stringify(canonicalPath)} });`
          : `${exported ? "export " : ""}const ${variable.id.name} = ${runtime}(${nameCode});`;
    const statementRange =
      compiler.target === "client" ? rangeWithOwnedComments(statement, compiler.source) : statement;
    edits.push({ start: statementRange.start!, end: statementRange.end!, code });
    serverCallRanges.add(`${call.start}:${call.end}`);
    if (compiler.target === "client") {
      state.clientServerSourceRanges.push({
        start: statementRange.start!,
        end: statementRange.end!,
      });
    }
  }
  if (compiler.target === "client" && serverCallRanges.size > 0) {
    pruneClientServerDependencies(state);
  }
}

function pruneClientServerDependencies(state: CompilationState): void {
  const { ast, edits, serverCallRanges } = state;
  const exportedNames = exportedLocalNames(ast);
  const removedRanges = [...serverCallRanges].map((range) => range.split(":").map(Number));
  const removed = (node: t.Node): boolean =>
    removedRanges.some(([start, end]) => node.start! >= start! && node.end! <= end!);
  traverse(ast, {
    Program(path) {
      const removedDeclarators = new Set<t.VariableDeclarator>();
      const removedStatements = new Set<t.Statement>();
      const effectStatements = ast.program.body.filter(
        (statement): statement is t.ExpressionStatement =>
          t.isExpressionStatement(statement) && !t.isAssignmentExpression(statement.expression),
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (const binding of Object.values(path.scope.bindings)) {
          const declarationStatement = ast.program.body.find(
            (candidate) =>
              candidate.start! <= binding.identifier.start! &&
              candidate.end! >= binding.identifier.end!,
          );
          const references = binding.referencePaths.filter(
            (reference) => reference.node !== declarationStatement,
          );
          if (!references.some((reference) => removed(reference.node))) continue;
          const effectFor = (node: t.Node): t.ExpressionStatement | undefined =>
            effectStatements.find(
              (statement) => node.start! >= statement.start! && node.end! <= statement.end!,
            );
          if (
            references.some(
              (reference) => !removed(reference.node) && effectFor(reference.node) === undefined,
            )
          ) {
            continue;
          }
          for (const reference of references) {
            const statement = effectFor(reference.node);
            if (!statement || removedStatements.has(statement)) continue;
            const statementReferences = Object.values(path.scope.bindings).filter((candidate) =>
              candidate.referencePaths.some(
                (candidateReference) =>
                  candidateReference.node.start! >= statement.start! &&
                  candidateReference.node.end! <= statement.end!,
              ),
            );
            const retainedBinding = statementReferences.find((candidate) => {
              if (exportedNames.has(candidate.identifier.name)) return true;
              return candidate.referencePaths.some(
                (candidateReference) =>
                  !removed(candidateReference.node) &&
                  (candidateReference.node.start! < statement.start! ||
                    candidateReference.node.end! > statement.end!),
              );
            });
            if (retainedBinding) {
              codeFrame(
                state.compiler,
                statement,
                `Ambiguous top-level server dependency effect uses retained binding ${retainedBinding.identifier.name}`,
              );
            }
            const expression = statement.expression;
            const call =
              t.isCallExpression(expression) || t.isNewExpression(expression)
                ? expression
                : undefined;
            if (
              !call ||
              call.arguments.some((argument) => !isSimpleServerEffectArgument(argument))
            ) {
              codeFrame(
                state.compiler,
                statement,
                "Ambiguous top-level server dependency effect; move server setup into a declaration initializer",
              );
            }
            const range = rangeWithOwnedComments(statement, state.compiler.source);
            removedStatements.add(statement);
            removedRanges.push([range.start, range.end]);
            state.clientServerSourceRanges.push(range);
            changed = true;
          }
        }
        for (const statement of ast.program.body) {
          if (
            removedStatements.has(statement) ||
            !t.isExpressionStatement(statement) ||
            !t.isAssignmentExpression(statement.expression)
          ) {
            continue;
          }
          let target: t.Node = statement.expression.left;
          while (t.isMemberExpression(target) || t.isOptionalMemberExpression(target)) {
            target = target.object;
          }
          if (!t.isIdentifier(target)) continue;
          const binding = path.scope.getBinding(target.name);
          if (!binding) continue;
          const declarationStatement = ast.program.body.find(
            (candidate) =>
              candidate.start! <= binding.identifier.start! &&
              candidate.end! >= binding.identifier.end!,
          );
          const reads = binding.referencePaths.filter(
            (reference) => reference.node !== target && reference.node !== declarationStatement,
          );
          if (reads.length === 0 || reads.some((reference) => !removed(reference.node))) continue;
          const range = rangeWithOwnedComments(statement, state.compiler.source);
          removedStatements.add(statement);
          removedRanges.push([range.start, range.end]);
          state.clientServerSourceRanges.push(range);
          changed = true;
        }
        for (const statement of ast.program.body) {
          const dependency =
            t.isExportNamedDeclaration(statement) && statement.declaration
              ? statement.declaration
              : statement;
          if (
            removedStatements.has(statement) ||
            t.isImportDeclaration(statement) ||
            (t.isExportDeclaration(statement) && dependency === statement) ||
            removed(statement)
          ) {
            continue;
          }
          const candidates = t.isVariableDeclaration(dependency)
            ? dependency.declarations.filter((declarator) => !removedDeclarators.has(declarator))
            : t.isFunctionDeclaration(dependency) || t.isClassDeclaration(dependency)
              ? [dependency]
              : [];
          for (const candidate of candidates) {
            const names = Object.keys(t.getBindingIdentifiers(candidate));
            const bindings = names.map((name) => path.scope.getBinding(name)).filter(Boolean);
            const references = bindings.flatMap((binding) => binding!.referencePaths);
            const meaningfulReferences = references.filter(
              (reference) => reference.node !== statement,
            );
            if (
              meaningfulReferences.length === 0 ||
              meaningfulReferences.some((reference) => !removed(reference.node))
            ) {
              continue;
            }
            const range = rangeWithOwnedComments(candidate, state.compiler.source);
            removedRanges.push([range.start, range.end]);
            state.clientServerSourceRanges.push(range);
            if (t.isVariableDeclarator(candidate)) removedDeclarators.add(candidate);
            else removedStatements.add(statement);
            changed = true;
          }
        }
      }
      for (const statement of ast.program.body) {
        if (removedStatements.has(statement)) {
          const range = rangeWithOwnedComments(statement, state.compiler.source);
          edits.push({ start: range.start, end: range.end, code: "" });
          continue;
        }
        const dependency =
          t.isExportNamedDeclaration(statement) && statement.declaration
            ? statement.declaration
            : statement;
        if (!t.isVariableDeclaration(dependency)) continue;
        const retained = dependency.declarations.filter(
          (declarator) => !removedDeclarators.has(declarator),
        );
        if (retained.length === dependency.declarations.length) continue;
        if (retained.length === 0) {
          const range = rangeWithOwnedComments(statement, state.compiler.source);
          edits.push({ start: range.start, end: range.end, code: "" });
          state.clientServerSourceRanges.push(range);
          continue;
        }
        const replacement = t.cloneNode(dependency);
        replacement.declarations = retained.map((declarator) => t.cloneNode(declarator));
        const code = generate(replacement).code;
        const range = rangeWithOwnedComments(statement, state.compiler.source);
        edits.push({
          start: range.start,
          end: range.end,
          code: t.isExportNamedDeclaration(statement) ? `export ${code}` : code,
        });
        if (range.start < statement.start!) {
          state.clientServerSourceRanges.push({ start: range.start, end: statement.start! });
        }
      }
      for (const statement of ast.program.body) {
        if (!t.isImportDeclaration(statement) || statement.importKind === "type") continue;
        const retained = statement.specifiers.filter((specifier) => {
          if (t.isImportSpecifier(specifier) && specifier.importKind === "type") return true;
          const binding = path.scope.getBinding(specifier.local.name);
          return !binding || binding.referencePaths.some((reference) => !removed(reference.node));
        });
        if (retained.length === statement.specifiers.length) continue;
        const replacement = t.cloneNode(statement);
        replacement.specifiers = retained.map((specifier) => t.cloneNode(specifier));
        const range = rangeWithOwnedComments(statement, state.compiler.source);
        edits.push({
          start: range.start!,
          end: range.end!,
          code: retained.length === 0 ? "" : generate(replacement).code,
        });
        state.clientServerSourceRanges.push({ start: range.start!, end: range.end! });
      }
      path.stop();
    },
  });
}
