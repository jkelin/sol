import { parse } from "@babel/parser";
import MagicString from "magic-string";
import type { CompilationState } from "./context.ts";
import { generatedSourceMap } from "./diagnostics.ts";
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
        propertyValueElements: propertyValueElements(template.operations),
      };
      const signature = templateSignature(template.html, template.operations);
      return `const __sol_template_${index} = __sol_template(\`${escapeTemplate(template.html)}\`, ${JSON.stringify(signature)}, ${JSON.stringify(metadata)});`;
    })
    .join("\n");
  const serverRuntimeImport =
    state.serverCallRanges.size === 0
      ? ""
      : compiler.target === "server"
        ? `import { httpRouteServer as __sol_http_route_server, rpcMutationServer as __sol_rpc_mutation_server, rpcQueryServer as __sol_rpc_query_server } from "sol/compiler-runtime";`
        : `import { httpRouteClient as __sol_http_route_client, rpcMutationClient as __sol_rpc_mutation_client, rpcQueryClient as __sol_rpc_query_client } from "sol/compiler-runtime";`;
  const generatedBody = `${templates}\n${transformedSource.toString()}`;
  const imports = [runtimeImport(generatedBody), serverRuntimeImport].filter(Boolean).join("\n");
  transformedSource.prepend(`${imports}\n${templates}\n`);
  const marked = transformedSource.toString();
  const markerPattern = new RegExp(
    `/\\*${compiler.mappingMarkerPrefix.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+__\\*/`,
    "g",
  );
  const transformed = marked.replaceAll(markerPattern, "");

  parse(transformed, {
    sourceType: "module",
    sourceFilename: compiler.filename,
    plugins: ["typescript"],
  });
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
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}${(hash >>> 0).toString(36)}`;
}

function propertyValueElements(operations: readonly string[]): number[] {
  const indexes = new Set<number>();
  for (const operation of operations) {
    const code = operation.replaceAll(/\/\*__sol_source_\d+__\*\//g, "");
    const target = /__sol_view\.elements\[(\d+)\]/.exec(code);
    if (!target) continue;
    const kind = /__sol_([a-z_]+)\(/.exec(code)?.[1];
    const name = /__sol_view\.elements\[\d+\],\s*"([^"]+)"/.exec(code)?.[1];
    if (kind === "raw_text" || ((kind === "attribute" || kind === "bind") && name === "value")) {
      indexes.add(Number(target[1]));
    }
  }
  return [...indexes].toSorted((left, right) => left - right);
}

function operationIdentity(operation: string): string {
  const code = operation.replaceAll(/\/\*__sol_source_\d+__\*\//g, "");
  return identityHash(code, "o");
}

function templateSignature(html: string, operations: readonly string[]): string {
  return identityHash(`${html}\0${operations.map(operationIdentity).join("\0")}`, "t");
}
