import { traverse } from "./ast.ts";
import { validateReservedIdentifier } from "./codegen.ts";
import type { CompilationState } from "./context.ts";
import { codeFrame } from "./diagnostics.ts";
import * as t from "@babel/types";

function importedName(specifier: t.ImportSpecifier): string {
  return t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value;
}

export function analyzeModule({ ast, compiler }: CompilationState): void {
  const declarationHelpers = new Set(["$route", "$rpcQuery", "$rpcMutation", "$httpRoute"]);

  for (const statement of ast.program.body) {
    if (t.isImportDeclaration(statement)) {
      if (statement.importKind !== "type" && statement.source.value === "@soljs/sol") {
        for (const specifier of statement.specifiers) {
          if (
            t.isImportSpecifier(specifier) &&
            specifier.importKind !== "type" &&
            (importedName(specifier) === "signal" || importedName(specifier) === "computed")
          ) {
            codeFrame(
              compiler,
              specifier,
              `${importedName(specifier)}() was renamed to $${importedName(specifier)}()`,
            );
          }
        }
      }
      const isFrameworkHelperModule =
        statement.source.value === "@soljs/sol" ||
        statement.source.value.startsWith("@soljs/sol/");
      if (statement.importKind !== "type" && !isFrameworkHelperModule) {
        for (const specifier of statement.specifiers) {
          if (t.isImportSpecifier(specifier) && specifier.importKind === "type") continue;
          compiler.componentNames.add(specifier.local.name);
          compiler.componentBindings.add(specifier.local);
        }
      } else if (statement.importKind !== "type" && statement.source.value === "@soljs/sol") {
        for (const specifier of statement.specifiers) {
          if (t.isImportNamespaceSpecifier(specifier)) {
            compiler.declarationHelperNamespaceImports.add(specifier.local);
            continue;
          }
          if (!t.isImportSpecifier(specifier)) continue;
          if (specifier.importKind === "type") continue;
          const imported = importedName(specifier);
          if (imported === "$component") {
            compiler.componentImports.add(specifier.local);
          }
          if (declarationHelpers.has(imported)) {
            compiler.declarationHelperImports.set(
              specifier.local,
              imported as "$route" | "$rpcQuery" | "$rpcMutation" | "$httpRoute",
            );
          }
          if (imported === "Route") {
            compiler.componentNames.add(specifier.local.name);
            compiler.componentBindings.add(specifier.local);
          }
          if (
            imported === "Suspense" ||
            imported === "Await" ||
            imported === "ErrorBoundary" ||
            imported === "Portal" ||
            imported === "GlobalPortal" ||
            imported === "Head"
          ) {
            compiler.builtinImports.set(specifier.local, imported);
          }
          if (imported === "Link") {
            compiler.linkImports.add(specifier.local);
          }
          if (imported === "createRef") {
            compiler.refCreatorImports.add(specifier.local);
          }
          if (imported === "$signal" || imported === "$computed") {
            compiler.reactiveHelperImports.set(
              specifier.local,
              imported.slice(1) as "signal" | "computed",
            );
          }
          if (imported === "$query" || imported === "$mutation" || imported === "$form") {
            compiler.requestHelpers.set(specifier.local.name, imported);
          }
        }
      }
    }
  }

  traverse(ast, {
    enter(path) {
      if (!path.isScope()) return;
      for (const binding of Object.values(path.scope.bindings)) {
        validateReservedIdentifier(compiler, binding.identifier);
      }
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (t.isIdentifier(callee)) {
        const binding = path.scope.getBinding(callee.name);
        const importedReactive = binding
          ? compiler.reactiveHelperImports.get(binding.identifier)
          : undefined;
        const globalReactive =
          !binding && (callee.name === "$signal" || callee.name === "$computed")
            ? (callee.name.slice(1) as "signal" | "computed")
            : undefined;
        const reactive = importedReactive ?? globalReactive;
        if (reactive) compiler.reactiveHelperCalls.set(path.node, reactive);
        if (binding && compiler.refCreatorImports.has(binding.identifier)) {
          compiler.refCreatorCalls.add(path.node);
        }
        const declaration = binding
          ? compiler.declarationHelperImports.get(binding.identifier)
          : declarationHelpers.has(callee.name)
            ? (callee.name as "$route" | "$rpcQuery" | "$rpcMutation" | "$httpRoute")
            : undefined;
        if (declaration) compiler.declarationHelperCalls.set(path.node, declaration);
        if (
          binding ? compiler.componentImports.has(binding.identifier) : callee.name === "$component"
        ) {
          compiler.componentCalls.add(path.node);
          const variable = path.parentPath?.node;
          if (
            t.isVariableDeclarator(variable) &&
            variable.init === path.node &&
            t.isIdentifier(variable.id)
          ) {
            compiler.componentNames.add(variable.id.name);
            compiler.componentBindings.add(variable.id);
          }
        }
      } else if (t.isMemberExpression(callee) && t.isIdentifier(callee.object)) {
        const binding = path.scope.getBinding(callee.object.name);
        if (binding && compiler.declarationHelperNamespaceImports.has(binding.identifier)) {
          const property =
            !callee.computed && t.isIdentifier(callee.property)
              ? callee.property.name
              : callee.computed && t.isStringLiteral(callee.property)
                ? callee.property.value
                : undefined;
          if (property && declarationHelpers.has(property)) {
            compiler.declarationHelperCalls.set(
              path.node,
              property as "$route" | "$rpcQuery" | "$rpcMutation" | "$httpRoute",
            );
          }
        }
      }
    },
    JSXElement(path) {
      const name = path.node.openingElement.name;
      if (!t.isJSXIdentifier(name)) return;
      const binding = path.scope.getBinding(name.name);
      if (!binding) return;
      const kind = compiler.builtinImports.get(binding.identifier);
      if (kind) compiler.builtinElements.set(path.node, kind);
      if (compiler.componentBindings.has(binding.identifier)) {
        compiler.componentElements.add(path.node);
      }
      if (compiler.linkImports.has(binding.identifier)) compiler.linkElements.add(path.node);
    },
  });
}
