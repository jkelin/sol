import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isCSSRequest,
  type EnvironmentModuleNode,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
} from "vite";
import type { RequestHandler, SolkitOptions } from "./types.ts";

const CLIENT_ENTRY = "virtual:solkit/client";
const SERVER_ENTRY = "virtual:solkit/server";
const RESOLVED_CLIENT_ENTRY = `\0${CLIENT_ENTRY}`;
const RESOLVED_SERVER_ENTRY = `\0${SERVER_ENTRY}`;
const BUILD_TARGET = "SOLKIT_BUILD_TARGET";
const DEV_STYLE_ATTRIBUTE = "data-solkit-dev-style";

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
  const unexpected = Object.keys(options).find(
    (key) => key !== "entry" && key !== "exportName" && key !== "adapter",
  );
  if (unexpected) throw new TypeError(`Unknown solkit() option ${unexpected}`);
}

async function requestFromNode(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const collected = Buffer.concat(await Array.fromAsync(request));
    body = collected.buffer.slice(
      collected.byteOffset,
      collected.byteOffset + collected.byteLength,
    ) as ArrayBuffer;
  }
  return new Request(new URL(request.url ?? "/", `http://${host}`), {
    method,
    headers,
    body,
  });
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
    if (module && isCSSRequest(module.url)) {
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
  let config: ResolvedConfig;
  let serverBuild = false;

  return {
    name: "solkit",
    enforce: "post",
    config(_config, environment) {
      serverBuild = environment.command === "build" && process.env[BUILD_TARGET] === "server";
      if (serverBuild) {
        return {
          build: {
            ssr: true,
            outDir: "dist/server",
            emptyOutDir: false,
            rollupOptions: {
              input: SERVER_ENTRY,
              output: { entryFileNames: "app.mjs" },
            },
          },
          ssr: { noExternal: true },
        };
      }
      return environment.command === "serve"
        ? { appType: "custom" }
        : { build: { outDir: "dist/client", emptyOutDir: true } };
    },
    configResolved(resolved) {
      config = resolved;
    },
    resolveId: {
      order: "pre",
      handler(id) {
        if (id === CLIENT_ENTRY) return RESOLVED_CLIENT_ENTRY;
        if (id === SERVER_ENTRY) return RESOLVED_SERVER_ENTRY;
        return null;
      },
    },
    load(id) {
      if (id === RESOLVED_CLIENT_ENTRY) {
        return `import { hydrate, routerReady } from "solix";
import { ${exportName} as Root } from ${JSON.stringify(options.entry)};
const target = document.querySelector("#app");
if (!target) throw new Error("The #app hydration target is missing");
document.querySelectorAll("link[${DEV_STYLE_ATTRIBUTE}]").forEach((link) => link.remove());
await routerReady;
await hydrate(Root, target);
document.documentElement.dataset.solkitHydrated = "true";`;
      }
      if (id === RESOLVED_SERVER_ENTRY) {
        return `import { createRequestHandler } from "solkit";
import endpoints from "virtual:solix/server-endpoints";
import { ${exportName} as Root } from ${JSON.stringify(options.entry)};
export const handle = createRequestHandler(Root, endpoints);`;
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
            const module = (await server.ssrLoadModule(SERVER_ENTRY)) as {
              handle?: RequestHandler;
            };
            if (typeof module.handle !== "function") {
              throw new TypeError("Solkit server entry did not export a request handler");
            }
            await sendResponse(
              await module.handle(await requestFromNode(incoming), { template, development: true }),
              outgoing,
            );
          })().catch((error: unknown) => {
            server.ssrFixStacktrace(error as Error);
            next(error);
          });
        });
      };
    },
    async closeBundle() {
      if (!serverBuild) return;
      await options.adapter.write({
        serverDirectory: resolve(config.root, config.build.outDir),
        clientDirectory: resolve(config.root, "dist/client"),
      });
    },
  };
}
