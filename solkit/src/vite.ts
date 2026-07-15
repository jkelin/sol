import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnvironmentModuleNode, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import type { RequestHandler, SolkitAdapter, SolkitOptions } from "./types.ts";

const CLIENT_ENTRY = "virtual:solkit/client";
const SERVER_ENTRY = "virtual:solkit/server";
const SERVER_ENTRY_URL = "/@solkit/server";
const ADAPTER_ENTRY = "virtual:solkit/adapter";
const RESOLVED_CLIENT_ENTRY = `\0${CLIENT_ENTRY}`;
const RESOLVED_SERVER_ENTRY = `\0${SERVER_ENTRY}`;
const RESOLVED_ADAPTER_ENTRY = `\0${ADAPTER_ENTRY}`;
const BUILD_TARGET = "SOLKIT_BUILD_TARGET";
const DEV_STYLE_ATTRIBUTE = "data-solkit-dev-style";
const CSS_REQUEST = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/i;

function isCssRequest(id: string): boolean {
  return CSS_REQUEST.test(id);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function validateOptions(options: unknown): asserts options is SolkitOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("solkit() options must be an object");
  }
  const candidate = options as Partial<SolkitOptions>;
  if (typeof candidate.entry !== "string" || !candidate.entry.startsWith("/")) {
    throw new TypeError("solkit() entry must be a root-relative module path");
  }
  if (candidate.exportName !== undefined && !/^[A-Za-z_$][\w$]*$/.test(candidate.exportName)) {
    throw new TypeError("solkit() exportName must be a JavaScript identifier");
  }
  if (
    !candidate.adapter ||
    typeof candidate.adapter !== "object" ||
    typeof candidate.adapter.name !== "string" ||
    !candidate.adapter.name ||
    typeof candidate.adapter.write !== "function"
  ) {
    throw new TypeError("solkit() adapter must provide a name and write() method");
  }
  const staticMarker = (candidate.adapter as SolkitAdapter & { static?: unknown }).static;
  if (staticMarker !== undefined && typeof staticMarker !== "boolean") {
    throw new TypeError("solkit() adapter static marker must be a boolean");
  }
  const unexpected = Object.keys(options).find(
    (key) => key !== "entry" && key !== "exportName" && key !== "adapter" && key !== "maxBodyBytes",
  );
  if (unexpected) throw new TypeError(`Unknown solkit() option ${unexpected}`);
  if (
    candidate.maxBodyBytes !== undefined &&
    (!Number.isSafeInteger(candidate.maxBodyBytes) || candidate.maxBodyBytes < 0)
  ) {
    throw new TypeError("solkit() maxBodyBytes must be a non-negative safe integer");
  }
}

function requestBodyFromNode(request: IncomingMessage): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = request.iterator({ destroyOnReturn: false });
      return {
        next: () => iterator.next(),
        async return() {
          try {
            await iterator.return?.();
            return { done: true as const, value: undefined };
          } finally {
            if (!request.readableEnded) request.resume();
          }
        },
      };
    },
  };
}

function requestFromNode(request: IncomingMessage): Request {
  const host = request.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  const isRead = method === "GET" || method === "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body: isRead ? undefined : (requestBodyFromNode(request) as unknown as BodyInit),
    duplex: isRead ? undefined : "half",
  };
  return new Request(new URL(request.url ?? "/", `http://${host}`), init);
}

async function sendResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

async function collectDevStyles(server: ViteDevServer): Promise<string[]> {
  const graph = server.environments.client.moduleGraph;
  const visited = new Set<string>();
  async function visit(url: string): Promise<string[]> {
    if (visited.has(url)) return [];
    visited.add(url);

    let module = await graph.getModuleByUrl(url);
    if (module && isCssRequest(module.url)) {
      return /[?&](?:inline|raw|url)(?:&|$)/.test(module.url) ? [] : [module.url];
    }
    if (!module?.transformResult && module?.type !== "css") {
      await server.transformRequest(url);
      module = await graph.getModuleByUrl(url);
    }
    if (!module) return [];
    if (module.type === "css") return [module.url];
    const importedStyles = await Promise.all(
      [...module.importedModules].map((dependency: EnvironmentModuleNode) => visit(dependency.url)),
    );
    return importedStyles.flat();
  }

  return visit(CLIENT_ENTRY);
}

function injectDevStyles(template: string, styles: string[]): string {
  if (!styles.length) return template;
  const links = styles
    .map(
      (href) =>
        `<link rel="stylesheet" href="${href.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" ${DEV_STYLE_ATTRIBUTE}>`,
    )
    .join("\n");
  return template.replace("<!--solkit-head-->", `${links}\n<!--solkit-head-->`);
}

export function solkit(options: SolkitOptions): Plugin {
  validateOptions(options);
  const exportName = options.exportName ?? "App";
  const staticBuild = (options.adapter as SolkitAdapter & { static?: boolean }).static === true;
  const clientOutDir = staticBuild ? "dist" : "dist/client";
  let config: ResolvedConfig;
  let serverBuild = false;
  let adapterBuild = false;

  return {
    name: "solkit",
    enforce: "post",
    config(_config, environment) {
      serverBuild = environment.command === "build" && process.env[BUILD_TARGET] === "server";
      adapterBuild = environment.command === "build" && process.env[BUILD_TARGET] === "adapter";
      if (adapterBuild) {
        return {
          build: {
            outDir: "dist",
            emptyOutDir: false,
            copyPublicDir: false,
            manifest: false,
            sourcemap: false,
            rollupOptions: {
              input: ADAPTER_ENTRY,
              output: { entryFileNames: ".solkit/adapter.js" },
            },
          },
        };
      }
      if (serverBuild) {
        return {
          build: {
            ssr: true,
            outDir: staticBuild ? "dist/.solkit/server" : "dist/server",
            emptyOutDir: false,
            rollupOptions: {
              input: SERVER_ENTRY,
              output: { entryFileNames: "app.mjs" },
            },
          },
          ssr: { noExternal: true },
        };
      }
      return environment.command === "serve" && !environment.isPreview
        ? { appType: "custom", ssr: { noExternal: true } }
        : {
            build: {
              outDir: clientOutDir,
              emptyOutDir: true,
              manifest: staticBuild ? ".solkit/manifest.json" : false,
            },
          };
    },
    configResolved(resolved) {
      config = resolved;
    },
    resolveId: {
      order: "pre",
      handler(id) {
        if (id === CLIENT_ENTRY) return RESOLVED_CLIENT_ENTRY;
        if (id === SERVER_ENTRY || id === SERVER_ENTRY_URL) return RESOLVED_SERVER_ENTRY;
        if (id === ADAPTER_ENTRY) return RESOLVED_ADAPTER_ENTRY;
        return null;
      },
    },
    load(id) {
      if (id === RESOLVED_CLIENT_ENTRY) {
        return `import { configureRouterBase, configureRouterNavigation, hydrate, routerReady } from "@soljs/sol";
import { ${exportName} as Root } from ${JSON.stringify(options.entry)};
const target = document.querySelector("#app");
if (!target) throw new Error("The #app hydration target is missing");
document.querySelectorAll("link[${DEV_STYLE_ATTRIBUTE}]").forEach((link) => link.remove());
configureRouterNavigation(${JSON.stringify(staticBuild ? "document" : "history")});
await configureRouterBase(import.meta.env.BASE_URL);
await routerReady;
await hydrate(Root, target);
document.documentElement.dataset.solkitHydrated = "true";`;
      }
      if (id === RESOLVED_ADAPTER_ENTRY) return "export {};";
      if (id === RESOLVED_SERVER_ENTRY) {
        const rootImport = staticBuild
          ? `import * as __solkit_entry from ${JSON.stringify(options.entry)};
const Root = __solkit_entry[${JSON.stringify(exportName)}];
import { staticRoutePaths, staticRoutes } from "virtual:sol/routes";`
          : `import { ${exportName} as Root } from ${JSON.stringify(options.entry)};`;
        const staticPathExport = staticBuild
          ? `export const staticPaths = __solkit_entry.staticPaths;
export { staticRoutePaths, staticRoutes };`
          : "";
        return `import { createRequestHandler } from "@soljs/solkit";
import { configureRouterRoutes } from "@soljs/sol";
import { configureRouteBase } from "@soljs/sol/compiler-runtime";
import routes from "virtual:sol/routes";
import endpoints from "virtual:sol/server-endpoints";
${rootImport}
configureRouteBase(${JSON.stringify(config.base)});
await configureRouterRoutes(routes);
export const handle = createRequestHandler(Root, endpoints, { logicalPaths: ${staticBuild}, maxBodyBytes: ${JSON.stringify(options.maxBodyBytes)} });
${staticPathExport}`;
      }
      return null;
    },
    transformIndexHtml: {
      order: "pre",
      handler() {
        const source = config.command === "serve" ? `/@id/${CLIENT_ENTRY}` : CLIENT_ENTRY;
        return [{ tag: "script", attrs: { type: "module", src: source }, injectTo: "body" }];
      },
    },
    configureServer(server: ViteDevServer) {
      return () => {
        server.middlewares.use((incoming, outgoing, next) => {
          void (async () => {
            const source = await readFile(join(config.root, "index.html"), "utf8");
            const transformedTemplate = await server.transformIndexHtml(
              incoming.url ?? "/",
              source,
            );
            const template = injectDevStyles(transformedTemplate, await collectDevStyles(server));
            const module = (await server.ssrLoadModule(SERVER_ENTRY_URL)) as {
              handle?: RequestHandler;
            };
            if (typeof module.handle !== "function") {
              throw new TypeError("Solkit server entry did not export a request handler");
            }
            await sendResponse(
              await module.handle(requestFromNode(incoming), { template, development: true }),
              outgoing,
            );
          })().catch((error: unknown) => {
            server.ssrFixStacktrace(error as Error);
            next(error);
          });
        });
      };
    },
    generateBundle: {
      order: "pre",
      async handler(_output, bundle) {
        if (!adapterBuild) return;
        for (const fileName of Object.keys(bundle)) delete bundle[fileName];
        const outputDirectory = resolve(config.root, config.build.outDir);
        const serverDirectory = resolve(
          config.root,
          staticBuild ? "dist/.solkit/server" : "dist/server",
        );
        await options.adapter.write({
          serverDirectory,
          clientDirectory: resolve(config.root, clientOutDir),
          writeFile: (file, source) => {
            const fileName = normalizePath(relative(outputDirectory, file));
            if (
              !fileName ||
              fileName === ".." ||
              fileName.startsWith("../") ||
              isAbsolute(fileName)
            ) {
              throw new TypeError(`Adapter output ${file} must be inside ${outputDirectory}`);
            }
            this.emitFile({ type: "asset", fileName, source });
          },
        });
      },
    },
  };
}
