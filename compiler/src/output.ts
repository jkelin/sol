import MagicString from "magic-string";
import type * as t from "@babel/types";
import type { CompilationState } from "./context.ts";
import { generatedSourceMap, unmappedCode } from "./diagnostics.ts";
import { escapeTemplate } from "./html.ts";
import { runtimeImport, serverRuntimeImport } from "./runtime-import.ts";
import type { CompileResult } from "./types.ts";

export function emitCompilation(state: CompilationState): CompileResult {
  const { compiler, edits } = state;
  const transformedSource = new MagicString(compiler.source);
  for (const edit of edits) transformedSource.overwrite(edit.start, edit.end, edit.code);
  const ownerSurvives = (owner: t.VariableDeclarator): boolean =>
    !state.removedArtifactOwners.has(owner);
  const survivingTemplateIndexes = new Set<number>();
  const templates = compiler.templates
    .flatMap((template, index) => {
      const owners = compiler.templateOwners.get(index);
      if (owners && ![...owners].some(ownerSurvives)) return [];
      survivingTemplateIndexes.add(index);
      const metadata = {
        elements: template.elementTags,
        regionCount: template.regionCount,
        propertyValueElements: template.propertyValueElements,
        ...(Object.keys(template.dynamicAttributes).length > 0
          ? { dynamicAttributes: template.dynamicAttributes }
          : {}),
      };
      const signature = templateSignature(compiler, template.html, template.operations);
      return [
        `const __sol_template_${index} = ${compiler.routeMode === "handle" ? "/*#__PURE__*/ " : ""}__sol_template(\`${escapeTemplate(template.html)}\`, ${JSON.stringify(signature)}, ${JSON.stringify(metadata)});`,
      ];
    })
    .join("\n");
  const serverImport = serverRuntimeImport(compiler.serverRuntimeHelpers, compiler.target);
  const runtimeHelpers = new Set(
    [...compiler.runtimeHelpers].filter((helper) => {
      if (compiler.unownedRuntimeHelpers.has(helper)) return true;
      const owners = compiler.runtimeHelperOwners.get(helper);
      return !owners || [...owners].some(ownerSurvives);
    }),
  );
  if (survivingTemplateIndexes.size > 0) runtimeHelpers.add("__sol_template");
  const imports = [runtimeImport(runtimeHelpers), serverImport].filter(Boolean).join("\n");
  transformedSource.prepend(`${imports}\n${templates}\n`);
  const marked = transformedSource.toString();
  const markerPattern = new RegExp(
    `/\\*${compiler.mappingMarkerPrefix.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+__\\*/`,
    "g",
  );
  const transformed = marked.replaceAll(markerPattern, "");

  return {
    code: transformed,
    map: generatedSourceMap(transformedSource, marked, compiler, redactClientServerSource(state)),
  };
}

function redactClientServerSource(state: CompilationState): string {
  if (state.compiler.target !== "client" || state.clientServerSourceRanges.length === 0) {
    return state.compiler.source;
  }
  const characters = state.compiler.source.split("");
  for (const { start, end } of state.clientServerSourceRanges) {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  }
  return characters.join("");
}

function identityHash(value: string, prefix: string): string {
  let first = 2_166_136_261;
  let second = 5381;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16_777_619);
    second = Math.imul(second, 33) ^ code;
  }
  return `${prefix}${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function operationIdentity(compiler: CompilationState["compiler"], operation: string): string {
  return identityHash(unmappedCode(compiler, operation), "o");
}

function templateSignature(
  compiler: CompilationState["compiler"],
  html: string,
  operations: readonly string[],
): string {
  return identityHash(
    `${html}\0${operations.map((operation) => operationIdentity(compiler, operation)).join("\0")}`,
    "t",
  );
}
