import { parse } from "@babel/parser";
import MagicString from "magic-string";
import type { CompilationState } from "./context.ts";
import { generatedSourceMap } from "./diagnostics.ts";
import { escapeTemplate } from "./html.ts";
import { RUNTIME_IMPORT } from "./runtime-import.ts";
import type { CompileResult } from "./types.ts";

export function emitCompilation(state: CompilationState): CompileResult {
  const { compiler, edits } = state;
  const transformedSource = new MagicString(compiler.source);
  for (const edit of edits) transformedSource.overwrite(edit.start, edit.end, edit.code);
  const templates = compiler.templates
    .map(
      (html, index) =>
        `const __solix_template_${index} = __solix_template(\`${escapeTemplate(html)}\`);`,
    )
    .join("\n");
  transformedSource.prepend(`${RUNTIME_IMPORT}\n${templates}\n`);
  const transformed = transformedSource.toString();

  parse(transformed, {
    sourceType: "module",
    sourceFilename: compiler.filename,
    plugins: ["typescript"],
  });
  return {
    code: transformed,
    map: generatedSourceMap(transformedSource, transformed, compiler),
  };
}
