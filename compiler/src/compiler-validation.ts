import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "./ast.ts";
import { isRouteFilename } from "./codegen.ts";
import type { CompilationState } from "./context.ts";
import { codeFrame } from "./diagnostics.ts";

export function validateCompiledModule(state: CompilationState): boolean {
  const { ast, compiler, edits, compiledJsxRanges, componentCallRanges, routeCallRanges } = state;
  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      if (t.isIdentifier(path.node.callee, { name: "$component" })) {
        if (componentCallRanges.has(`${path.node.start}:${path.node.end}`)) return;
        codeFrame(
          compiler,
          path.node,
          "$component() is only valid as a direct top-level const initializer",
        );
      }
      if (t.isIdentifier(path.node.callee, { name: "$route" })) {
        if (routeCallRanges.has(`${path.node.start}:${path.node.end}`)) return;
        codeFrame(
          compiler,
          path.node,
          isRouteFilename(compiler.filename)
            ? "$route() is only valid as an exported top-level const initializer"
            : "$route() is only valid in *.route.[jt]sx? files",
        );
      }
    },
  });

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
      codeFrame(
        compiler,
        survivingJsx,
        "JSX must be returned from a top-level $component(function Name() {}) declaration",
      );
    }
    return false;
  }

  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      const covered = compiledJsxRanges.some(
        (range) => path.node.start! >= range.start && path.node.end! <= range.end,
      );
      if (!covered) {
        codeFrame(
          compiler,
          path.node,
          "JSX survived compilation; wrap a named function with $component()",
        );
      }
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      const covered = compiledJsxRanges.some(
        (range) => path.node.start! >= range.start && path.node.end! <= range.end,
      );
      if (!covered) {
        codeFrame(
          compiler,
          path.node,
          "JSX survived compilation; wrap a named function with $component()",
        );
      }
    },
  });
  return true;
}
