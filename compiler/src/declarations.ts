import * as t from "@babel/types";
import { generate } from "./ast.ts";
import { isRouteFilename } from "./codegen.ts";
import type { CompilationState } from "./context.ts";
import { codeFrame } from "./diagnostics.ts";
import { parseRoutePath } from "./route-path.ts";
import { compileFunction } from "./setup.ts";

export function compileComponentDeclarations(state: CompilationState): void {
  const { ast, compiler, edits, compiledJsxRanges, componentCallRanges } = state;
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
    if (!isRouteFilename(compiler.filename)) {
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
      code: `export const ${variable.id.name} = __solix_route(${generate(config).code}, ${candidate.name}, ${JSON.stringify(parsedPath)});`,
    });
    routeCallRanges.add(`${call.start}:${call.end}`);
  }
}
