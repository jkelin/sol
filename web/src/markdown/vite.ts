import { compile } from "@sol/compiler";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { normalizePath, transformWithOxc } from "vite";
import { counterSource, formSource, listSource } from "../code-samples.ts";
import { highlightCode, markdownModule } from "./compile.ts";
import { documentationRoot, registrySource } from "./registry.ts";

const virtualId = "virtual:sol-docs";
const resolvedVirtualId = `\0/node_modules/${virtualId}.tsx`;
const codeTokensId = "virtual:sol-code-tokens";
const resolvedCodeTokensId = `\0${codeTokensId}`;
const markdownPrefix = "\0/node_modules/sol-markdown:";

export async function compileModule(
  source: string,
  filename: string,
): Promise<{ readonly code: string; readonly map: null; readonly moduleType: "js" }> {
  const compiled = compile(source, filename);
  const transformed = await transformWithOxc(compiled.code, filename);
  return { code: transformed.code, map: null, moduleType: "js" };
}

export function solMarkdown(): Plugin {
  let config: ResolvedConfig;
  const isDocumentationPage = (file: string): boolean => {
    const normalizedFile = normalizePath(file);
    const docsRoot = normalizePath(documentationRoot(config.root));
    return (
      normalizedFile.startsWith(`${docsRoot}/`) &&
      normalizedFile.endsWith(".md") &&
      !normalizedFile.endsWith("/SKILL.md")
    );
  };
  const invalidate = (server: ViteDevServer): void => {
    const module = server.moduleGraph.getModuleById(resolvedVirtualId);
    if (module) server.moduleGraph.invalidateModule(module);
    server.ws.send({ type: "full-reload" });
  };
  return {
    name: "sol-markdown",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
    },
    resolveId(id) {
      if (id === virtualId) return resolvedVirtualId;
      if (id === codeTokensId) return resolvedCodeTokensId;
      if (id.startsWith("/@fs/") && id.endsWith(".md")) {
        return `${markdownPrefix}${id.slice("/@fs/".length)}.tsx`;
      }
      return null;
    },
    async load(id) {
      if (id === resolvedCodeTokensId) {
        const [counterLines, listLines, formLines] = await Promise.all([
          highlightCode(counterSource, "tsx"),
          highlightCode(listSource, "tsx"),
          highlightCode(formSource, "tsx"),
        ]);
        return {
          code: `export const counterLines = ${JSON.stringify(counterLines)};
export const listLines = ${JSON.stringify(listLines)};
export const formLines = ${JSON.stringify(formLines)};`,
          map: null,
          moduleType: "js",
        };
      }
      if (id === resolvedVirtualId) {
        return compileModule(await registrySource(config.root), "virtual-sol-docs.tsx");
      }
      if (!id.startsWith(markdownPrefix) || !id.endsWith(".md.tsx")) return null;
      const file = id.slice(markdownPrefix.length, -".tsx".length);
      const source = await readFileSafe(file);
      const generated = await markdownModule(source, file);
      return compileModule(generated.code, `${file}.tsx`);
    },
    configureServer(server) {
      const invalidateDocumentationRegistry = (file: string): void => {
        if (isDocumentationPage(file)) invalidate(server);
      };
      server.watcher.on("add", invalidateDocumentationRegistry);
      server.watcher.on("unlink", invalidateDocumentationRegistry);
      return () => {
        server.watcher.off("add", invalidateDocumentationRegistry);
        server.watcher.off("unlink", invalidateDocumentationRegistry);
      };
    },
    handleHotUpdate(context) {
      if (isDocumentationPage(context.file)) invalidate(context.server);
    },
  };
}

async function readFileSafe(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}
