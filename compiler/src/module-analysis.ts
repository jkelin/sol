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
      path.stop();
    },
  });

  for (const statement of ast.program.body) {
    if (t.isImportDeclaration(statement)) {
      if (statement.source.value === "sol") {
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
        statement.source.value === "sol" || statement.source.value.startsWith("sol/");
      if (statement.importKind !== "type" && !isFrameworkHelperModule) {
        for (const specifier of statement.specifiers) {
          if (t.isImportSpecifier(specifier) && specifier.importKind === "type") continue;
          compiler.componentNames.add(specifier.local.name);
          compiler.componentBindings.add(specifier.local);
        }
      } else if (statement.source.value === "sol") {
        for (const specifier of statement.specifiers) {
          if (t.isImportNamespaceSpecifier(specifier)) {
            compiler.declarationHelperNamespaceImports.add(specifier.local);
            continue;
          }
          if (!t.isImportSpecifier(specifier) || !t.isIdentifier(specifier.imported)) continue;
          if (specifier.importKind === "type") continue;
          if (specifier.imported.name === "$component") {
            compiler.componentImports.add(specifier.local);
          }
          if (declarationHelpers.has(specifier.imported.name)) {
            compiler.declarationHelperImports.set(
              specifier.local,
              specifier.imported.name as "$route" | "$rpcQuery" | "$rpcMutation" | "$httpRoute",
            );
          }
          if (specifier.imported.name === "Route") {
            compiler.componentNames.add(specifier.local.name);
            compiler.componentBindings.add(specifier.local);
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
            compiler.linkImports.add(specifier.local);
          }
          if (t.isIdentifier(specifier.imported, { name: "createRef" })) {
            compiler.refCreatorImports.add(specifier.local);
          }
          if (
            t.isIdentifier(specifier.imported) &&
            (specifier.imported.name === "$signal" || specifier.imported.name === "$computed")
          ) {
            compiler.reactiveHelperImports.set(
              specifier.local,
              specifier.imported.name.slice(1) as "signal" | "computed",
            );
          }
          if (
            t.isIdentifier(specifier.imported) &&
            (specifier.imported.name === "$query" || specifier.imported.name === "$mutation")
          ) {
            compiler.requestHelpers.set(specifier.local.name, specifier.imported.name);
          }
        }
      }
    }
  }

  traverse(ast, {
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
