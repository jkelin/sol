import MagicString from "magic-string";
import type { CompilationState } from "./context.ts";
import { generatedSourceMap, unmappedCode } from "./diagnostics.ts";
import { escapeTemplate } from "./html.ts";
import { runtimeImport } from "./runtime-import.ts";
import type { CompileResult } from "./types.ts";

export function emitCompilation(state: CompilationState): CompileResult {
  const { compiler, edits } = state;
  const transformedSource = new MagicString(compiler.source);
  for (const edit of edits) transformedSource.overwrite(edit.start, edit.end, edit.code);
  const templates = compiler.templates
    .map((template, index) => {
      const metadata = {
        elements: template.elementTags,
        regionCount: template.regionCount,
        propertyValueElements: template.propertyValueElements,
      };
      const signature = templateSignature(compiler, template.html, template.operations);
      return `const __sol_template_${index} = ${compiler.routeMode === "handle" ? "/*#__PURE__*/ " : ""}__sol_template(\`${escapeTemplate(template.html)}\`, ${JSON.stringify(signature)}, ${JSON.stringify(metadata)});`;
    })
    .join("\n");
  const serverRuntimeImport =
    state.serverCallRanges.size === 0
      ? ""
      : compiler.target === "server"
        ? `import { httpRouteServer as __sol_http_route_server, rpcMutationServer as __sol_rpc_mutation_server, rpcQueryServer as __sol_rpc_query_server } from "@soljs/sol/compiler-runtime";`
        : `import { httpRouteClient as __sol_http_route_client, rpcMutationClient as __sol_rpc_mutation_client, rpcQueryClient as __sol_rpc_query_client } from "@soljs/sol/compiler-runtime";`;
  const runtimeHelpers = new Set(compiler.runtimeHelpers);
  if (compiler.templates.length > 0) runtimeHelpers.add("__sol_template");
  const imports = [runtimeImport(runtimeHelpers), serverRuntimeImport].filter(Boolean).join("\n");
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
