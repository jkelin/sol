import { compile } from "@solix/compiler";
import { join } from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { normalizePath } from "vite";
import { markdownModule } from "./compile.ts";
import { registrySource } from "./registry.ts";

const virtualId = "virtual:solix-docs";
const resolvedVirtualId = `\0/node_modules/${virtualId}.tsx`;
const markdownPrefix = "\0/node_modules/solix-markdown:";

function compileModule(source: string, filename: string): ReturnType<typeof compile> {
  return compile(source, filename);
}

export function solixMarkdown(): Plugin {
  let config: ResolvedConfig;
  const invalidate = (server: ViteDevServer): void => {
    const module = server.moduleGraph.getModuleById(resolvedVirtualId);
    if (module) server.moduleGraph.invalidateModule(module);
    server.ws.send({ type: "full-reload" });
  };
  return {
    name: "solix-markdown",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
    },
    resolveId(id) {
      if (id === virtualId) return resolvedVirtualId;
      if (id.startsWith("/@fs/") && id.endsWith(".md")) {
        return `${markdownPrefix}${id.slice("/@fs/".length)}.tsx`;
      }
      return null;
    },
    async load(id) {
      if (id === resolvedVirtualId) {
        return compileModule(await registrySource(config.root), "virtual-solix-docs.tsx");
      }
      if (!id.startsWith(markdownPrefix) || !id.endsWith(".md.tsx")) return null;
      const file = id.slice(markdownPrefix.length, -".tsx".length);
      const source = await readFileSafe(file);
      const generated = await markdownModule(source, file);
      return compileModule(generated.code, `${file}.tsx`);
    },
    configureServer(server) {
      const docsRoot = normalizePath(join(config.root, "src", "docs"));
      const added = (file: string): void => {
        if (normalizePath(file).startsWith(docsRoot) && file.endsWith(".md")) invalidate(server);
      };
      const removed = (file: string): void => {
        if (normalizePath(file).startsWith(docsRoot) && file.endsWith(".md")) invalidate(server);
      };
      server.watcher.on("add", added);
      server.watcher.on("unlink", removed);
      return () => {
        server.watcher.off("add", added);
        server.watcher.off("unlink", removed);
      };
    },
    handleHotUpdate(context) {
      if (context.file.endsWith(".md")) invalidate(context.server);
    },
  };
}

async function readFileSafe(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}
