import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Connect, type Plugin, type ResolvedConfig, type ViteDevServer } from "vite";
import { bunAdapter } from "../src/adapters/bun.ts";
import { staticAdapter } from "../src/adapters/static.ts";
import type { SolkitAdapterContext } from "../src/types.ts";
import { solkit } from "../src/vite.ts";

test("validates Vite integration options", () => {
  expect(() => solkit({ entry: "src/app.tsx", adapter: bunAdapter() })).toThrow("root-relative");
  expect(() =>
    solkit({ entry: "/src/app.tsx", exportName: "not-valid!", adapter: bunAdapter() }),
  ).toThrow("identifier");
  expect(() => solkit({ entry: "/src/app.tsx", adapter: bunAdapter(), maxBodyBytes: 1.5 })).toThrow(
    "maxBodyBytes",
  );
  expect(() =>
    solkit({ entry: "/src/app.tsx", adapter: { name: "bad", static: "yes", write() {} } as never }),
  ).toThrow("static marker");
  expect(solkit({ entry: "/src/app.tsx", adapter: bunAdapter() }).name).toBe("solkit");
});

test("keeps framework packages inside the development SSR module runner", () => {
  const plugin = solkit({ entry: "/src/app.tsx", adapter: bunAdapter() });
  const configure = plugin.config as unknown as (
    config: Record<string, never>,
    environment: { command: "serve"; isPreview: boolean },
  ) => unknown;

  expect(configure({}, { command: "serve", isPreview: false })).toEqual({
    appType: "custom",
    ssr: { noExternal: true },
  });
});

test("configures the route base in dynamic server entries", () => {
  const plugin = solkit({ entry: "/src/app.tsx", adapter: bunAdapter() });
  (plugin.configResolved as (config: ResolvedConfig) => void)({ base: "/sol/" } as ResolvedConfig);

  const source = (plugin.load as (id: string) => string)("\0virtual:solkit/server");

  expect(source).toContain('import { configureRouteBase } from "@soljs/sol/compiler-runtime"');
  expect(source).toContain('configureRouteBase("/sol/")');
  expect(source).toContain("logicalPaths: false");

  const staticPlugin = solkit({ entry: "/src/app.tsx", adapter: staticAdapter() });
  (staticPlugin.configResolved as (config: ResolvedConfig) => void)({
    base: "/sol/",
  } as ResolvedConfig);
  const staticSource = (staticPlugin.load as (id: string) => string)("\0virtual:solkit/server");
  expect(staticSource).toContain("logicalPaths: true");
  expect(staticSource).toContain("staticRoutePaths, staticRoutes");

  const clientSource = (staticPlugin.load as (id: string) => string)("\0virtual:solkit/client");
  expect(clientSource).toContain('configureRouterNavigation("document")');
});

test("loads the development server entry through its Vite module URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "solkit-dev-entry-"));
  try {
    await writeFile(
      join(root, "index.html"),
      "<!doctype html><html><head><!--solkit-head--></head><body><!--solkit-body--></body></html>",
    );
    const plugin = solkit({ entry: "/src/app.tsx", adapter: bunAdapter() });
    (plugin.configResolved as (config: ResolvedConfig) => void)({
      base: "/",
      command: "serve",
      root,
    } as ResolvedConfig);

    let middleware: Connect.NextHandleFunction | undefined;
    let loadedId: string | undefined;
    let complete: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const server = {
      environments: {
        client: {
          moduleGraph: {
            async getModuleByUrl() {
              return undefined;
            },
          },
        },
      },
      middlewares: {
        use(handler: Connect.NextHandleFunction) {
          middleware = handler;
        },
      },
      async ssrLoadModule(id: string) {
        loadedId = id;
        return { handle: async () => new Response("ready") };
      },
      ssrFixStacktrace() {},
      async transformIndexHtml(_url: string, template: string) {
        return template;
      },
      async transformRequest() {
        return null;
      },
    } as unknown as ViteDevServer;
    const configure = plugin.configureServer as (server: ViteDevServer) => () => void;
    configure(server)();

    middleware!(
      { headers: { host: "localhost" }, method: "GET", url: "/" } as IncomingMessage,
      {
        end() {
          complete!();
        },
        setHeader() {},
        statusCode: 0,
      } as unknown as ServerResponse,
      (error?: unknown) => {
        throw error;
      },
    );
    await completed;

    expect(loadedId).toBe("/@solkit/server");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("emits adapter output through Vite's output pipeline", async () => {
  const previousTarget = process.env.SOLKIT_BUILD_TARGET;
  process.env.SOLKIT_BUILD_TARGET = "adapter";
  const emitted: Array<{ readonly fileName?: string; readonly source?: unknown }> = [];
  try {
    const plugin = solkit({
      entry: "/src/app.tsx",
      adapter: Object.assign(
        {
          name: "capture",
          async write(context: SolkitAdapterContext) {
            expect(context.writeFile).toBeFunction();
            await context.writeFile?.(join(context.clientDirectory, "docs", "index.html"), "docs");
          },
        },
        { static: true as const },
      ),
    });
    const configured = Reflect.apply(plugin.config as (...args: never[]) => unknown, plugin, [
      {},
      { command: "build", mode: "production" },
    ]);
    expect(configured).toMatchObject({
      build: { outDir: "dist", emptyOutDir: false, manifest: false },
    });
    (plugin.configResolved as (config: ResolvedConfig) => void)({
      root: "/project",
      build: { outDir: "dist" },
    } as ResolvedConfig);
    const bundle = { ".solkit/adapter.js": {} };
    const hook = plugin.generateBundle as {
      order: string;
      handler: (
        this: { emitFile(asset: unknown): void },
        output: unknown,
        bundle: unknown,
      ) => Promise<void>;
    };
    expect(hook.order).toBe("pre");
    await Reflect.apply(
      hook.handler,
      {
        emitFile: (asset: unknown) =>
          emitted.push(asset as { readonly fileName?: string; readonly source?: unknown }),
      },
      [{}, bundle],
    );
    expect(Object.keys(bundle)).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.fileName).toBe("docs/index.html");
    expect(emitted[0]?.source).toBe("docs");
  } finally {
    if (previousTarget === undefined) delete process.env.SOLKIT_BUILD_TARGET;
    else process.env.SOLKIT_BUILD_TARGET = previousTarget;
  }
});

test("makes emitted adapter HTML visible to later Vite output hooks", async () => {
  const previousTarget = process.env.SOLKIT_BUILD_TARGET;
  const root = await mkdtemp(join(tmpdir(), "solkit-vite-output-"));
  let observedSource: string | Uint8Array | undefined;
  process.env.SOLKIT_BUILD_TARGET = "adapter";
  try {
    const adapter = Object.assign(
      {
        name: "integration-output",
        async write(context: SolkitAdapterContext) {
          expect(context.writeFile).toBeFunction();
          await context.writeFile?.(
            join(context.clientDirectory, "docs", "index.html"),
            "<!doctype html><title>Docs</title>",
          );
        },
      },
      { static: true as const },
    );
    const observer: Plugin = {
      name: "observe-solkit-output",
      enforce: "post",
      generateBundle: {
        order: "post",
        handler(_options, bundle) {
          const page = bundle["docs/index.html"];
          expect(page?.type).toBe("asset");
          if (page?.type === "asset") observedSource = page.source;
        },
      },
    };

    await build({
      root,
      logLevel: "silent",
      plugins: [solkit({ entry: "/src/app.tsx", adapter }), observer],
    });

    expect(observedSource).toBe("<!doctype html><title>Docs</title>");
  } finally {
    await rm(root, { recursive: true });
    if (previousTarget === undefined) delete process.env.SOLKIT_BUILD_TARGET;
    else process.env.SOLKIT_BUILD_TARGET = previousTarget;
  }
});
