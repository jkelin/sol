import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "./ast.ts";
import { isSolFilename } from "./codegen.ts";
import type { CompilationState } from "./context.ts";
import { codeFrame } from "./diagnostics.ts";
import { declarationCallHelper } from "./declarations.ts";

export function validateCompiledModule(state: CompilationState): boolean {
  const {
    ast,
    compiler,
    edits,
    compiledJsxRanges,
    componentCallRanges,
    routeCallRanges,
    serverCallRanges,
  } = state;
  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      if (compiler.componentCalls.has(path.node)) {
        if (componentCallRanges.has(`${path.node.start}:${path.node.end}`)) return;
        codeFrame(
          compiler,
          path.node,
          "$component() is only valid as a direct top-level const initializer",
        );
      }
      const declarationHelper = declarationCallHelper(compiler, path.node.callee);
      if (declarationHelper === "$route") {
        if (routeCallRanges.has(`${path.node.start}:${path.node.end}`)) return;
        codeFrame(
          compiler,
          path.node,
          isSolFilename(compiler.filename)
            ? "$route() is only valid as an exported top-level const initializer"
            : "$route() is only valid in *.sol.ts or *.sol.tsx files",
        );
      }
      if (declarationHelper !== undefined) {
        if (serverCallRanges.has(`${path.node.start}:${path.node.end}`)) return;
        codeFrame(
          compiler,
          path.node,
          isSolFilename(compiler.filename)
            ? `${declarationHelper}() is only valid as an exported top-level const initializer`
            : `${declarationHelper}() is only valid in *.sol.ts or *.sol.tsx files`,
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
