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
    .map((template, index) => {
      const metadata = {
        elements: template.elementTags,
        regions: Array.from({ length: template.regionCount }, (_, region) => region),
        operations: template.operations.map(operationMetadata),
      };
      const signature = templateSignature(template.html, metadata);
      return `const __solix_template_${index} = __solix_template(\`${escapeTemplate(template.html)}\`, ${JSON.stringify(signature)}, ${JSON.stringify(metadata)});`;
    })
    .join("\n");
  const serverRuntimeImport =
    state.serverCallRanges.size === 0
      ? ""
      : compiler.target === "server"
        ? `import { httpRouteServer as __solix_http_route_server, rpcMutationServer as __solix_rpc_mutation_server, rpcQueryServer as __solix_rpc_query_server } from "solix/compiler-runtime";`
        : `import { httpRouteClient as __solix_http_route_client, rpcMutationClient as __solix_rpc_mutation_client, rpcQueryClient as __solix_rpc_query_client } from "solix/compiler-runtime";`;
  transformedSource.prepend(
    serverRuntimeImport
      ? `${RUNTIME_IMPORT}\n${serverRuntimeImport}\n${templates}\n`
      : `${RUNTIME_IMPORT}\n${templates}\n`,
  );
  const transformed = transformedSource.toString();

  parse(transformed, {
    sourceType: "module",
    sourceFilename: compiler.filename,
    plugins: ["typescript"],
  });
  return {
    code: transformed,
    map: generatedSourceMap(
      transformedSource,
      transformed,
      compiler,
      redactClientServerSource(state),
    ),
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

function operationMetadata(operation: string): {
  id: string;
  kind: string;
  target?: "element" | "region";
  index?: number;
  name?: string;
} {
  const code = operation.replaceAll(/\/\*__solix_source_\d+__\*\//g, "");
  const kind = /__solix_([a-z_]+)\(/.exec(code)?.[1];
  const target = /__solix_view\.(elements|regions)\[(\d+)\]/.exec(code);
  if (!kind) throw new Error(`Cannot describe compiled operation ${code}`);
  const metadata: {
    id: string;
    kind: string;
    target?: "element" | "region";
    index?: number;
    name?: string;
  } = {
    id: identityHash(code, "o"),
    kind,
  };
  if (target) {
    metadata.target = target[1] === "elements" ? "element" : "region";
    metadata.index = Number(target[2]);
  }
  if (kind === "attribute" || kind === "bind") {
    const name = /__solix_view\.elements\[\d+\],\s*"([^"]+)"/.exec(code)?.[1];
    if (name) metadata.name = name;
  }
  return metadata;
}

function templateSignature(html: string, metadata: object): string {
  return identityHash(`${html}\0${JSON.stringify(metadata)}`, "t");
}
