import { compile } from "@sol/compiler";
import { resolve } from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { normalizePath, transformWithOxc } from "vite";
import { highlightCode, markdownModule } from "./compile.ts";
import { documentationRoot, registrySource } from "./registry.ts";

const virtualId = "virtual:sol-docs";
const resolvedVirtualId = `\0/node_modules/${virtualId}.tsx`;
const codeTokensId = "virtual:sol-code-tokens";
const resolvedCodeTokensId = `\0${codeTokensId}`;
const markdownPrefix = "\0/node_modules/sol-markdown:";
const landingExampleFiles = {
  counter: "CounterExample.tsx",
  list: "ListExample.tsx",
  form: "FormExample.tsx",
} as const;

export interface LandingExampleSources {
  readonly counterSource: string;
  readonly listSource: string;
  readonly formSource: string;
}

function landingExamplePath(root: string, filename: string): string {
  return resolve(root, "src", "examples", filename);
}

export async function readLandingExampleSources(root: string): Promise<LandingExampleSources> {
  const [counterSource, listSource, formSource] = await Promise.all([
    readFileSafe(landingExamplePath(root, landingExampleFiles.counter)),
    readFileSafe(landingExamplePath(root, landingExampleFiles.list)),
    readFileSafe(landingExamplePath(root, landingExampleFiles.form)),
  ]);
  return { counterSource, listSource, formSource };
}

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
  const isLandingExample = (file: string): boolean =>
    Object.values(landingExampleFiles).some(
      (filename) =>
        normalizePath(file) === normalizePath(landingExamplePath(config.root, filename)),
    );
  const invalidateDocumentation = (server: ViteDevServer): void => {
    const module = server.moduleGraph.getModuleById(resolvedVirtualId);
    if (module) server.moduleGraph.invalidateModule(module);
    server.ws.send({ type: "full-reload" });
  };
  const invalidateLandingExamples = (server: ViteDevServer): void => {
    const module = server.moduleGraph.getModuleById(resolvedCodeTokensId);
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
        const { counterSource, listSource, formSource } = await readLandingExampleSources(
          config.root,
        );
        const [counterLines, listLines, formLines] = await Promise.all([
          highlightCode(counterSource, "tsx"),
          highlightCode(listSource, "tsx"),
          highlightCode(formSource, "tsx"),
        ]);
        return {
          code: `export const counterSource = ${JSON.stringify(counterSource)};
export const listSource = ${JSON.stringify(listSource)};
export const formSource = ${JSON.stringify(formSource)};
export const counterLines = ${JSON.stringify(counterLines)};
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
      const invalidateAddedOrRemovedSource = (file: string): void => {
        if (isDocumentationPage(file)) invalidateDocumentation(server);
        if (isLandingExample(file)) invalidateLandingExamples(server);
      };
      server.watcher.on("add", invalidateAddedOrRemovedSource);
      server.watcher.on("unlink", invalidateAddedOrRemovedSource);
      return () => {
        server.watcher.off("add", invalidateAddedOrRemovedSource);
        server.watcher.off("unlink", invalidateAddedOrRemovedSource);
      };
    },
    handleHotUpdate(context) {
      if (isDocumentationPage(context.file)) invalidateDocumentation(context.server);
      if (isLandingExample(context.file)) invalidateLandingExamples(context.server);
    },
  };
}

async function readFileSafe(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}
