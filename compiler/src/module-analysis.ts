import { traverse } from "./ast.ts";
import { validateReservedIdentifier } from "./codegen.ts";
import type { CompilationState } from "./context.ts";
import { codeFrame } from "./diagnostics.ts";
import * as t from "@babel/types";

export function analyzeModule({ ast, compiler }: CompilationState): void {
  const declarationHelpers = new Set(["$route", "$rpcQuery", "$rpcMutation", "$httpRoute"]);
  traverse(ast, {
    Program(path) {
      for (const binding of Object.values(path.scope.bindings)) {
        validateReservedIdentifier(compiler, binding.identifier);
      }
      for (const helper of declarationHelpers) {
        if (!path.scope.hasBinding(helper)) {
          compiler.declarationHelperNames.set(
            helper,
            helper as "$route" | "$rpcQuery" | "$rpcMutation" | "$httpRoute",
          );
        }
      }
      path.stop();
    },
  });

  for (const statement of ast.program.body) {
    if (t.isImportDeclaration(statement)) {
      if (statement.source.value === "solix") {
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
        statement.source.value === "solix" || statement.source.value.startsWith("solix/");
      if (statement.importKind !== "type" && !isFrameworkHelperModule) {
        for (const specifier of statement.specifiers) {
          if (t.isImportSpecifier(specifier) && specifier.importKind === "type") continue;
          compiler.componentNames.add(specifier.local.name);
        }
      } else if (statement.source.value === "solix") {
        for (const specifier of statement.specifiers) {
          if (!t.isImportSpecifier(specifier) || !t.isIdentifier(specifier.imported)) continue;
          if (specifier.importKind === "type") continue;
          if (declarationHelpers.has(specifier.imported.name)) {
            compiler.declarationHelperNames.set(
              specifier.local.name,
              specifier.imported.name as "$route" | "$rpcQuery" | "$rpcMutation" | "$httpRoute",
            );
          }
          if (specifier.imported.name === "Route") {
            compiler.componentNames.add(specifier.local.name);
          }
          if (
            specifier.imported.name === "Suspense" ||
            specifier.imported.name === "Await" ||
            specifier.imported.name === "ErrorBoundary" ||
            specifier.imported.name === "Portal" ||
            specifier.imported.name === "GlobalPortal" ||
            specifier.imported.name === "Head"
          ) {
            compiler.builtinImports.set(specifier.local, specifier.imported.name);
          }
          if (t.isIdentifier(specifier.imported, { name: "Link" })) {
            compiler.linkNames.add(specifier.local.name);
          }
          if (t.isIdentifier(specifier.imported, { name: "createRef" })) {
            compiler.refCreatorNames.add(specifier.local.name);
          }
          if (
            t.isIdentifier(specifier.imported) &&
            (specifier.imported.name === "$query" || specifier.imported.name === "$mutation")
          ) {
            compiler.requestHelperNames.add(specifier.local.name);
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
      ) {
        compiler.componentNames.add(variable.id.name);
      }
    }
  }

  traverse(ast, {
    JSXElement(path) {
      const name = path.node.openingElement.name;
      if (!t.isJSXIdentifier(name)) return;
      const binding = path.scope.getBinding(name.name);
      if (!binding) return;
      const kind = compiler.builtinImports.get(binding.identifier);
      if (kind) compiler.builtinElements.set(path.node, kind);
    },
  });
}
