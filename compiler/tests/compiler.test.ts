import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMapConsumer } from "source-map-js";
import {
  build,
  normalizePath,
  type IndexHtmlTransformResult,
  type ResolvedConfig,
  type ViteDevServer,
} from "vite";
import { compile } from "../src/index.ts";
import { sol } from "../src/vite.ts";

function linkSource(link: string): string {
  return `
    import { $component, Link } from "@soljs/sol";
    import { detail } from "./detail.route";
    const App = $component(function App() { return ${link}; });
  `;
}

function componentSource(jsx: string, imports = ""): string {
  return `
    import { $component${imports} } from "@soljs/sol";
    const Child = $component(function Child() { return <p>Child</p>; });
    const App = $component(function App() { return ${jsx}; });
  `;
}

function injectedDevtools(command: "serve" | "build", enabled?: boolean): IndexHtmlTransformResult {
  const plugin = enabled === undefined ? sol() : sol({ devtools: enabled });
  const resolve = plugin.configResolved as unknown as (config: ResolvedConfig) => void;
  const transform = plugin.transformIndexHtml as unknown as {
    handler(): IndexHtmlTransformResult;
  };
  resolve({ command, root: "/project" } as ResolvedConfig);
  return transform.handler();
}

describe("compiler", () => {
  test("compiles exported route declarations and path parameters", () => {
    const result = compile(
      `
      import { $component, $route } from "@soljs/sol";
      const Blog = $component(function Blog() { return <main>Blog</main>; });
      export const blog = $route({ path: "/blog/:id?copy=:id&filter=:filter" }, Blog);
    `,
      "blog.sol.tsx",
    );

    expect(result.code).toContain("export const blog = __sol_route");
    expect(result.code).toContain('"pattern":"^/blog/([^/]+)$"');
    expect(result.code).toContain('"parameterNames":["id","filter"]');
    expect(result.code).toContain('"pathnameParameterNames":["id"]');
    expect(result.code).toContain(
      '"queryParameters":[{"key":"copy","name":"id"},{"key":"filter","name":"filter"}]',
    );
    expect(result.code).toContain('"specificity":[1,0]');

    const handle = compile(
      `import { Page } from "./Page";
       export const page = $route({ path: "/page" }, Page);`,
      "page.sol.tsx",
      { routeMode: "handle" },
    );
    expect(handle.code).toContain("export const page = __sol_route_handle");
    expect(handle.code).toContain('__sol_route_handle({ path: "/page" }');
    expect(handle.code).not.toContain("__sol_route({");

    for (const extension of ["ts", "tsx"]) {
      const routeModule = compile(
        `import { Page } from "./Page";
         export const page = $route({ path: "/page" }, Page);`,
        `page.sol.${extension}`,
      );
      expect(routeModule.code).toContain("export const page = __sol_route");
    }
  });

  test("projects route handles without schemas or route-owned styles", () => {
    const source = `
      import "./page.css";
      import { schema } from "./schema";
      import { Page } from "./Page";
      export const page = $route({ path: "/page/:id", schema }, Page);
    `;
    const handle = compile(source, "page.sol.tsx", { routeMode: "handle" });
    const page = compile(source, "page.sol.tsx", { routeMode: "page" });

    expect(handle.code).toContain('__sol_route_handle({ path: "/page/:id" }');
    expect(handle.code).not.toContain("./page.css");
    expect(handle.code).not.toMatch(/__sol_route_handle\([^;]*schema/);
    expect(page.code).toContain('import "./page.css"');
    expect(page.code).toContain("schema\n}, Page");
  });

  test("validates public compile projection options", () => {
    for (const filename of ["", 123, {}, []]) {
      expect(() => compile("", filename as never)).toThrow(
        "compile() filename must be a non-empty string",
      );
    }
    expect(() => compile("", "page.sol.ts", null as never)).toThrow(
      "compile() options must be an object",
    );
    expect(() => compile("", "page.sol.ts", Object.create({ target: "client" }) as never)).toThrow(
      "compile() options must be a plain object",
    );
    expect(() => compile("", "page.sol.ts", { unknown: true } as never)).toThrow(
      "compile() options contains unknown property unknown",
    );
    expect(() => compile("", "page.sol.ts", { [Symbol("unknown")]: true } as never)).toThrow(
      "compile() options contains unknown property Symbol(unknown)",
    );
    const hidden = Object.defineProperty({}, "target", { value: "client" });
    expect(() => compile("", "page.sol.ts", hidden)).toThrow(
      "compile() options target must be an enumerable data property",
    );
    let reads = 0;
    const accessor = Object.defineProperty({}, "target", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? undefined : "worker";
      },
    });
    expect(() => compile("", "page.sol.ts", accessor)).toThrow(
      "compile() options target must be an enumerable data property",
    );
    expect(reads).toBe(0);
    expect(() => compile("", "page.sol.ts", { target: "worker" as never })).toThrow(
      'compile() target must be "client" or "server"',
    );
    expect(() => compile("", "page.sol.ts", { routeMode: "eager" as never })).toThrow(
      'compile() routeMode must be "handle" or "page"',
    );
  });

  test("canonicalizes static route segments for URL pathname matching", () => {
    const result = compile(
      `import { Page } from "./Page";
       export const page = $route({ path: "/cafe au lait/Crème" }, Page);`,
      "page.sol.tsx",
    );

    expect(result.code).toContain('"pattern":"^/cafe%20au%20lait/Cr%C3%A8me$"');
  });

  test("preserves authored mapping-sentinel text", () => {
    const result = compile(
      `import { $component } from "@soljs/sol";
       const token = "/*__sol_source_0__*/";
       export const App = $component(function App() { return <p>{token}</p>; });`,
      "sentinel.tsx",
    );

    expect(result.code).toContain('"/*__sol_source_0__*/"');
  });

  test("does not treat a shadowed $component as the compiler intrinsic", () => {
    const source = `function $component<T>(value: T): T { return value; }
      export const value = $component(1);`;
    expect(compile(source, "ordinary.ts").code).toBe(source);
  });

  test("resolves reactive and ref helpers by lexical binding", () => {
    const result = compile(
      `import { $component, $signal as state, $computed as derive, createRef as makeRef } from "@soljs/sol";
       export const App = $component(function App() {
         const count = state(1);
         const doubled = derive(() => count * 2);
         const reference = makeRef<HTMLDivElement>();
         const locallyWrapped = (() => { const state = (value: number) => value; return state(3); })();
         const shadowedRef = (() => { const makeRef = () => 4; return makeRef(); })();
         return <div ref={reference}>{doubled + locallyWrapped + shadowedRef}</div>;
       });`,
      "helpers.tsx",
    );

    expect(result.code).toContain("const count = __sol_signal(1)");
    expect(result.code).toContain("const doubled = __sol_computed(() => count.value * 2");
    expect(result.code).toContain("const reference = makeRef<HTMLDivElement>();");
    expect(result.code).toContain("const locallyWrapped = __sol_signal");
    expect(result.code).toContain("const shadowedRef = __sol_signal");
  });

  test("ignores lexically shadowed declaration helper names", () => {
    const result = compile(
      `import { $component } from "@soljs/sol";
       export const App = $component(function App() { return <p>Ready</p>; });
       export function invoke($route: () => string) { return $route(); }`,
      "shadowed-route.sol.tsx",
    );

    expect(result.code).toContain("return $route();");
  });

  test("serializes static aria and data booleans as strings", () => {
    const result = compile(
      `import { $component } from "@soljs/sol";
       export const App = $component(function App() {
         return <div aria-hidden={false} data-on={true}>Ready</div>;
       });`,
      "attributes.tsx",
    );

    expect(result.code).toContain('aria-hidden="false"');
    expect(result.code).toContain('data-on="true"');
  });

  test("serializes static numeric intrinsic attributes", () => {
    const result = compile(
      `import { $component } from "@soljs/sol";
       export const App = $component(function App() {
         return <>
           <input tabIndex={1} maxLength={12} disabled={0} checked={1} />
           <img isMap={0} />
           <div itemScope={0}>Item</div>
         </>;
       });`,
      "numeric-attributes.tsx",
    );

    expect(result.code).toContain('tabIndex="1"');
    expect(result.code).toContain('maxLength="12"');
    expect(result.code).not.toContain('disabled="0"');
    expect(result.code).not.toContain('checked="1"');
    expect(result.code).not.toContain('isMap="0"');
    expect(result.code).not.toContain('itemScope="0"');
    expect(result.code).toContain('"disabled", () => (0)');
    expect(result.code).toContain('"checked", () => (1)');
    expect(result.code).toContain('"isMap", () => (0)');
    expect(result.code).toContain('"itemScope", () => (0)');
  });

  test("interns identical compiled templates", () => {
    const result = compile(
      `import { $component } from "@soljs/sol";
       export const First = $component(function First() { return <p>Same</p>; });
       export const Second = $component(function Second() { return <p>Same</p>; });`,
      "templates.tsx",
    );

    expect(result.code.match(/const __sol_template_\d+ =/g)).toHaveLength(1);
    expect(result.code.match(/__sol_instantiate\(__sol_template_0/g)).toHaveLength(2);
  });

  test("interns identical dynamic templates without source-marker differences", () => {
    const result = compile(
      `import { $component } from "@soljs/sol";
       export const First = $component(function First(props: { value: string }) { return <p>{props.value}</p>; });
       export const Second = $component(function Second(props: { value: string }) { return <p>{props.value}</p>; });`,
      "dynamic-templates.tsx",
    );

    expect(result.code.match(/const __sol_template_\d+ =/g)).toHaveLength(1);
    expect(result.code.match(/__sol_instantiate\(__sol_template_0/g)).toHaveLength(2);
  });

  test("uses collision-resistant template signatures", () => {
    const signatures = ["24596503", "389587026"].map((value) => {
      const result = compile(
        `const App = $component(function App() { return <div data-x="${value}"></div>; });`,
        `${value}.tsx`,
      );
      return /__sol_template\(`[^`]*`, "([^"]+)"/.exec(result.code)?.[1];
    });

    expect(signatures[0]).toBeTruthy();
    expect(signatures[0]).not.toBe(signatures[1]);
  });

  test("does not import runtime helpers mentioned only in authored text", () => {
    const result = compile(
      `import { $component } from "@soljs/sol";
       const diagnostic = { __sol_portal: "__sol_portal" };
       export const App = $component(function App() { return <p>{diagnostic.__sol_portal}</p>; });`,
      "text.tsx",
    );
    expect(result.code).not.toContain("portal as __sol_portal");
  });

  test("omits cleanup and lifecycle scaffolding from static templates", () => {
    const result = compile(
      `import { $component } from "@soljs/sol";
       export const App = $component(function App() { return <p>Static</p>; });`,
      "static.tsx",
    );

    expect(result.code).not.toContain("blockLifecycle as __sol_block_lifecycle");
    expect(result.code).not.toContain("rethrowWithCleanups as __sol_rethrow");
    expect(result.code).not.toContain("const __sol_cleanups");
  });

  test("preserves route schemas and compiles Link into its anchor child", () => {
    const result = compile(
      `
      import { $component, $route, Link as RouteLink } from "@soljs/sol";
      const schema = { parse: value => value };
      const Blog = $component(function Blog() { return <main>Blog</main>; });
      export const blog = $route({ path: "/blog/:id", schema }, Blog);
      export const Navigation = $component(function Navigation() {
        const params = { id: "first" };
        const replace: any = "false";
        return <RouteLink route={blog} params={params} replace={replace}><a class="entry">Open</a></RouteLink>;
      });
    `,
      "blog.sol.tsx",
    );

    expect(result.code).toContain('__sol_route({\n  path: "/blog/:id",\n  schema\n}');
    expect(result.code).toContain("__sol_link(__sol_view.elements[0]");
    expect(result.code).not.toContain("Boolean(replace)");
    expect(result.code).toContain('class="entry"');
    expect(result.code).not.toContain("<RouteLink");
  });

  test("compiles server declarations for server and browser targets", () => {
    const source = `
      import { $httpRoute, $rpcMutation, $rpcQuery } from "@soljs/sol";
      const schema = value => value;
      export const load = $rpcQuery("load", { schema }, async (id) => ({ id }));
      export const save = $rpcMutation("save", { schema }, async (value) => value);
      export const health = $httpRoute(
        { method: "GET", path: "/api/health/:scope", schema },
        async () => new Response("ok"),
      );
    `;
    const server = compile(source, "api.sol.ts", { target: "server" });
    expect(server.code).toContain('__sol_rpc_query_server("load"');
    expect(server.code).toContain('__sol_rpc_mutation_server("save"');
    expect(server.code).toContain("__sol_http_route_server({");
    expect(server.code).toContain('new Response("ok")');

    const client = compile(source, "api.sol.ts", { target: "client" });
    expect(client.code).toContain('__sol_rpc_query_client("load")');
    expect(client.code).toContain('__sol_rpc_mutation_client("save")');
    expect(client.code).toContain(
      '__sol_http_route_client({ method: "GET", path: "/api/health/:scope" })',
    );
    expect(client.code).not.toContain('new Response("ok")');
    expect(client.code).not.toContain("async (id)");
  });

  test("resolves server declaration helpers by Sol binding identity", () => {
    const alias = compile(
      `import { $rpcQuery as declareQuery } from "@soljs/sol";
       import { backend } from "./backend-secret";
       export const load = declareQuery("load", { schema: value => value }, backend);`,
      "alias.sol.ts",
      { target: "client" },
    );
    expect(alias.code).toContain('__sol_rpc_query_client("load")');
    expect(alias.code).not.toContain("backend-secret");
    const shadowed = `function $rpcQuery() { return "local"; }
      export const value = $rpcQuery("local", { schema: true }, 42);`;
    expect(compile(shadowed, "shadowed.sol.ts", { target: "client" })).toEqual({
      code: shadowed,
      map: null,
    });
    const namespace = compile(
      `import * as sol from "@soljs/sol";
       const load = sol.$rpcQuery("load", { schema: x => x }, async () => 1);
       const save = sol["$rpcMutation"]("save", { schema: x => x }, async () => 1);
       export { load as query, save };`,
      "namespace.sol.ts",
      { target: "client" },
    );
    expect(namespace.code).toContain('const load = __sol_rpc_query_client("load")');
    expect(namespace.code).toContain('const save = __sol_rpc_mutation_client("save")');
    expect(namespace.code).toContain("export { load as query, save }");
  });

  test("removes imports referenced only by stripped browser handlers", () => {
    const result = compile(
      `
        import { readFile } from "node:fs/promises";
        import { $rpcQuery } from "@soljs/sol";
        const serverRoot = "/private";
        async function readSecret(path) {
          return readFile(serverRoot + path, "utf8");
        }
        export const secret = $rpcQuery(
          "secret",
          { schema: value => value },
          readSecret,
        );
      `,
      "secret.sol.ts",
      { target: "client" },
    );
    expect(result.code).not.toContain("node:fs/promises");
    expect(result.code).not.toContain("readFile");
    expect(result.code).not.toContain("readSecret");
    expect(result.code).not.toContain("serverRoot");
    expect(result.code).not.toContain("$rpcQuery");
    expect(result.code).toContain('__sol_rpc_query_client("secret")');
  });

  test("keeps backend handlers, validators, dependencies, and secrets out of client modules", () => {
    const source = `
      import { $httpRoute, $rpcMutation, $rpcQuery } from "@soljs/sol";
      import type { PublicResult } from "./public-types";
      import { backendDatabase } from "./backend-database-secret";
      import { backendValidator } from "./backend-validator-secret";
      export const frontendMarker = "🧪 FRONTEND_SOURCE_REMAINS";

      export const exportedSchema = backendValidator("BACKEND_SCHEMA_IMPLEMENTATION_SECRET");
      const handlerSecret = "BACKEND_HANDLER_CLOSURE_SECRET";
      export function exportedBackendHelper(value) {
        return backendDatabase(handlerSecret, value);
      }

      export const load = $rpcQuery(
        "load",
        { schema: exportedSchema },
        async (id): Promise<PublicResult> => exportedBackendHelper(id),
      );
      export const save = $rpcMutation(
        "save",
        { schema: exportedSchema },
        async (value): Promise<PublicResult> => exportedBackendHelper(value),
      );
      export const download = $httpRoute(
        { method: "POST", path: "/api/download", schema: exportedSchema },
        async (input) => Response.json(await exportedBackendHelper(input)),
      );
    `;
    const server = compile(source, "private.sol.ts", { target: "server" }).code;
    expect(server).toContain("backend-database-secret");
    expect(server).toContain("backend-validator-secret");
    expect(server).toContain("BACKEND_SCHEMA_IMPLEMENTATION_SECRET");
    expect(server).toContain("BACKEND_HANDLER_CLOSURE_SECRET");

    const clientResult = compile(source, "private.sol.ts", { target: "client" });
    const client = clientResult.code;
    expect(client).toContain('import type { PublicResult } from "./public-types"');
    expect(client).toContain('__sol_rpc_query_client("load")');
    expect(client).toContain('__sol_rpc_mutation_client("save")');
    expect(client).toContain('__sol_http_route_client({ method: "POST", path: "/api/download" })');
    expect(client).not.toContain("backend-database-secret");
    expect(client).not.toContain("backend-validator-secret");
    expect(client).not.toContain("BACKEND_SCHEMA_IMPLEMENTATION_SECRET");
    expect(client).not.toContain("BACKEND_HANDLER_CLOSURE_SECRET");
    expect(client).not.toContain("exportedSchema");
    expect(client).not.toContain("exportedBackendHelper");
    expect(client).not.toContain("backendDatabase");
    expect(client).not.toContain("backendValidator");
    const clientSources = clientResult.map?.sourcesContent?.join("\n") ?? "";
    expect(clientSources).toContain("PublicResult");
    expect(clientSources).toContain("🧪 FRONTEND_SOURCE_REMAINS");
    expect(clientSources).not.toContain("backend-database-secret");
    expect(clientSources).not.toContain("backend-validator-secret");
    expect(clientSources).not.toContain("BACKEND_SCHEMA_IMPLEMENTATION_SECRET");
    expect(clientSources).not.toContain("BACKEND_HANDLER_CLOSURE_SECRET");
    expect(clientSources).not.toContain("exportedSchema");
    expect(clientSources).not.toContain("exportedBackendHelper");
  });

  test("removes assignment-built and mixed server dependencies from client modules", () => {
    const assigned = compile(
      `
        import { backendValidator } from "./backend-assignment-secret";
        export let schema;
        // BACKEND_ASSIGNMENT_COMMENT_SECRET
        schema = backendValidator("BACKEND_ASSIGNMENT_VALUE_SECRET");
        export const load = $rpcQuery("load", { schema }, async () => 1);
      `,
      "assigned.sol.ts",
      { target: "client" },
    );
    expect(assigned.code).toContain('__sol_rpc_query_client("load")');
    expect(assigned.code).not.toContain("backend-assignment-secret");
    expect(assigned.code).not.toContain("BACKEND_ASSIGNMENT_COMMENT_SECRET");
    expect(assigned.code).not.toContain("BACKEND_ASSIGNMENT_VALUE_SECRET");
    expect(assigned.map?.sourcesContent?.join("\n")).not.toContain("BACKEND_ASSIGNMENT");

    const mixed = compile(
      `
        import { backendValidator } from "./backend-mixed-secret";
        // BACKEND_MIXED_COMMENT_SECRET
        const schema = backendValidator("BACKEND_MIXED_SCHEMA_SECRET"), frontendLabel = "Public";
        export const load = $rpcQuery("load", { schema }, async () => 1);
        export const App = $component(function App() { return <p>{frontendLabel}</p>; });
      `,
      "mixed.sol.tsx",
      { target: "client" },
    );
    expect(mixed.code).toContain('const frontendLabel = "Public"');
    expect(mixed.code).toContain("frontendLabel");
    expect(mixed.code).not.toContain("backend-mixed-secret");
    expect(mixed.code).not.toContain("BACKEND_MIXED_SCHEMA_SECRET");
    expect(mixed.code).not.toContain("backendValidator");
    expect(mixed.map?.sourcesContent?.join("\n")).not.toContain("BACKEND_MIXED");
    const effect = compile(
      `import { configure, secret } from "./backend-effect-secret";
       const schema = {}; configure(schema, secret);
       export const load = $rpcQuery("load", { schema }, async () => 1);`,
      "effect.sol.ts",
      { target: "client" },
    );
    expect(effect.code).not.toContain("backend-effect-secret");
    expect(effect.code).not.toContain("configure(");
    expect(() =>
      compile(
        `const schema = {}; function configure(value) {} function frontendInit() {}
         configure(schema), frontendInit();
         export const load = $rpcQuery("load", { schema }, async () => 1);`,
        "ambiguous.sol.ts",
        { target: "client" },
      ),
    ).toThrow("Ambiguous top-level server dependency effect");
    expect(() =>
      compile(
        `function configure(schema, state) { state.ready = true; }
         export const frontendState = { ready: false }; const schema = {};
         configure(schema, frontendState);
         export const load = $rpcQuery("load", { schema }, async () => 1);`,
        "retained-effect.sol.ts",
        { target: "client" },
      ),
    ).toThrow("uses retained binding frontendState");
  });

  test("removes comments attached to stripped server dependencies", () => {
    const result = compile(
      `
        import { $rpcQuery } from "@soljs/sol";
        // BACKEND_HANDLER_COMMENT_SECRET
        function backendHandler() { return Promise.resolve("secret"); }
        export const load = $rpcQuery("load", { schema: value => value }, backendHandler);
      `,
      "comments.sol.ts",
      { target: "client" },
    );
    expect(result.code).not.toContain("BACKEND_HANDLER_COMMENT_SECRET");
    expect(result.map?.sourcesContent?.join("\n")).not.toContain("BACKEND_HANDLER_COMMENT_SECRET");
    const trailing = compile(
      `export const load = $rpcQuery("load", { schema: value => value }, backend);
       function backend() { return Promise.resolve("secret"); } // TRAILING_BACKEND_SECRET`,
      "trailing.sol.ts",
      { target: "client" },
    );
    expect(trailing.code).not.toContain("TRAILING_BACKEND_SECRET");
    expect(trailing.map?.sourcesContent?.join("\n")).not.toContain("TRAILING_BACKEND_SECRET");
  });

  test("validates server declaration boundaries and literal configs", () => {
    const valid = `export const load = $rpcQuery("load", { schema: value => value }, async () => 1);`;
    expect(() => compile(valid, "api.ts")).toThrow("only valid in *.sol.ts");
    expect(() => compile(valid.replace("export ", ""), "api.sol.ts")).toThrow("must be exported");
    expect(() =>
      compile(
        `export const load = $rpcQuery("bad/name", { schema: value => value }, async () => 1);`,
        "api.sol.ts",
      ),
    ).toThrow("URL-safe string literal");
    expect(() =>
      compile(`export const load = $rpcQuery("load", {}, async () => 1);`, "api.sol.ts"),
    ).toThrow("requires a schema");
    expect(() =>
      compile(
        `export const route = $httpRoute({ method: "get", path: "/api", schema: x => x }, async () => new Response());`,
        "api.sol.ts",
      ),
    ).toThrow("supported uppercase string literal");
    expect(() =>
      compile(
        `export const route = $httpRoute({ method: "GET", path: "/api/rpc/custom", schema: x => x }, async () => new Response());`,
        "api.sol.ts",
      ),
    ).toThrow("reserved /api/rpc namespace");
    for (const path of ["//users", "/users/", "/users//new"]) {
      expect(() =>
        compile(
          `export const route = $httpRoute({ method: "GET", path: ${JSON.stringify(path)}, schema: x => x }, async () => new Response());`,
          "api.sol.ts",
        ),
      ).toThrow(/exactly one slash|empty or trailing segments/);
    }
    expect(() =>
      compile(
        `export const route = $httpRoute({ method: "GET", path: "/users/:id/:id", schema: x => x }, async () => new Response());`,
        "api.sol.ts",
      ),
    ).toThrow("Duplicate HTTP route parameter id");
    expect(() =>
      compile(
        `export const route = $httpRoute({ method: "GET", path: "/users/:?draft=1", schema: x => x }, async () => new Response());`,
        "api.sol.ts",
      ),
    ).toThrow("must not contain a query or hash");
    for (const handler of ["42", "null", "{}", "[]", "`not callable`"]) {
      expect(() =>
        compile(
          `export const load = $rpcQuery("load", { schema: x => x }, ${handler});`,
          "api.sol.ts",
        ),
      ).toThrow("handler must be callable");
    }
    expect(() =>
      compile(
        `const handlers = { load: async () => 1 }; export const load = $rpcQuery("load", { schema: x => x }, handlers.load);`,
        "api.sol.ts",
      ),
    ).not.toThrow();
    const canonical = compile(
      `export const route = $httpRoute({ method: "GET", path: "/cafe\u0301 space/:id", schema: x => x }, async () => new Response());`,
      "api.sol.ts",
    );
    expect(canonical.code).toContain('path: "/caf%C3%A9%20space/:id"');
    for (const path of ["/back\\slash", "/dot/../path", "/encoded/%20path", "/hash#part"]) {
      expect(() =>
        compile(
          `export const route = $httpRoute({ method: "GET", path: ${JSON.stringify(path)}, schema: x => x }, async () => new Response());`,
          "api.sol.ts",
        ),
      ).toThrow(/backslashes|dot segments|decoded static characters|query or hash/);
    }
  });

  test("validates the compiler-specialized Link interface", () => {
    expect(() => compile(linkSource(`<Link><a>Open</a></Link>`), "App.tsx")).toThrow(
      "requires a route property",
    );
    expect(() =>
      compile(linkSource(`<Link route={detail}><button>Open</button></Link>`), "App.tsx"),
    ).toThrow("child must be an intrinsic anchor");
    expect(() =>
      compile(linkSource(`<Link route={detail}><a href="/bad">Open</a></Link>`), "App.tsx"),
    ).toThrow("provides its anchor href");
    expect(() =>
      compile(linkSource(`<Link route={detail}><a>One</a><a>Two</a></Link>`), "App.tsx"),
    ).toThrow("exactly one anchor child");
    expect(() =>
      compile(linkSource(`<Link route={detail} class="bad"><a>Open</a></Link>`), "App.tsx"),
    ).toThrow("Unsupported Link property class");
  });

  test("validates the compile-time route boundary", () => {
    const component = `
      const Blog = $component(function Blog() { return <main>Blog</main>; });
    `;
    expect(() =>
      compile(`${component} export const blog = $route({ path: "/blog/:id" }, Blog);`, "Blog.tsx"),
    ).toThrow("only valid in *.sol.ts or *.sol.tsx files");
    expect(() =>
      compile(`${component} const blog = $route({ path: "/blog/:id" }, Blog);`, "blog.sol.tsx"),
    ).toThrow("must be exported");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "blog/:id" }, Blog);`,
        "blog.sol.tsx",
      ),
    ).toThrow("start with exactly one slash");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog/:id/:id" }, Blog);`,
        "blog.sol.tsx",
      ),
    ).toThrow("Duplicate route parameter id");
    expect(() =>
      compile(`${component} export const blog = $route({ path: "/blog/" }, Blog);`, "blog.sol.tsx"),
    ).toThrow("empty or trailing segments");
    for (const path of ["/docs/../admin", "/./docs", "/docs/%2e%2e/admin"]) {
      expect(() =>
        compile(
          `${component} export const blog = $route({ path: ${JSON.stringify(path)} }, Blog);`,
          "blog.sol.tsx",
        ),
      ).toThrow("dot segments");
    }
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog?draft=1" }, Blog);`,
        "blog.sol.tsx",
      ),
    ).toThrow("Invalid route query parameter draft=1");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog?from=:from&from=:other" }, Blog);`,
        "blog.sol.tsx",
      ),
    ).toThrow("Duplicate route query key from");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog" }, Missing);`,
        "blog.sol.tsx",
      ),
    ).toThrow("must reference a compiled component");
    expect(() =>
      compile(
        `${component} export const blog = $route({ path: "/blog", extra: true }, Blog);`,
        "blog.sol.tsx",
      ),
    ).toThrow("may contain only path and schema");
  });

  test("requires runtime exports for routes and server endpoints", () => {
    const component = `import { $component, $route, $rpcQuery } from "@soljs/sol";
      const Page = $component(function Page() { return <p>Page</p>; });`;
    expect(() =>
      compile(
        `${component}
         const page = $route({ path: "/typed" }, Page);
         export type { page };`,
        "typed-route.sol.tsx",
      ),
    ).toThrow("$route() declarations must be exported");
    expect(() =>
      compile(
        `${component}
         const load = $rpcQuery("load", { schema: value => value }, async () => 1);
         export type { load };`,
        "typed-endpoint.sol.tsx",
      ),
    ).toThrow("$rpcQuery() declarations must be exported");
  });

  test("does not compile declarations through type-only Sol imports", () => {
    const named = compile(
      `import type { $route } from "@soljs/sol";
       const page = $route({ path: "/named-type" }, Page);
       export { page };`,
      "named-type.sol.ts",
    );
    expect(named.code).toContain("const page = $route");
    expect(named.code).not.toContain("__sol_route");

    const namespace = compile(
      `import type * as Sol from "@soljs/sol";
       const page = Sol.$route({ path: "/namespace-type" }, Page);
       export { page };`,
      "namespace-type.sol.ts",
    );
    expect(namespace.code).toContain("Sol.$route");
    expect(namespace.code).not.toContain("__sol_route");
  });

  test("recognizes string-named Sol declaration helper imports", () => {
    const routeResult = compile(
      `import { $component, "$route" as defineRoute } from "@soljs/sol";
       const Page = $component(function Page() { return <p>Page</p>; });
       export const page = defineRoute({ path: "/string-helper" }, Page);`,
      "string-helper.sol.tsx",
    );
    expect(routeResult.code).toContain("export const page = __sol_route");

    const endpointResult = compile(
      `import { "$rpcQuery" as defineQuery } from "@soljs/sol";
       export const query = defineQuery("string-helper", { schema: value => value }, async () => 1);`,
      "string-helper-api.sol.ts",
      { target: "client" },
    );
    expect(endpointResult.code).toContain('__sol_rpc_query_client("string-helper")');
  });

  test("accepts identifier default exports for routes and server endpoints", () => {
    const routeResult = compile(
      `import { $component, $route } from "@soljs/sol";
       const Page = $component(function Page() { return <p>Page</p>; });
       const page = $route({ path: "/page" }, Page);
       export default page;`,
      "default-route.sol.tsx",
    );
    expect(routeResult.code).toContain("export default page");
    expect(routeResult.code).toContain("const page = __sol_route");

    const endpointResult = compile(
      `import { $rpcQuery } from "@soljs/sol";
       const load = $rpcQuery("load", { schema: value => value }, async () => 1);
       export default load;`,
      "default-endpoint.sol.ts",
      { target: "client" },
    );
    expect(endpointResult.code).toContain("export default load");
    expect(endpointResult.code).toContain('const load = __sol_rpc_query_client("load")');
  });

  test("compiles $component setup into inferred signals, computeds, and DOM effects", () => {
    const source = `
      import { $component } from "@soljs/sol";
      export const Counter = $component(function Counter(props: { label: string }) {
        let count = 0;
        const doubled = count * 2;
        function increment() { count++; }
        return <button className={["counter", { active: count > 0 }]} onClick={increment} disabled={count > 2}>
          {props.label}: {count} / {doubled}
        </button>;
      });
    `;
    const result = compile(source, "Counter.tsx");

    expect(result.code).toContain("const Counter = __sol_component");
    expect(result.code).toContain('{ name: "Counter", file: "Counter.tsx", line: 3 }');
    expect(result.code).toContain("const count = __sol_signal(0)");
    expect(result.code).toContain(
      "const doubled = __sol_computed(() => (count.value * 2), __sol_frame)",
    );
    expect(result.code).toContain("count.value++");
    expect(result.code).toContain("__sol_event");
    expect(result.code).toContain("__sol_attribute");
    expect(result.code).toContain("__sol_text");
    expect(result.code).not.toContain("asyncCaptureActive as __sol_async_capture_active");
    expect(result.code).not.toContain("$component(function");
    expect(result.map?.sources).toContain("Counter.tsx");
    expect(result.map?.sourcesContent).toEqual([source]);
    expect(result.code).not.toContain("__sol_source_");
  });

  test("maps generated setup and DOM effects to their authored locations", () => {
    const source = [
      'import { $component } from "@soljs/sol";',
      "const Counter = $component(function Counter() {",
      "  let count = 0;",
      "  function increment() { count++; }",
      "  return <button onClick={increment}>{count}</button>;",
      "});",
    ].join("\n");
    const result = compile(source, "Mapped.tsx");
    const consumer = new SourceMapConsumer(JSON.parse(result.map!.toString()));
    const originalFor = (needle: string) => {
      const offset = result.code.indexOf(needle);
      expect(offset).toBeGreaterThanOrEqual(0);
      const prefix = result.code.slice(0, offset);
      const lines = prefix.split("\n");
      return consumer.originalPositionFor({
        line: lines.length,
        column: lines.at(-1)!.length,
      });
    };

    expect(originalFor("const count = __sol_signal").line).toBe(3);
    expect(originalFor("function increment").line).toBe(4);
    expect(originalFor("__sol_event(__sol_view").line).toBe(5);
    expect(originalFor("__sol_text(__sol_view").line).toBe(5);
  });

  test("compiles inferred bindings, conditionals, components, and keyed maps", () => {
    const result = compile(
      `
      import { $component } from "@soljs/sol";
      const Row = $component(function Row(props: { todo: { id: number; done: boolean } }) {
        return <li><input type="checkbox" $bind={props.todo.done} /></li>;
      });
      const App = $component(function App() {
        let draft = "";
        const todos = [{ id: 1, done: false }];
        return <main>
          <input $bind={draft} />
          {todos.length ? <ul>{todos.map(todo => <Row key={todo.id} todo={todo} />)}</ul> : <p>Empty</p>}
        </main>;
      });
    `,
      "App.tsx",
    );

    expect(result.code).toContain('__sol_bind(__sol_view.elements[0], "checked"');
    expect(result.code).toContain('__sol_bind(__sol_view.elements[0], "value"');
    expect(result.code).toContain("__sol_when");
    expect(result.code).toContain("__sol_list");
    expect(result.code).toContain("__sol_child");
  });

  test("compiles intrinsic transition directives and rejects invalid placements", () => {
    const result = compile(
      `
      const fade = { enter: "fade-in duration-100" };
      const App = $component(function App() { return <main $transition={fade}>Ready</main>; });
    `,
      "Transitions.tsx",
    );

    expect(result.code).toContain("__sol_transition(__sol_view.elements[0], () => (fade))");
    expect(result.code).not.toContain('$transition="');
    expect(() =>
      compile(
        `const Child = $component(function Child() { return <p>Child</p>; });
         const App = $component(function App() { return <Child $transition={{}} />; });`,
        "InvalidTransition.tsx",
      ),
    ).toThrow("$transition is only valid on intrinsic elements");
    expect(() =>
      compile(
        `const App = $component(function App() { return <p $transition="fade">Child</p>; });`,
        "InvalidTransition.tsx",
      ),
    ).toThrow("requires an expression");
  });

  test("compiles intrinsic refs and portal builtins", () => {
    const result = compile(
      `
      import { $component, createRef as makeRef, GlobalPortal as BodyPortal, Portal as TargetPortal } from "@soljs/sol";
      const App = $component(function App() {
        const target = makeRef<HTMLDivElement>();
        const callback = (element: HTMLButtonElement | null) => void element;
        return <main>
          <div ref={target} />
          <TargetPortal target={target.current!}><button ref={callback}>Targeted</button><span>Sibling</span></TargetPortal>
          <BodyPortal><aside>Global</aside></BodyPortal>
        </main>;
      });
    `,
      "Portals.tsx",
    );

    expect(result.code).toContain("__sol_block_lifecycle(__sol_frame)");
    expect(result.code).toContain("const target = makeRef<HTMLDivElement>();");
    expect(result.code).not.toContain("__sol_signal(makeRef())");
    expect(result.code).toContain("__sol_ref(__sol_view.elements[0]");
    expect(result.code).toContain("__sol_portal(() => (target.current!)");
    expect(result.code).toContain("__sol_global_portal(");
    expect(result.code).toContain('<button data-sol-e="0">Targeted</button><span>Sibling</span>');
    expect(result.code).not.toContain("<TargetPortal");
    expect(result.code).not.toContain("<BodyPortal");
  });

  test("maps ref and portal operations to their authored JSX", () => {
    const source = [
      'import { $component, createRef, GlobalPortal, Portal } from "@soljs/sol";',
      "const App = $component(function App() {",
      "  const target = createRef<HTMLDivElement>();",
      "  const callback = (element: HTMLDivElement | null) => void element;",
      "  return <main>",
      "    <div ref={callback} />",
      "    <Portal target={target.current!}><p>Targeted</p></Portal>",
      "    <GlobalPortal><p>Global</p></GlobalPortal>",
      "  </main>;",
      "});",
    ].join("\n");
    const result = compile(source, "MappedPortals.tsx");
    const consumer = new SourceMapConsumer(JSON.parse(result.map!.toString()));
    const originalLine = (needle: string): number | null => {
      const offset = result.code.indexOf(needle);
      const prefix = result.code.slice(0, offset);
      const lines = prefix.split("\n");
      return consumer.originalPositionFor({
        line: lines.length,
        column: lines.at(-1)!.length,
      }).line;
    };

    expect(originalLine("__sol_ref(__sol_view")).toBe(6);
    expect(originalLine("__sol_portal(() =>")).toBe(7);
    expect(originalLine("__sol_global_portal(")).toBe(8);
  });

  test("validates ref and portal compiler boundaries", () => {
    expect(() => compile(componentSource('<input ref="field" />'), "InvalidRef.tsx")).toThrow(
      "requires an expression",
    );
    expect(() => compile(componentSource("<Child ref={() => {}} />"), "ComponentRef.tsx")).toThrow(
      "ref is only valid on intrinsic elements",
    );
    expect(() => compile(componentSource("<Portal />", ", Portal"), "MissingTarget.tsx")).toThrow(
      "target is required",
    );
    expect(() =>
      compile(componentSource('<Portal target="body" />', ", Portal"), "StaticTarget.tsx"),
    ).toThrow("requires an expression");
    expect(() =>
      compile(
        componentSource("<GlobalPortal target={document.body} />", ", GlobalPortal"),
        "GlobalTarget.tsx",
      ),
    ).toThrow("Unexpected target property");
    expect(() =>
      compile(
        componentSource(
          "<>{[document.body].map(target => <Portal key={target} target={target}><p>Row</p></Portal>)}</>",
          ", Portal",
        ),
        "KeyedPortal.tsx",
      ),
    ).not.toThrow();
  });

  test("keeps outer row state distinct in nested keyed lists", () => {
    const result = compile(
      `
      const App = $component(function App() {
        const groups = [{ id: 1, name: "First", items: [{ id: 2, label: "Item" }] }];
        return <main>{groups.map(group =>
          <section key={group.id}>{group.items.map(item =>
            <p key={item.id}>{group.name}: {item.label}</p>
          )}</section>
        )}</main>;
      });
    `,
      "NestedLists.tsx",
    );

    expect(result.code).toContain("__sol_item_0.value.name");
    expect(result.code).toContain("__sol_item_1.value.label");
    expect(result.code).toContain("(__sol_item_0, __sol_index_0, __sol_frame)");
    expect(result.code).toContain("(__sol_item_1, __sol_index_1, __sol_frame)");
  });

  test("supports explicit reactive overrides and every class alias", () => {
    const result = compile(
      `
      import { $component, $computed, $signal } from "@soljs/sol";
      const App = $component(function App() {
        const count = $signal(1);
        const doubled = $computed(() => count * 2);
        return <main>
          <p class="static">{count}</p>
          <p className={{ active: count > 0 }}>{doubled}</p>
          <p classNames={["row", { done: false }]}>{count}</p>
        </main>;
      });
    `,
      "Aliases.tsx",
    );

    expect(result.code).toContain("__sol_signal(1)");
    expect(result.code).toContain("__sol_computed(() => count.value * 2, __sol_frame)");
    expect(result.code).toContain('<p class="static">');
    expect(result.code.match(/__sol_attribute\(/g)?.length).toBe(2);
  });

  test("recognizes reactive helpers through transparent TypeScript wrappers", () => {
    for (const [wrapper, signal, computed] of [
      ["as", "$signal(1) as number", "$computed(() => count * 2) as number"],
      ["satisfies", "$signal(1) satisfies number", "$computed(() => count * 2) satisfies number"],
      ["non-null", "$signal(1)!", "$computed(() => count * 2)!"],
    ]) {
      const result = compile(
        `
        import { $component, $computed, $signal } from "@soljs/sol";
        const App = $component(function App() {
          const count = ${signal};
          const doubled = ${computed};
          return <p>{count}:{doubled}</p>;
        });
      `,
        `WrappedReactive-${wrapper}.tsx`,
      );

      expect(result.code.match(/__sol_signal\(/g)?.length).toBe(1);
      expect(result.code.match(/__sol_computed\(/g)?.length).toBe(1);
      expect(result.code).toContain("const count = __sol_signal(1);");
      expect(result.code).toContain(
        "const doubled = __sol_computed(() => count.value * 2, __sol_frame);",
      );
      expect(result.code).toContain("count.value * 2");
    }
  });

  test("infers value and checked bindings for every supported form control", () => {
    const result = compile(
      `
      import { $component } from "@soljs/sol";
      const Form = $component(function Form() {
        let text = "";
        let selected = "all";
        let checked = false;
        return <form>
          <textarea $bind={text}></textarea>
          <select $bind={selected}><option value="all">All</option></select>
          <input type="radio" $bind={checked} />
          <input type="CHECKBOX" $bind={checked} />
          <input type="RaDiO" $bind={checked} />
        </form>;
      });
    `,
      "Form.tsx",
    );

    expect(result.code.match(/__sol_bind\([^\n]+"value"/g)?.length).toBe(2);
    expect(result.code.match(/__sol_bind\([^\n]+"checked"/g)?.length).toBe(3);
    expect(result.code).toContain('"propertyValueElements":[0,1]');
  });

  test("rejects duplicate bindings and attributes that compete with their DOM property", () => {
    expect(() =>
      compile(
        `const App = $component(function App() {
          let first = "";
          let second = "";
          return <input $bind={first} $bind={second} />;
        });`,
        "DuplicateBinding.tsx",
      ),
    ).toThrow("Use only one $bind attribute");

    for (const element of [
      '<input value="other" $bind={text} />',
      '<textarea $bind={text} value="other"></textarea>',
      '<select value="other" $bind={text}></select>',
    ]) {
      expect(() =>
        compile(
          `const App = $component(function App() { let text = ""; return ${element}; });`,
          "CompetingValue.tsx",
        ),
      ).toThrow("$bind already controls value");
    }
    for (const element of [
      '<input type="checkbox" checked $bind={checked} />',
      '<input $bind={checked} checked type="radio" />',
    ]) {
      expect(() =>
        compile(
          `const App = $component(function App() { let checked = false; return ${element}; });`,
          "CompetingChecked.tsx",
        ),
      ).toThrow("$bind already controls checked");
    }

    for (const element of [
      '<textarea value="controlled">fallback</textarea>',
      '<textarea value="controlled">{fallback}</textarea>',
      "<textarea $bind={text}>fallback</textarea>",
      "<textarea $bind={text}>{fallback}</textarea>",
    ]) {
      expect(() =>
        compile(
          `const App = $component(function App() {
            let text = "controlled";
            const fallback = "fallback";
            return ${element};
          });`,
          "CompetingTextareaChildren.tsx",
        ),
      ).toThrow("Textarea children conflict with value or $bind");
    }
  });

  test("connects form controllers through the $form element property", () => {
    const result = compile(
      `
      import { $component, $form } from "@soljs/sol";
      const Form = $component(function Form() {
        const controller = $form({ schema: value => value, defaultValues: { title: "" } }, () => {});
        return <form $form={controller}><input name="title" $bind={controller.values.title} /></form>;
      });
    `,
      "Form.tsx",
    );

    expect(result.code).toContain('"submit", () => ((controller.value).submit)');
    expect(result.code).toContain('"input", () => ((controller.value).handleInput)');
    expect(result.code).toContain('"focusout", () => ((controller.value).handleBlur)');
    expect(result.code).not.toContain('$form="');
  });

  test("resolves component declarations independently of capitalization", () => {
    const result = compile(
      `
      import { $component } from "@soljs/sol";
      const row = $component(function row() { return <span>Row</span>; });
      const app = $component(function app() { return <row />; });
    `,
      "Lowercase.tsx",
    );

    expect(result.code).toContain("const row = __sol_component");
    expect(result.code).toContain("__sol_child");
    expect(result.code).not.toContain("<row>");
  });

  test("does not classify shadowed component or Link bindings by name", () => {
    expect(() =>
      compile(
        `import { $component, Link } from "@soljs/sol";
         import { Child } from "./Child";
         const App = $component(function App() {
           const Child = 1;
           return <Child />;
         });`,
        "App.tsx",
      ),
    ).toThrow("JSX component Child must be declared with $component() or imported");

    expect(() =>
      compile(
        `import { $component, Link } from "@soljs/sol";
         const App = $component(function App() {
           const Link = 1;
           return <Link />;
         });`,
        "App.tsx",
      ),
    ).toThrow("JSX component Link must be declared with $component() or imported");
  });

  test("compiles contexts, async components, suspense, await, and error boundaries", () => {
    const result = compile(
      `
      import { $component, $context, Suspense, Await, ErrorBoundary } from "@soljs/sol";
      const messageContext = $context<{ message: string }>();
      const AsyncChild = $component(async function AsyncChild() {
        const context = messageContext.use();
        const service = { use() { return "ordinary"; } };
        const ordinary = service.use();
        const data = await Promise.resolve({ text: "ready" });
        return <p data-state={data.text}>{context.message}: {data.text}: {ordinary}</p>;
      });
      const Ordinary = $component(function Ordinary() {
        const messageContext = { use() { return "shadowed"; } };
        return <p>{messageContext.use()}</p>;
      });
      const App = $component(function App() {
        const shared = { message: "hello" };
        const promise = Promise.resolve({ text: "awaited" });
        return <messageContext.Provider data={shared}>
          <ErrorBoundary fallback={error => <p>{String(error)}</p>}>
            <Suspense fallback={<p>Loading</p>} error={error => <p>{String(error)}</p>} timeoutMs={250}>
              <AsyncChild />
              <Await $promise={promise} error={error => <p>{String(error)}</p>}>
                {data => <p>{data.text}</p>}
              </Await>
            </Suspense>
          </ErrorBoundary>
        </messageContext.Provider>;
      });
    `,
      "AsyncContext.tsx",
    );

    expect(result.code).toContain("__sol_component(async (");
    expect(result.code).toContain("__sol_context_provider");
    expect(result.code).toContain("__sol_context_use(messageContext, __sol_frame, false)");
    expect(result.code).toContain("__sol_context_use(service.value, __sol_frame, false)");
    expect(result.code).toContain("__sol_context_use(messageContext.value, __sol_frame, false)");
    expect(result.code).toContain("__sol_error_boundary");
    expect(result.code).toContain("__sol_suspense");
    expect(result.code).toContain("__sol_await");
    expect(result.code).toContain('__sol_async_value(__sol_frame, "await:AsyncContext.tsx:0"');
    expect(result.code).toContain("__sol_frame, 250)");
    expect(result.code).toMatch(/__sol_template\(`[^`]*`, "t[a-z0-9]+", \{/);
    expect(result.code).toContain('"elements":["p"]');
    expect(result.code).toContain('"regionCount":2');
    expect(result.code).toContain('"propertyValueElements":[]');
    expect(result.code).not.toContain('"operations"');
  });

  test("passes the render frame to imported context candidates", () => {
    const result = compile(
      `
      import { sharedContext } from "./shared-context.ts";
      const App = $component(function App() {
        const value = sharedContext.use();
        return <p>{value.label}</p>;
      });
    `,
      "ImportedContext.tsx",
    );

    expect(result.code).toContain("__sol_context_use(sharedContext, __sol_frame, false)");
  });

  test("keeps frame-bound setup helpers and route reads after awaits", () => {
    const result = compile(
      `
      import { $component, $form, router } from "@soljs/sol";
      import { detail } from "./routes.ts";
      const App = $component(async function App(props: { route: typeof detail }) {
        await Promise.resolve();
        const form = $form({ schema: (value: { title: string }) => value, defaultValues: { title: "" } }, () => {});
        const ordinary = { params: { id: "ordinary" } };
        const optionalRouter = router?.params.id;
        const optionalRoute = props.route?.params.id;
        return <p>{router.params.id}:{props.route.params.id}:{optionalRouter}:{optionalRoute}:{ordinary.params.id}:{form.values.title}</p>;
      });
    `,
      "AsyncRoute.tsx",
    );

    expect(result.code).toContain("__sol_form(");
    expect(result.code).toContain("__sol_form(__sol_frame,");
    expect(result.code).toContain("__sol_frame");
    expect(result.code).toContain('__sol_route_read(router, "params", __sol_frame)');
    expect(result.code).toContain('__sol_route_read(props.route, "params", __sol_frame)');
    expect(result.code).not.toContain('__sol_route_read(ordinary.value, "params", __sol_frame)');
    expect(result.code).toContain(
      '__sol_route_read(router, "params", __sol_frame, __sol_route_value => __sol_route_value.id)',
    );
    expect(result.code).toContain(
      '__sol_route_read(props.route, "params", __sol_frame, __sol_route_value => __sol_route_value.id)',
    );
  });

  test("keeps route destructuring and object spreads frame-bound after awaits", () => {
    const result = compile(
      `
      import { $component, router } from "@soljs/sol";
      import { detail } from "./routes.ts";
      const App = $component(async function App() {
        function read() {
          const { pathname, params } = router;
          const route = { ...detail };
          return pathname + params.id + route.params.id;
        }
        await Promise.resolve();
        return <p>{read()}</p>;
      });
    `,
      "AsyncRoutePatterns.tsx",
    );

    expect(result.code).toContain("} = __sol_route_object(router, __sol_frame)");
    expect(result.code).toContain("...__sol_route_object(detail, __sol_frame)");
  });

  test("omits route helpers for provably ordinary async setup objects", () => {
    const result = compile(
      `const App = $component(async function App() {
        const options = { params: { id: "ordinary" } };
        function read() {
          const { params } = options;
          const copy = { ...options };
          return params.id + copy.params.id;
        }
        await Promise.resolve();
        return <p>{read()}</p>;
      });`,
      "OrdinaryAsyncObjects.tsx",
    );

    expect(result.code).not.toContain("routeObject as __sol_route_object");
    expect(result.code).not.toContain("routeRead as __sol_route_read");
  });

  test("keeps constructor-returned route objects frame-bound", () => {
    const result = compile(
      `import { $component } from "@soljs/sol";
       import { detail } from "./detail.sol.tsx";
       export const App = $component(async function App() {
         await Promise.resolve();
         const view = new Proxy(detail, {});
         return <p>{view.params.id}</p>;
       });`,
      "constructor-route.tsx",
    );

    expect(result.code).toContain('__sol_route_read(view.value, "params", __sol_frame).id');
  });

  test("instruments optional and computed context reads", () => {
    const result = compile(
      `
      import { $component, $context } from "@soljs/sol";
      const context = $context<{ label: string }>();
      const App = $component(async function App() {
        await Promise.resolve();
        const first = context?.use();
        const second = context.use?.();
        const third = context["use"]();
        const fourth = context.use().label;
        const fifth = context?.use().label;
        const sixth = context.use?.().label;
        const seventh = context?.use().label.toString();
        const use = context.use;
        const useOptional = context?.useOptional;
        const templateUse = context[\`use\`];
        const maybe = undefined as typeof context | undefined;
        const bound = maybe?.use.bind(maybe);
        const methodName = maybe?.use.name;
        const eighth = use();
        const ninth = useOptional?.();
        const tenth = templateUse();
        return <p>{first?.label}:{second?.label}:{third.label}:{fourth}:{fifth}:{sixth}:{seventh}:{eighth.label}:{ninth?.label}:{tenth.label}:{String(bound)}:{String(methodName)}</p>;
      });
    `,
      "OptionalContext.tsx",
    );

    expect(result.code.match(/__sol_context_use\(/g)?.length).toBe(7);
    expect(result.code).toContain("__sol_context_use(context, __sol_frame, false).label");
    expect(result.code).toContain(
      "__sol_context_use(context, __sol_frame, false, true, false, __sol_context_value => __sol_context_value.label)",
    );
    expect(result.code).toContain(
      "__sol_context_use(context, __sol_frame, false, false, true, __sol_context_value => __sol_context_value.label)",
    );
    expect(result.code).toContain(
      "__sol_context_use(context, __sol_frame, false, true, false, __sol_context_value => __sol_context_value.label.toString())",
    );
    expect(result.code).toContain('__sol_context_method(context, "use", __sol_frame)');
    expect(result.code).toContain(
      '__sol_context_method(context, "useOptional", __sol_frame, true)',
    );
    expect(result.code).toContain('__sol_context_method(context, "use", __sol_frame)');
    expect(result.code).toContain(
      '__sol_context_method(maybe.value, "use", __sol_frame, true, __sol_context_method_value => __sol_context_method_value.bind(maybe.value))',
    );
    expect(result.code).toContain(
      '__sol_context_method(maybe.value, "use", __sol_frame, true, __sol_context_method_value => __sol_context_method_value.name)',
    );
    expect(result.code).not.toContain("context?.use()");
    expect(result.code).not.toContain('context["use"]()');
  });

  test("keeps immutable primitive setup constants out of reactive effects", () => {
    const result = compile(
      `
      const App = $component(function App() {
        const answer = 42;
        return <p>{answer}</p>;
      });
    `,
      "StableConstant.tsx",
    );

    expect(result.code).toContain("const answer = 42");
    expect(result.code).toContain("__sol_static_text(__sol_view.regions[0], answer)");
    expect(result.code).not.toContain("const answer = __sol_signal");
    expect(result.code).not.toContain("text as __sol_text");
    expect(result.code).not.toContain("runtimeEffect");
  });

  test("preserves ordinary method receivers and optional-chain continuations", () => {
    const result = compile(
      `
      const App = $component(async function App() {
        const service = {
          query() { return this; },
          use() { return { label: "ordinary" }; },
        };
        const maybe = undefined as undefined | { params: { id: string } };
        const maybeContext = undefined as undefined | { use(): { label: string } };
        function remove(candidate: undefined | { params: { id?: string } }) {
          return delete candidate?.params.id;
        }
        function removeContext(candidate: undefined | { use(): { label?: string } }) {
          return delete candidate?.use().label;
        }
        function removeMethod(candidate: undefined | { use(): { label?: string } }) {
          return delete candidate?.use.name;
        }
        await Promise.resolve();
        const owner = service.query();
        const id = maybe?.params.id;
        const stringId = maybe?.params.id.toString();
        const first = maybeContext?.use().label;
        const second = service.use?.().label;
        return <p>{owner === service}:{id}:{stringId}:{String(remove)}:{String(removeContext)}:{String(removeMethod)}:{first}:{second}</p>;
      });
    `,
      "OrdinaryChains.tsx",
    );

    expect(result.code).not.toContain('__sol_route_read(service.value, "query"');
    expect(result.code).toContain("service.value.query()");
    expect(result.code).toContain(
      '__sol_route_read(maybe.value, "params", __sol_frame, __sol_route_value => __sol_route_value.id)',
    );
    expect(result.code).toContain(
      '__sol_route_read(maybe.value, "params", __sol_frame, __sol_route_value => __sol_route_value.id.toString())',
    );
    expect(result.code).toContain("delete candidate?.params.id");
    expect(result.code).toContain("delete candidate?.use().label");
    expect(result.code).toContain("delete candidate?.use.name");
    expect(result.code).toContain(
      "__sol_context_use(maybeContext.value, __sol_frame, false, true, false, __sol_context_value => __sol_context_value.label)",
    );
    expect(result.code).toContain(
      "__sol_context_use(service.value, __sol_frame, false, false, true, __sol_context_value => __sol_context_value.label)",
    );
  });

  test("reserves private hydration element markers", () => {
    expect(() =>
      compile(
        `const App = $component(function App() { return <main data-sol-e="authored">Bad</main>; });`,
        "PrivateMarker.tsx",
      ),
    ).toThrow("data-sol-e is reserved for hydration metadata");
  });

  test("captures component awaits without instrumenting fire-and-forget helper work", () => {
    const result = compile(
      `
      const App = $component(async function App() {
        async function sideEffect() { await Promise.resolve("side effect"); }
        async function load() { return await Promise.resolve("nested"); }
        void sideEffect();
        const nested = await load();
        const value = await Promise.resolve("captured");
        return <p>{nested}: {value}</p>;
      });
    `,
      "AsyncSideEffect.tsx",
    );

    expect(result.code.match(/__sol_async_value/g)).toHaveLength(3);
    expect(result.code.match(/__sol_async_value\(__sol_frame/g)).toHaveLength(2);
    expect(result.code).toContain('await Promise.resolve("side effect")');
    expect(result.code).toContain(
      '__sol_capture_enabled ? __sol_async_value(__sol_frame, "await:AsyncSideEffect.tsx:0"',
    );
    expect(result.code).toContain(
      "const nested = __sol_signal(await __sol_async_capture_call(() => load(), true))",
    );
  });

  test("does not capture helper calls nested in an awaited callback", () => {
    const result = compile(
      `
      const App = $component(async function App() {
        async function sideEffect() { await Promise.resolve("side effect"); }
        const value = await new Promise(resolve => {
          void sideEffect();
          resolve("ready");
        });
        return <p>{value}</p>;
      });
    `,
      "AwaitedCallback.tsx",
    );

    expect(result.code.match(/__sol_async_value\(__sol_frame/g)).toHaveLength(1);
    expect(result.code).toContain('await Promise.resolve("side effect")');
    expect(result.code).toContain("void sideEffect()");
    expect(result.code).not.toContain("__sol_async_capture_call(() => sideEffect()");
  });

  test("namespaces async sites by compiled module", () => {
    const source = `const App = $component(async function App() { const value = await Promise.resolve("value"); return <p>{value}</p>; });`;
    const first = compile(source, "FirstModule.tsx");
    const second = compile(source, "SecondModule.tsx");

    expect(first.code).toContain('"await:FirstModule.tsx:0"');
    expect(second.code).toContain('"await:SecondModule.tsx:0"');
    expect(second.code).not.toContain('"await:FirstModule.tsx:0"');
  });

  test("resolves awaited helpers by lexical binding when names are shadowed", () => {
    const result = compile(
      `
      const App = $component(async function App() {
        async function load() { return await Promise.resolve("outer"); }
        {
          async function load() { await Promise.resolve("shadow"); }
          void load();
        }
        const value = await load();
        return <p>{value}</p>;
      });
    `,
      "ShadowedHelper.tsx",
    );

    expect(result.code).toContain('await Promise.resolve("shadow")');
    expect(result.code).toContain(
      '__sol_capture_enabled ? __sol_async_value(__sol_frame, "await:ShadowedHelper.tsx:0", () => Promise.resolve("outer"))',
    );
    expect(result.code).toContain(
      "const value = __sol_signal(await __sol_async_capture_call(() => load(), true))",
    );
  });

  test("compiles Head children and raw-text elements", () => {
    const result = compile(
      `
      import { $component, Head as DocumentHead } from "@soljs/sol";
      const App = $component(function App() {
        let title = "First";
        const description = "Reactive description";
        return <main>
          <DocumentHead>
            <title>Page: {title}</title>
            <meta name="description" content={description} />
            <style>{"body { color: red; }"}</style>
            <script>{"globalThis.headScriptRan = true;"}</script>
          </DocumentHead>
          <textarea>Draft: {title}</textarea>
        </main>;
      });
    `,
      "Head.tsx",
    );

    expect(result.code).toContain("__sol_head");
    expect(result.code).toContain("__sol_raw_text");
    expect(result.code).not.toContain("<DocumentHead");
    expect(result.code).not.toContain("<!--sol:s:");
  });

  test("validates the compiler-specialized Head interface", () => {
    const cases = [
      {
        source: `import { $component, Head } from "@soljs/sol"; const App = $component(function App() { return <Head title="Invalid" />; });`,
        message: "Unexpected title property",
      },
      {
        source: `import { $component, Head } from "@soljs/sol"; const props = {}; const App = $component(function App() { return <Head {...props} />; });`,
        message: "JSX spread attributes are not supported in v1",
      },
      {
        source: `import { $component, Head } from "@soljs/sol"; const App = $component(function App() { return <Head><title><span>Invalid</span></title></Head>; });`,
        message: "Raw-text element children must be text or expressions",
      },
    ];

    for (const fixture of cases) {
      expect(() => compile(fixture.source, "Head.tsx")).toThrow(fixture.message);
    }
  });

  test("treats empty Head blocks as no-ops and respects lexical shadowing", () => {
    const empty = compile(
      `import { $component, Head } from "@soljs/sol"; const App = $component(function App() { return <Head />; });`,
      "EmptyHead.tsx",
    );
    expect(empty.code.match(/__sol_head\(/g) ?? []).toHaveLength(0);

    expect(() =>
      compile(
        `
        import { $component, Head as DocumentHead } from "@soljs/sol";
        const Local = $component(function Local() { return <p>Local</p>; });
        const App = $component(function App() {
          const DocumentHead = Local;
          return <DocumentHead title="Not a builtin" />;
        });
      `,
        "ShadowedHead.tsx",
      ),
    ).toThrow("JSX component DocumentHead must be declared with $component() or imported");
  });

  test("rejects JSX nested anywhere inside raw-text expressions", () => {
    const expressions = [
      `ready ? "Ready" : <span>Pending</span>`,
      `ready && <span>Ready</span>`,
      `["Ready", <span>Pending</span>]`,
    ];
    for (const expression of expressions) {
      expect(() =>
        compile(
          `import { $component } from "@soljs/sol"; const App = $component(function App() { const ready = true; return <title>{${expression}}</title>; });`,
          "RawText.tsx",
        ),
      ).toThrow("Raw-text element children must be text or expressions");
    }
  });

  test("validates async boundary and context provider JSX contracts", () => {
    const cases = [
      {
        source: `import { $component, Suspense } from "@soljs/sol"; const App = $component(function App() { return <Suspense><p>Child</p></Suspense>; });`,
        message: "JSX property fallback is required",
      },
      {
        source: `import { $component, Await } from "@soljs/sol"; const App = $component(function App() { return <Await $promise={Promise.resolve(1)} />; });`,
        message: "Await requires exactly one inline data-renderer child",
      },
      {
        source: `import { $component, ErrorBoundary } from "@soljs/sol"; const App = $component(function App() { return <ErrorBoundary fallback={<p>Error</p>}><p>Child</p></ErrorBoundary>; });`,
        message: "Error and data renderers must be inline functions",
      },
      {
        source: `import { $component, $context } from "@soljs/sol"; const context = $context<{ value: string }>(); const App = $component(function App() { return <context.Provider><p>Child</p></context.Provider>; });`,
        message: "JSX property data is required",
      },
      {
        source: `import { $component, Await } from "@soljs/sol"; const App = $component(function App() { return <Await $promise={123}>{value => <p>{value}</p>}</Await>; });`,
        message: "Await $promise must be a promise expression",
      },
      {
        source: `import { $component, Suspense } from "@soljs/sol"; const App = $component(function App() { return <Suspense fallback={<p>Wait</p>} timeoutMs><p>Child</p></Suspense>; });`,
        message: "Suspense timeoutMs must be a number expression",
      },
      {
        source: `import { $component, $context } from "@soljs/sol"; const context = $context<{ value: string }>(); const App = $component(function App() { return <context.Provider data={123}><p>Child</p></context.Provider>; });`,
        message: "Context Provider data must be an object expression",
      },
    ];

    for (const fixture of cases) {
      expect(() => compile(fixture.source, "AsyncBoundary.tsx")).toThrow(fixture.message);
    }

    expect(() =>
      compile(
        `import { $component, $context } from "@soljs/sol"; const context = $context<RegExp>(); const App = $component(function App() { return <context.Provider data={/valid object/}><p>Child</p></context.Provider>; });`,
        "RegexContext.tsx",
      ),
    ).not.toThrow();
  });

  test("reports invalid component, binding, class, and list interfaces with locations", () => {
    expect(() =>
      compile(
        `
      const App = $component(function App() {
        let controller = {};
        return <input $form={controller} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$form is only valid on form elements");

    expect(() =>
      compile(
        `
      const App = $component(function App() {
        let controller = {};
        return <form $form={controller} onSubmit={() => {}}></form>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$form already handles onSubmit");

    expect(() =>
      compile(
        `
      import { signal } from "@soljs/sol";
      export const value = signal(1);
    `,
        "Invalid.tsx",
      ),
    ).toThrow("signal() was renamed to $signal()");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App({ name }: { name: string }) {
        return <p>{name}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("Component props must use one identifier");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App(props: { values: string[] }) {
        return <ul>{props.values.map(value => <li>{value}</li>)}</ul>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("Every JSX .map() row requires a key attribute");

    expect(() =>
      compile(
        `
      function App() { return <p>Not compiled</p>; }
    `,
        "Invalid.tsx",
      ),
    ).toThrow(/Invalid\.tsx:2:.*\$component/s);

    expect(() =>
      compile(
        `
      import type { Missing } from "./types";
      import { $component } from "@soljs/sol";
      const App = $component(function App() { return <Missing />; });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("JSX component Missing must be declared with $component() or imported");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        let value = false;
        let kind = "checkbox";
        return <input type={kind} $bind={value} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$bind requires a static input type");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        return <input $bind={"snapshot"} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$bind requires writable component state");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        let value = "";
        return <input bind:value={value} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("bind:* was removed");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        return <p class="one" className="two">Duplicate</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("Use only one of class, className, or classNames");

    for (const [attributes, conflict] of [
      ['id="first" id="second"', "JSX attribute id conflicts with id"],
      [
        "onClick={() => undefined} onClick={() => undefined}",
        "JSX attribute onClick conflicts with onClick",
      ],
      [
        "onDoubleClick={() => undefined} onDblClick={() => undefined}",
        "JSX attribute onDblClick conflicts with onDoubleClick",
      ],
      ['htmlFor="first" for="second"', "JSX attribute for conflicts with htmlFor"],
      ['key="first" key="second"', "JSX attribute key conflicts with key"],
    ]) {
      expect(() =>
        compile(
          `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        return <button ${attributes}>Duplicate</button>;
      });
    `,
          "Invalid.tsx",
        ),
      ).toThrow(conflict);
    }

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const Child = $component(function Child(props) { return <p>{props.label}</p>; });
      const App = $component(function App() {
        return <Child label="first" label="second" />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("JSX attribute label conflicts with label");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        let source = 1;
        const doubled = source * 2;
        function invalid() { doubled = 3; }
        return <p>{doubled}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("Computed component value doubled is readonly");

    for (const assignment of ["({ source } = { source: 2 });", "[source] = [2];"]) {
      expect(() =>
        compile(
          `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        let source = 1;
        function invalid() { ${assignment} }
        return <p>{source}</p>;
      });
    `,
          "Invalid.tsx",
        ),
      ).toThrow("destructuring is not reactive in v1");
    }

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        const later = source + 1;
        let source = 1;
        return <p>{later}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("cannot reference later binding source");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        const value = value + 1;
        return <p>{value}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("cannot reference itself");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        let values = [1];
        const length = values.push(2);
        return <p>{length}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("must not call mutating collection methods");
    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        let values = [1];
        const length = values["push"](2);
        return <p>{length}</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("must not call mutating collection methods");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App() {
        let source = 1;
        const doubled = source * 2;
        return <input $bind={doubled} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$bind cannot target a computed value");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App(props: { value: string }) {
        return <input $bind={props.value} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("readonly component prop");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const Child = $component(function Child() { return <p>Child</p>; });
      const App = $component(function App() {
        let value = "";
        return <Child $bind={value} />;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("$bind is only valid on intrinsic form elements");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      function makeComponent() {
        return $component(function Nested() { return null as never; });
      }
    `,
        "Invalid.tsx",
      ),
    ).toThrow("direct top-level const initializer");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App(props: { ready: boolean }) {
        if (!props.ready) return <p>Waiting</p>;
        return <p>Ready</p>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("Early component returns are not supported");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(function App(props: { value: string }) {
        return <div {...props}>{props.value}</div>;
      });
    `,
        "Invalid.tsx",
      ),
    ).toThrow("JSX spread attributes are not supported");

    expect(() =>
      compile(
        `
      import { $component } from "@soljs/sol";
      const App = $component(() => <p>Arrow</p>);
    `,
        "Invalid.tsx",
      ),
    ).toThrow("exactly one named function expression");
  });

  test("enforces component and expression boundary diagnostics", () => {
    const cases = [
      {
        source: `const App = $component(async function App() { return <p>Async</p>; });`,
        message: "__accept_async__",
      },
      {
        source: `const App = $component(function* App() { return <p>Generator</p>; });`,
        message: "Components must not be generator functions",
      },
      {
        source: `const App = $component(function App() { return <p>One</p>; }), other = 1;`,
        message: "sole initializer",
      },
      {
        source: `const App = $component(function App() { function read() { return ""; } return <input $bind={read()} />; });`,
        message: "$bind requires writable component state",
      },
      {
        source: `const App = $component(function App() { const state = { value: "" }; return <input $bind={state?.value} />; });`,
        message: "$bind requires writable component state",
      },
      {
        source: `const App = $component(function App() { let values = [1]; const copy = values.slice(); function mutate() { copy.push(2); } return <p>{copy.length}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [1]; const copy = values.slice(); function mutate() { copy["push"](2); } return <p>{copy.length}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source:
          "const App = $component(function App() { let values = [1]; const copy = values.slice(); function mutate() { copy[`push`](2); } return <p>{copy.length}</p>; });",
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [1]; const copy = values.slice(); function mutate() { copy?.push(2); } return <p>{copy.length}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [1]; const copy = values.slice(); function mutate() { copy.push?.(2); } return <p>{copy.length}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [[1]]; const copy = { nested: values[0] }; function mutate() { copy?.nested.push(2); } return <p>{copy.nested.length}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [[1]]; const copy = { nested: values[0] }; function mutate() { copy?.nested?.push(2); } return <p>{copy.nested.length}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [{ x: 1 }]; const copy = { ...values[0] }; function mutate() { ({ x: copy.x } = { x: 2 }); } return <p>{copy.x}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [{ x: 1 }]; const copy = { ...values[0] }; function mutate() { [copy.x] = [2]; } return <p>{copy.x}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [{ x: 1 }]; const copy = { ...values[0] }; function mutate() { (copy as any).x = 2; } return <p>{copy.x}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [1]; const copy = values.slice(); function mutate() { (copy as any).push(2); } return <p>{copy.length}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [{ x: 1 }]; const copy = { ...values[0] }; function mutate() { copy!.x = 2; } return <p>{copy.x}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [1]; const copy = values.slice(); function mutate() { copy!.push(2); } return <p>{copy.length}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [{ x: 1 }]; const copy = { ...values[0] }; function mutate() { ({ x: (copy.x as any) } = { x: 2 }); } return <p>{copy.x}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App() { let values = [{ x: 1 }]; const copy = { ...values[0] }; function mutate() { [(copy.x as any)] = [2]; } return <p>{copy.x}</p>; });`,
        message: "Computed component value copy is readonly",
      },
      {
        source: `const App = $component(function App(props: { Row: unknown }) { return <props.Row />; });`,
        message: "Dynamic and namespaced JSX tag names are not supported",
      },
    ];

    for (const fixture of cases) {
      if (fixture.message === "__accept_async__") {
        expect(() => compile(fixture.source, "Boundary.tsx")).not.toThrow();
      } else {
        expect(() => compile(fixture.source, "Boundary.tsx")).toThrow(fixture.message);
      }
    }
  });

  test("protects compiler identifiers and component import classification", () => {
    expect(() =>
      compile(
        `
      const __sol_signal = 1;
      const App = $component(function App() { return <p>{__sol_signal}</p>; });
    `,
        "ReservedModule.tsx",
      ),
    ).toThrow("reserved compiler prefix __sol_");

    for (const nestedBinding of [
      "function read(__sol_frame: unknown) { return __sol_frame; }",
      "function read() { const __sol_route_value = 1; return __sol_route_value; }",
      "try { throw new Error(); } catch (__sol_error) { String(__sol_error); }",
    ]) {
      expect(() =>
        compile(
          `
          const App = $component(function App() {
            ${nestedBinding}
            return <p>reserved</p>;
          });
        `,
          "ReservedNested.tsx",
        ),
      ).toThrow("reserved compiler prefix __sol_");
    }

    expect(() =>
      compile(
        `
      const App = $component(function App() {
        let __sol_view = 1;
        return <p>{__sol_view}</p>;
      });
    `,
        "ReservedComponent.tsx",
      ),
    ).toThrow("reserved compiler prefix __sol_");

    expect(() =>
      compile(
        `
      import { $component, Fragment } from "@soljs/sol";
      const App = $component(function App() { return <Fragment />; });
    `,
        "FrameworkImport.tsx",
      ),
    ).toThrow("must be declared with $component() or imported");

    const externalComponent = compile(
      `
      import { $component } from "@soljs/sol";
      import { Row } from "./Row";
      const App = $component(function App() { return <Row />; });
    `,
      "ExternalComponent.tsx",
    );
    expect(externalComponent.code).toContain("__sol_child");
  });

  test("validates binding roots, readonly props, and event spelling", () => {
    const valid = compile(
      `
      import { $component } from "@soljs/sol";
      const App = $component(function App(props: { todo: { done: boolean } }) {
        let todos = [{ id: 1, done: false }];
        function updateNestedProp() { props.todo.done = true; }
        return <main onClick={updateNestedProp}>
          <input type="checkbox" $bind={props.todo.done} />
          {todos.map(todo => <input key={todo.id} type="checkbox" $bind={todo.done} />)}
        </main>;
      });
    `,
      "ValidBoundaries.tsx",
    );
    expect(valid.code.match(/__sol_bind/g)?.length).toBeGreaterThanOrEqual(2);

    expect(() =>
      compile(
        `
      const App = $component(function App(props: { done: boolean }) {
        const rows = [{ id: 1, done: false }];
        const derived = rows.length;
        return <main>
          {rows.map(props => <input key={props.id} type="checkbox" $bind={props.done} />)}
          {rows.map(derived => <input key={derived.id} type="checkbox" $bind={derived.done} />)}
        </main>;
      });
    `,
        "ShadowedRowBindings.tsx",
      ),
    ).not.toThrow();

    expect(() =>
      compile(
        `
      const App = $component(function App(props: { value: number }) {
        function updateShadow(props: { value: number }) { props.value = 2; }
        return <button onClick={() => updateShadow({ value: 1 })}>{props.value}</button>;
      });
    `,
        "ShadowedProps.tsx",
      ),
    ).not.toThrow();

    for (const expression of ["external.value", "Math.value"]) {
      expect(() =>
        compile(
          `
        import { $component } from "@soljs/sol";
        const external = { value: "" };
        const App = $component(function App() { return <input $bind={${expression}} />; });
      `,
          "InvalidBindingRoot.tsx",
        ),
      ).toThrow("must be rooted in component state");
    }

    for (const statement of [
      "props.value = 2;",
      "(props as any).value = 2;",
      "props!.value = 2;",
      "(props satisfies { value: number }).value = 2;",
      "delete props.value;",
      "delete (props as any).value;",
      "Object.defineProperty(props, 'value', { value: 2 });",
      "Object.defineProperty(props as any, 'value', { value: 2 });",
      "Reflect.defineProperty(props, 'value', { value: 2 });",
      "Object.setPrototypeOf(props, null);",
      "Reflect.setPrototypeOf(props, null);",
      "Object.preventExtensions(props);",
      "Reflect.preventExtensions(props);",
    ]) {
      expect(() =>
        compile(
          `
        import { $component } from "@soljs/sol";
        const App = $component(function App(props: { value: number }) {
          function mutate() { ${statement} }
          return <button onClick={mutate}>{props.value}</button>;
        });
      `,
          "ReadonlyProps.tsx",
        ),
      ).toThrow("Component props are readonly");
    }

    expect(() =>
      compile(
        `
      const App = $component(function App(props: { value: number }) {
        function helper(Object: { defineProperty: (...args: unknown[]) => void }) {
          Object.defineProperty(props, "value", { value: 2 });
        }
        return <button onClick={() => helper({ defineProperty() {} })}>{props.value}</button>;
      });
    `,
        "ShadowedObject.tsx",
      ),
    ).not.toThrow();

    expect(() =>
      compile(
        `
      const App = $component(function App(props: { value: number }) {
        return <button onClick={() => props.value++}>{props.value}</button>;
      });
    `,
        "InlineReadonlyProps.tsx",
      ),
    ).toThrow("Component props are readonly");

    for (const eventName of ["onclick", "on-click", "on1Click", "OnClick"]) {
      expect(() =>
        compile(
          `
        const App = $component(function App() { return <button ${eventName}={() => {}}>Run</button>; });
      `,
          "InvalidEvent.tsx",
        ),
      ).toThrow("React-style onEvent capitalization");
    }

    expect(() =>
      compile(
        `
      const App = $component(function App() {
        let values = [1];
        return <ul>{values.map(value => { const label = value; return <li key={value}>{label}</li>; })}</ul>;
      });
    `,
        "LegacyWording.tsx",
      ),
    ).toThrow("component or $computed()");
  });
});

test("the Vite plugin enables devtools only for development by default", () => {
  expect(injectedDevtools("serve")).toEqual([
    {
      tag: "script",
      attrs: {
        type: "module",
        src: "/@id/@soljs/sol/devtools",
        "data-sol-devtools": "",
      },
      injectTo: "head-prepend",
    },
  ]);
  expect(injectedDevtools("build")).toEqual([]);
  expect(injectedDevtools("build", true)).toEqual([
    {
      tag: "script",
      attrs: {
        type: "module",
        src: "/@soljs/sol/devtools",
        "data-sol-devtools": "",
      },
      injectTo: "head-prepend",
    },
  ]);
  expect(injectedDevtools("serve", false)).toEqual([]);
  expect(() => sol({ devtools: "yes" as never })).toThrow("must be a boolean");
});

test("the Vite plugin invalidates both manifests when an existing sol module changes", () => {
  const plugin = sol();
  const resolve = plugin.configResolved as unknown as (config: ResolvedConfig) => void;
  resolve({ command: "serve", root: "/project" } as ResolvedConfig);
  const listeners = new Map<string, (file: string) => void>();
  const invalidated: string[] = [];
  const messages: unknown[] = [];
  const server = {
    watcher: {
      on(event: string, listener: (file: string) => void) {
        listeners.set(event, listener);
      },
    },
    moduleGraph: {
      getModuleById(id: string) {
        return { id };
      },
      invalidateModule(module: { id: string }) {
        invalidated.push(module.id);
      },
    },
    ws: {
      send(message: unknown) {
        messages.push(message);
      },
    },
  } as unknown as ViteDevServer;
  const configure = plugin.configureServer as (server: ViteDevServer) => unknown;

  expect(configure(server)).toBeUndefined();
  expect([...listeners.keys()].toSorted()).toEqual(["add", "change", "unlink"]);
  listeners.get("change")!("/project/api.sol.ts");
  expect(invalidated).toEqual(["\0virtual:sol/routes", "\0virtual:sol/server-endpoints"]);
  expect(messages).toEqual([{ type: "full-reload" }]);
});

test("the Vite plugin rejects canonically equivalent route declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-route-collision-"));
  try {
    await writeFile(
      join(root, "first.sol.ts"),
      'import { $route } from "@soljs/sol"; import { Page } from "./Page"; export const first = $route({ path: "/café" }, Page);',
    );
    await writeFile(
      join(root, "second.sol.ts"),
      'import { $route } from "@soljs/sol"; import { Page } from "./Page"; export const second = $route({ path: "/caf%C3%A9" }, Page);',
    );
    const plugin = sol();
    (plugin.configResolved as unknown as (config: ResolvedConfig) => void)({
      command: "build",
      root,
    } as ResolvedConfig);

    const failure = await (plugin.load as (id: string) => Promise<unknown>)(
      "\0virtual:sol/routes",
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Duplicate route matcher");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the route manifest creates one lazy loader per route file and infers literal paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-route-manifest-"));
  try {
    await writeFile(
      join(root, "pages.sol.tsx"),
      `import { $route } from "@soljs/sol";
       import { Index, Detail } from "./Pages";
       export const index = $route({ path: "/docs" }, Index);
       const internal = $route({ path: "/docs/:slug" }, Detail);
       export { internal as detail };`,
    );
    const plugin = sol();
    (plugin.configResolved as unknown as (config: ResolvedConfig) => void)({
      command: "build",
      root,
    } as ResolvedConfig);
    const source = await (plugin.load as (id: string) => Promise<string>)("\0virtual:sol/routes");

    expect(source.match(/import\("\/@fs\//g)).toHaveLength(1);
    expect(source.match(/__sol_lazy_route\(/g)).toHaveLength(2);
    expect(source).toContain('export const staticRoutePaths = ["/docs"]');
    expect(source).toContain('assetKey: "pages.sol.tsx"');
    expect(source).toContain('module["detail"]');
    expect(source).not.toContain('module["internal"]');
    expect(source.split('"pattern":"^/docs/([^/]+)$"')).toHaveLength(2);
    expect(source).not.toContain("import * as __sol_route_module");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplicates route aliases and projects default route handles", async () => {
  const root = await mkdtemp(join(import.meta.dir, "route-aliases-"));
  try {
    await writeFile(join(root, "Page.tsx"), "export const Page = () => null;");
    await writeFile(
      join(root, "page.sol.tsx"),
      `import { $route } from "@soljs/sol";
       import { Page } from "./Page";
       console.log("DEFAULT_PAGE_IMPLEMENTATION");
       const internal = $route({ path: "/page" }, Page);
       export type { internal as PageType };
       export { internal as page };
       export default internal;`,
    );
    await writeFile(
      join(root, "entry.ts"),
      `import defaultPage, { page } from "./page.sol.tsx"; console.log(defaultPage, page);`,
    );
    const plugin = sol();
    (plugin.configResolved as unknown as (config: ResolvedConfig) => void)({
      command: "build",
      root,
    } as ResolvedConfig);
    const manifest = await (plugin.load as (id: string) => Promise<string>)("\0virtual:sol/routes");
    expect(manifest.match(/__sol_lazy_route\(/g)).toHaveLength(1);
    expect(manifest).toContain('module["page"]');
    expect(manifest).not.toContain("PageType");

    const result = await build({
      root,
      logLevel: "silent",
      plugins: [sol()],
      build: { write: false, rollupOptions: { input: join(root, "entry.ts") } },
    });
    const entry = (Array.isArray(result) ? result : [result])
      .flatMap((item) => ("output" in item ? item.output : []))
      .find((item) => item.type === "chunk" && item.isEntry);
    expect(entry?.type === "chunk" ? entry.code : "").not.toContain("export const default");
    expect(entry?.type === "chunk" ? entry.code : "").not.toContain("DEFAULT_PAGE_IMPLEMENTATION");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns null for unchanged TSX modules", async () => {
  const transform = sol().transform as unknown as {
    handler: (
      this: { resolve(): Promise<null> },
      source: string,
      id: string,
      options: { ssr: boolean },
    ) => Promise<unknown>;
  };
  const result = await transform.handler.call(
    { resolve: async () => null },
    "export const value = 1;",
    "/tmp/plain.tsx",
    { ssr: false },
  );
  expect(result).toBeNull();
});

test("ignores type-only Sol helpers in virtual manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-type-only-helpers-"));
  try {
    await writeFile(
      join(root, "named.sol.ts"),
      `import type { $route, $rpcQuery } from "@soljs/sol";
       const page = $route({ path: "/named-type" }, Page);
       const endpoint = $rpcQuery("typed", { schema: value => value }, async () => 1);
       export { page, endpoint };`,
    );
    await writeFile(
      join(root, "namespace.sol.ts"),
      `import type * as Sol from "@soljs/sol";
       const page = Sol.$route({ path: "/namespace-type" }, Page);
       export { page };`,
    );
    await writeFile(
      join(root, "string.sol.ts"),
      `import { "$route" as defineRoute, "$rpcQuery" as defineQuery } from "@soljs/sol";
       export const page = defineRoute({ path: "/string-helper" }, Page);
       export const endpoint = defineQuery("string-helper", { schema: value => value }, async () => 1);`,
    );
    const plugin = sol();
    (plugin.configResolved as unknown as (config: ResolvedConfig) => void)({
      command: "build",
      root,
    } as ResolvedConfig);
    const routes = await (plugin.load as (id: string) => Promise<string>)("\0virtual:sol/routes");
    const endpoints = await (plugin.load as (id: string) => Promise<string>)(
      "\0virtual:sol/server-endpoints",
    );
    expect(routes).not.toContain("named-type");
    expect(routes).not.toContain("namespace-type");
    expect(routes).toContain("string-helper");
    expect(endpoints).not.toContain("named.sol.ts");
    expect(endpoints).toContain("string.sol.ts?sol-endpoints");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves queried and type-only imports from route modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-route-import-kinds-"));
  try {
    const routeFile = join(root, "page.sol.ts");
    await writeFile(
      routeFile,
      `import { $route } from "@soljs/sol";
       export const page = $route({ path: "/page" }, Page);`,
    );
    const transform = sol().transform as unknown as {
      handler: (
        this: { resolve(specifier: string): Promise<{ id: string } | null> },
        source: string,
        id: string,
        options: { ssr: boolean },
      ) => Promise<{ code: string } | null>;
    };
    const context = {
      resolve: async (specifier: string) => ({ id: specifier.split("?", 1)[0]! }),
    };
    const queried = await Promise.all(
      ["raw", "url"].map(async (query) => {
        const source = `import asset from ${JSON.stringify(`${routeFile}?${query}`)}; console.log(asset);`;
        const result = await transform.handler.call(context, source, join(root, `${query}.ts`), {
          ssr: false,
        });
        return { query, source, result };
      }),
    );
    for (const { query, source, result } of queried) {
      expect(result?.code ?? source).toContain(
        JSON.stringify(`${routeFile}?${query}`).slice(1, -1),
      );
      expect(result?.code ?? source).not.toContain("sol-route-handles");
    }

    const typeSource = `import type DefaultPage from ${JSON.stringify(routeFile)};
      import type { page as NamedPage } from ${JSON.stringify(routeFile)};
      import type * as Pages from ${JSON.stringify(routeFile)};
      import { type page as Page, page } from ${JSON.stringify(routeFile)};
      type Route = typeof DefaultPage | typeof NamedPage | typeof Pages.page | typeof Page;
      console.log(page);`;
    const typeResult = await transform.handler.call(context, typeSource, join(root, "types.ts"), {
      ssr: false,
    });
    expect(typeResult?.code).toContain(`import type * as Pages from ${JSON.stringify(routeFile)}`);
    expect(typeResult?.code).toContain(`import type DefaultPage from ${JSON.stringify(routeFile)}`);
    expect(typeResult?.code).toContain(`import type { page as NamedPage }`);
    expect(typeResult?.code).toContain(`type page as Page`);
    expect(typeResult?.code).toContain(
      JSON.stringify(`${routeFile}?sol-route-handles`).slice(1, -1),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplicates endpoint aliases in the virtual manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-endpoint-aliases-"));
  try {
    await writeFile(
      join(root, "api.sol.ts"),
      `import { $rpcQuery } from "@soljs/sol";
       const load = $rpcQuery("load", { schema: value => value }, async () => 1);
       export { load as first, load as second };`,
    );
    await writeFile(
      join(root, "page.sol.ts"),
      `import { $route } from "@soljs/sol";
       export const page = $route({ path: "/page" }, Page);`,
    );
    const plugin = sol();
    (plugin.configResolved as unknown as (config: ResolvedConfig) => void)({
      command: "build",
      root,
    } as ResolvedConfig);
    const manifest = await (plugin.load as (id: string) => Promise<string>)(
      "\0virtual:sol/server-endpoints",
    );
    expect(manifest).toContain("[...new Set(");
    expect(manifest).not.toContain("page.sol.ts?sol-endpoints");
    const routes = await (plugin.load as (id: string) => Promise<string>)("\0virtual:sol/routes");
    expect(routes).not.toContain("api.sol.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers and projects string-named route exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-string-route-export-"));
  try {
    const routeFile = join(root, "page.sol.ts");
    await writeFile(
      routeFile,
      `import { $route, $rpcQuery } from "@soljs/sol";
       const page = $route({ path: "/string" }, Page);
       const endpoint = $rpcQuery("string-endpoint", { schema: value => value }, async () => 1);
       export { page as "string-route", endpoint as "string-endpoint" };`,
    );
    const plugin = sol();
    (plugin.configResolved as unknown as (config: ResolvedConfig) => void)({
      command: "build",
      root,
    } as ResolvedConfig);
    const manifest = await (plugin.load as (id: string) => Promise<string>)("\0virtual:sol/routes");
    expect(manifest).toContain('module["string-route"]');
    const endpoints = await (plugin.load as (id: string) => Promise<string>)(
      "\0virtual:sol/server-endpoints",
    );
    expect(endpoints).toContain("page.sol.ts?sol-endpoints");

    const transform = plugin.transform as unknown as {
      handler: (
        this: { resolve(specifier: string): Promise<{ id: string } | null> },
        source: string,
        id: string,
        options: { ssr: boolean },
      ) => Promise<{ code: string }>;
    };
    const source = await Bun.file(routeFile).text();
    const projected = await transform.handler.call(
      { resolve: async () => null },
      source,
      `${routeFile}?sol-route-handles`,
      { ssr: false },
    );
    expect(projected.code).toContain('as "string-route"');

    const context = { resolve: async () => ({ id: routeFile }) };
    const imported = await transform.handler.call(
      context,
      `import { "string-route" as page } from ${JSON.stringify(routeFile)}; console.log(page);`,
      join(root, "consumer.ts"),
      { ssr: false },
    );
    expect(imported.code).toContain(JSON.stringify(`${routeFile}?sol-route-handles`).slice(1, -1));
    const reexported = await transform.handler
      .call(
        context,
        `export { "string-route" as routed } from ${JSON.stringify(routeFile)};`,
        join(root, "reexport.ts"),
        { ssr: false },
      )
      .catch((error: unknown) => error);
    expect(String(reexported)).toContain("route re-exports");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects extensionless route imports and rejects unsafe namespace and re-export forms", async () => {
  const root = await mkdtemp(join(import.meta.dir, "route-import-forms-"));
  try {
    await Promise.all([
      writeFile(join(root, "Page.tsx"), `export function Page() { return null; }`),
      writeFile(
        join(root, "page.sol.tsx"),
        `import { $route } from "@soljs/sol";
         import { Page } from "./Page";
         console.log("EXTENSIONLESS_PAGE_SECRET");
         export const page = $route({ path: "/page" }, Page);`,
      ),
      writeFile(
        join(root, "entry.tsx"),
        `import {
  page,
} from "./page.sol";
import { $component } from "@soljs/sol";
export const App = $component(function App() { return <p>Ready</p>; });
console.log(page, App);`,
      ),
    ]);
    const warnings: string[] = [];
    const buildEntry = (input: string) =>
      build({
        root,
        logLevel: "silent",
        plugins: [sol()],
        build: {
          minify: false,
          sourcemap: true,
          write: false,
          rollupOptions: {
            input,
            onLog(_level, log, handler) {
              if (log.code === "SOURCEMAP_BROKEN") warnings.push(log.message);
              else handler("warn", log);
            },
          },
        },
      });
    const result = await buildEntry(join(root, "entry.tsx"));
    const entry = (Array.isArray(result) ? result : [result])
      .flatMap((item) => ("output" in item ? item.output : []))
      .find((item) => item.type === "chunk" && item.isEntry);
    const entryCode = entry?.type === "chunk" ? entry.code : "";
    const entryFile = normalizePath(join(root, "entry.tsx"));
    const metadataOffset = entryCode.indexOf(entryFile);
    expect(metadataOffset).toBeGreaterThanOrEqual(0);
    expect(entryCode.slice(metadataOffset, metadataOffset + entryFile.length + 100)).toMatch(
      /line:\s*5/,
    );
    expect(warnings).toEqual([]);
    expect(entry?.type === "chunk" ? entry.map?.sourcesContent : []).toContain(
      `import {
  page,
} from "./page.sol";
import { $component } from "@soljs/sol";
export const App = $component(function App() { return <p>Ready</p>; });
console.log(page, App);`,
    );

    await writeFile(
      join(root, "namespace.ts"),
      `import * as pages from "./page.sol.tsx"; console.log(pages.page);`,
    );
    const namespaceFailure = await buildEntry(join(root, "namespace.ts")).catch(
      (error: unknown) => error,
    );
    expect(String(namespaceFailure)).toContain("namespace route imports");
    await writeFile(join(root, "reexport.ts"), `export { page } from "./page.sol.tsx";`);
    const reexportFailure = await buildEntry(join(root, "reexport.ts")).catch(
      (error: unknown) => error,
    );
    expect(String(reexportFailure)).toContain("route re-exports");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("route and endpoint entries exclude lazy page dependencies", async () => {
  const root = await mkdtemp(join(import.meta.dir, "route-projection-"));
  try {
    await Promise.all([
      writeFile(
        join(root, "entry.ts"),
        `import routes from "virtual:sol/routes";
         import endpoints from "virtual:sol/server-endpoints";
         console.log(routes, endpoints);`,
      ),
      writeFile(
        join(root, "page.sol.tsx"),
        `import { $httpRoute, $route } from "@soljs/sol";
         import "./page.css";
         import { Page } from "./Page";
         import { routeSchema } from "./schema";
         export const page = $route({ path: "/page/:id", schema: routeSchema }, Page);
         export const endpoint = $httpRoute(
           { method: "GET", path: "/api/page", schema: value => value },
           async () => new Response("endpoint"),
         );`,
      ),
      writeFile(
        join(root, "Page.tsx"),
        `import { $component } from "@soljs/sol";
         import "./nested.css";
         import "./page-effect";
         export const Page = $component(function Page() {
           return <main>{"PAGE_IMPLEMENTATION_SECRET"}</main>;
         });`,
      ),
      writeFile(join(root, "page-effect.ts"), `console.log("PAGE_TRANSITIVE_EFFECT_SECRET");`),
      writeFile(
        join(root, "nested.css"),
        `.nested { --projection-marker: "PAGE_TRANSITIVE_STYLE_SECRET"; }`,
      ),
      writeFile(
        join(root, "schema.ts"),
        `export const routeSchema = {
           parse(value: unknown) { console.log("ROUTE_SCHEMA_SECRET"); return value; }
         };`,
      ),
      writeFile(join(root, "page.css"), `.page { --projection-marker: "ROUTE_STYLE_SECRET"; }`),
    ]);

    const result = await build({
      root,
      logLevel: "silent",
      plugins: [sol()],
      build: {
        write: false,
        rollupOptions: { input: join(root, "entry.ts") },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
      if (!("output" in item)) throw new Error("Expected a completed Vite build");
      return item.output;
    });
    const entry = outputs.find((output) => output.type === "chunk" && output.isEntry);
    if (!entry || entry.type !== "chunk") throw new Error("Expected an entry chunk");
    const lazyOutput = outputs
      .filter((output) => output !== entry)
      .map((output) => (output.type === "chunk" ? output.code : String(output.source)))
      .join("\n");

    expect(entry.code).not.toContain("PAGE_IMPLEMENTATION_SECRET");
    expect(entry.code).not.toContain("ROUTE_SCHEMA_SECRET");
    expect(entry.code).not.toContain("ROUTE_STYLE_SECRET");
    expect(entry.code).not.toContain("PAGE_TRANSITIVE_EFFECT_SECRET");
    expect(entry.code).not.toContain("PAGE_TRANSITIVE_STYLE_SECRET");
    expect(lazyOutput).toContain("PAGE_IMPLEMENTATION_SECRET");
    expect(lazyOutput).toContain("ROUTE_SCHEMA_SECRET");
    expect(lazyOutput).toContain("ROUTE_STYLE_SECRET");
    expect(lazyOutput).toContain("PAGE_TRANSITIVE_EFFECT_SECRET");
    expect(lazyOutput).toContain("PAGE_TRANSITIVE_STYLE_SECRET");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mixed route imports preserve ordinary module exports and side effects", async () => {
  const root = await mkdtemp(join(import.meta.dir, "mixed-route-import-"));
  try {
    await Promise.all([
      writeFile(
        join(root, "entry.ts"),
        `import { page, publicValue } from "./page.sol.tsx";
         import "./bare.sol.tsx";
         import routes from "virtual:sol/routes";
         console.log(page, publicValue, routes);`,
      ),
      writeFile(
        join(root, "page.sol.tsx"),
        `import { $route } from "@soljs/sol";
         import "./module.css";
         import { Page } from "./Page";
         console.log("ORDINARY_MODULE_EFFECT_SECRET");
         export const publicValue = "ORDINARY_EXPORT_SECRET";
         export const page = $route({ path: "/page" }, Page);`,
      ),
      writeFile(join(root, "Page.tsx"), `export function Page() { return null; }`),
      writeFile(
        join(root, "bare.sol.tsx"),
        `import { $route } from "@soljs/sol";
         import { Page } from "./Page";
         console.log("BARE_ROUTE_MODULE_EFFECT_SECRET");
         export const bare = $route({ path: "/bare" }, Page);`,
      ),
      writeFile(
        join(root, "module.css"),
        `.module { --projection-marker: "ORDINARY_MODULE_STYLE_SECRET"; }`,
      ),
    ]);
    const result = await build({
      root,
      logLevel: "silent",
      plugins: [sol()],
      build: { write: false, rollupOptions: { input: join(root, "entry.ts") } },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
      if (!("output" in item)) throw new Error("Expected a completed Vite build");
      return item.output;
    });
    const output = outputs
      .filter(
        (item) =>
          (item.type === "chunk" && item.isEntry) ||
          (item.type === "asset" && item.fileName.endsWith(".css")),
      )
      .map((item) => (item.type === "chunk" ? item.code : String(item.source)))
      .join("\n");

    expect(output).toContain("ORDINARY_EXPORT_SECRET");
    expect(output).toContain("ORDINARY_MODULE_EFFECT_SECRET");
    expect(output).toContain("ORDINARY_MODULE_STYLE_SECRET");
    expect(output.match(/ORDINARY_MODULE_EFFECT_SECRET/g)).toHaveLength(1);
    expect(output.match(/BARE_ROUTE_MODULE_EFFECT_SECRET/g)).toHaveLength(1);
    const routeModuleIds = outputs
      .filter((item) => item.type === "chunk")
      .flatMap((item) => Object.keys(item.modules))
      .filter((id) => id.endsWith("/page.sol.tsx"));
    expect([...new Set(routeModuleIds)]).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handle-only imports preserve authored initialization without page effects", async () => {
  const root = await mkdtemp(join(import.meta.dir, "route-handle-effects-"));
  try {
    await Promise.all([
      writeFile(
        join(root, "entry.ts"),
        `import { page } from "./page.sol.tsx"; console.log(page);`,
      ),
      writeFile(
        join(root, "page.sol.tsx"),
        `import { $route } from "@soljs/sol";
         import "./page.css";
         import "./authored-setup";
         import { Page } from "./Page";
         const state = { ready: false };
         function registerPlugin() { console.log("UNUSED_PLUGIN_REGISTRATION_SECRET"); return {}; }
         const plugin = registerPlugin();
         function initialize(value: { ready: boolean }) {
           console.log("AUTHORED_HANDLE_EFFECT_SECRET"); value.ready = true;
         }
         initialize(state);
         export const page = $route({ path: "/page" }, Page);`,
      ),
      writeFile(
        join(root, "Page.tsx"),
        `import "./transitive.css";
         import "./transitive-effect";
         export function Page() { return null; }`,
      ),
      writeFile(join(root, "page.css"), `.page { color: red; }`),
      writeFile(join(root, "authored-setup.ts"), `console.log("BARE_SIDE_EFFECT_IMPORT_SECRET");`),
      writeFile(
        join(root, "transitive.css"),
        `.page { --marker: "HANDLE_TRANSITIVE_STYLE_SECRET"; }`,
      ),
      writeFile(
        join(root, "transitive-effect.ts"),
        `console.log("HANDLE_TRANSITIVE_EFFECT_SECRET");`,
      ),
    ]);
    const result = await build({
      root,
      logLevel: "silent",
      plugins: [sol()],
      build: { write: false, rollupOptions: { input: join(root, "entry.ts") } },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
      if (!("output" in item)) throw new Error("Expected a completed Vite build");
      return item.output;
    });
    const output = outputs
      .filter(
        (item) =>
          (item.type === "chunk" && item.isEntry) ||
          (item.type === "asset" && item.fileName.endsWith(".css")),
      )
      .map((item) => (item.type === "chunk" ? item.code : String(item.source)))
      .join("\n");
    const entry = outputs.find((item) => item.type === "chunk" && item.isEntry);
    if (!entry || entry.type !== "chunk") throw new Error("Expected an entry chunk");
    const entryModules = Object.keys(entry.modules);

    expect(output.includes("AUTHORED_HANDLE_EFFECT_SECRET")).toBe(false);
    expect(output.includes("BARE_SIDE_EFFECT_IMPORT_SECRET")).toBe(false);
    expect(output.includes("UNUSED_PLUGIN_REGISTRATION_SECRET")).toBe(false);
    expect(entryModules.some((id) => id.endsWith("/Page.tsx"))).toBe(false);
    expect(entryModules.some((id) => id.endsWith("/transitive-effect.ts"))).toBe(false);
    expect(output.includes("HANDLE_TRANSITIVE_STYLE_SECRET")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("endpoint projections retain dependency initialization and project route handles", async () => {
  const root = await mkdtemp(join(import.meta.dir, "endpoint-projection-effects-"));
  try {
    await Promise.all([
      writeFile(
        join(root, "entry.ts"),
        `import endpoints from "virtual:sol/server-endpoints"; console.log(endpoints);`,
      ),
      writeFile(
        join(root, "endpoint.sol.tsx"),
        `import { $component, $httpRoute, $route } from "@soljs/sol";
         import type { ExternalShape } from "./types";
         type Shape = ExternalShape;
         export type { Shape };
         import { detail } from "./detail.sol.tsx";
         let schema;
         function makeSchema() {
           console.log("ENDPOINT_ASSIGNMENT_SECRET");
           return (value: unknown) => value;
         }
         function configure(value: unknown) {
           console.log("ENDPOINT_INITIALIZATION_EFFECT_SECRET", value);
         }
         function nestedEffect(name: string) { console.log(name); return name; }
         const conditionalEffect = true ? nestedEffect("ENDPOINT_CONDITIONAL_EFFECT") : "";
         const logicalEffect = false || nestedEffect("ENDPOINT_LOGICAL_EFFECT");
         const sequenceEffect = (0, nestedEffect("ENDPOINT_SEQUENCE_EFFECT"));
         const computedEffect = ({})[nestedEffect("ENDPOINT_COMPUTED_EFFECT")];
         class PluginRegistration {
           static { nestedEffect("ENDPOINT_CLASS_STATIC_EFFECT"); }
         }
         const EndpointConsumer = $component(function EndpointConsumer() {
           endpoint;
           return <main>{"ROUTE_COMPONENT_USING_ENDPOINT_SECRET"}</main>;
         });
         export const consumer = $route({ path: "/consumer", schema }, EndpointConsumer);
         if (globalThis) { schema = makeSchema(); }
         configure(schema);
         console.log("UNRELATED_ENDPOINT_MODULE_EFFECT_SECRET");
         export const endpoint = $httpRoute(
           { method: "GET", path: "/api/detail", schema: schema as (value: Shape) => Shape },
           async () => new Response(detail.path + consumer.path),
         );`,
      ),
      writeFile(join(root, "types.ts"), `export type ExternalShape = unknown;`),
      writeFile(
        join(root, "detail.sol.tsx"),
        `import { $route } from "@soljs/sol";
         import { Detail } from "./Detail";
         export const detail = $route({ path: "/detail" }, Detail);`,
      ),
      writeFile(
        join(root, "Detail.tsx"),
        `import "./detail.css";
         import "./detail-effect";
         export function Detail() { return null; }`,
      ),
      writeFile(join(root, "detail.css"), `.detail { --marker: "ENDPOINT_ROUTE_STYLE_SECRET"; }`),
      writeFile(join(root, "detail-effect.ts"), `console.log("ENDPOINT_ROUTE_EFFECT_SECRET");`),
    ]);
    const result = await build({
      root,
      logLevel: "silent",
      plugins: [sol()],
      build: { write: false, ssr: true, rollupOptions: { input: join(root, "entry.ts") } },
    });
    const output = (Array.isArray(result) ? result : [result])
      .flatMap((item) => {
        if (!("output" in item)) throw new Error("Expected a completed Vite build");
        return item.output;
      })
      .filter(
        (item) =>
          (item.type === "chunk" && item.isEntry) ||
          (item.type === "asset" && item.fileName.endsWith(".css")),
      )
      .map((item) => (item.type === "chunk" ? item.code : String(item.source)))
      .join("\n");

    expect(output.includes("ENDPOINT_ASSIGNMENT_SECRET")).toBe(true);
    expect(output.includes("ENDPOINT_INITIALIZATION_EFFECT_SECRET")).toBe(true);
    expect(output.includes("ENDPOINT_CONDITIONAL_EFFECT")).toBe(true);
    expect(output.includes("ENDPOINT_LOGICAL_EFFECT")).toBe(true);
    expect(output.includes("ENDPOINT_SEQUENCE_EFFECT")).toBe(true);
    expect(output.includes("ENDPOINT_COMPUTED_EFFECT")).toBe(true);
    expect(output.includes("ENDPOINT_CLASS_STATIC_EFFECT")).toBe(true);
    expect(output.includes("ROUTE_COMPONENT_USING_ENDPOINT_SECRET")).toBe(false);
    expect(output.includes("UNRELATED_ENDPOINT_MODULE_EFFECT_SECRET")).toBe(false);
    expect(output.includes("ENDPOINT_ROUTE_EFFECT_SECRET")).toBe(false);
    expect(output.includes("ENDPOINT_ROUTE_STYLE_SECRET")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the endpoint manifest respects helper bindings and canonical HTTP paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-endpoints-"));
  try {
    await writeFile(
      join(root, "real.sol.ts"),
      `import * as sol from "@soljs/sol"; const load = sol["$rpcQuery"]("load", { schema: x => x }, async () => 1); export { load as query };`,
    );
    await writeFile(
      join(root, "shadow.sol.ts"),
      `function $rpcQuery() { return null; } export const local = $rpcQuery("load", {}, null);`,
    );
    const plugin = sol();
    (plugin.configResolved as unknown as (config: ResolvedConfig) => void)({
      command: "build",
      root,
    } as ResolvedConfig);
    const resolved = (plugin.resolveId as (id: string) => string)("virtual:sol/server-endpoints");
    const manifest = await (plugin.load as (id: string) => Promise<unknown>)(resolved);
    expect(manifest).toBeString();

    await writeFile(
      join(root, "unicode-a.sol.ts"),
      `import { $httpRoute as route } from "@soljs/sol"; export const a = route({ method: "GET", path: "/café space", schema: x => x }, async () => new Response());`,
    );
    await writeFile(
      join(root, "unicode-b.sol.ts"),
      `export const b = $httpRoute({ method: "GET", path: "/cafe\u0301 space", schema: x => x }, async () => new Response());`,
    );
    const collision = await (plugin.load as (id: string) => Promise<unknown>)(resolved).catch(
      (error: unknown) => error,
    );
    expect(collision).toBeInstanceOf(Error);
    expect((collision as Error).message).toContain("Duplicate server endpoint");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retries route-file inspection after a source failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-inspection-retry-"));
  try {
    const file = join(root, "retry.sol.ts");
    await writeFile(file, `export const retry = $httpRoute(`);
    const plugin = sol();
    (plugin.configResolved as unknown as (config: ResolvedConfig) => void)({
      command: "build",
      root,
    } as ResolvedConfig);
    const resolved = (plugin.resolveId as (id: string) => string)("virtual:sol/server-endpoints");
    const failure = await (plugin.load as (id: string) => Promise<unknown>)(resolved).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);

    await writeFile(
      file,
      `import { $httpRoute } from "@soljs/sol";
       export const retry = $httpRoute(
         { method: "GET", path: "/retry", schema: value => value },
         async () => new Response(),
       );`,
    );
    const manifest = await (plugin.load as (id: string) => Promise<string>)(resolved);
    expect(manifest).toContain("retry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes manifest generations for nested route additions", async () => {
  const root = await mkdtemp(join(tmpdir(), "sol-manifest-generation-"));
  try {
    const nested = join(root, "routes");
    await mkdir(nested);
    await writeFile(
      join(nested, "a.sol.ts"),
      `import { $route } from "@soljs/sol"; export const a = $route({ path: "/a" }, A);`,
    );
    const plugin = sol();
    (plugin.configResolved as unknown as (config: ResolvedConfig) => void)({
      command: "build",
      root,
    } as ResolvedConfig);
    const load = plugin.load as (id: string) => Promise<string>;
    const firstRoutes = await load("\0virtual:sol/routes");
    await load("\0virtual:sol/server-endpoints");
    expect(firstRoutes).toContain("a.sol.ts");

    await writeFile(
      join(nested, "b.sol.ts"),
      `import { $route } from "@soljs/sol"; export const b = $route({ path: "/b" }, B);`,
    );
    const secondRoutes = await load("\0virtual:sol/routes");
    expect(secondRoutes).toContain("b.sol.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("emits authored source metadata for query and mutation diagnostics", () => {
  const result = compile(
    `
      import { $component, $query as query, $mutation } from "@soljs/sol";
      const Requests = $component(function Requests() {
        const project = query({ queryKey: ["project"], query: async () => 1 });
        const save = $mutation({ mutation: async () => 1 });
        return <button onClick={() => save.mutate({})}>{project.data}</button>;
      });
    `,
    "Requests.tsx",
  );

  expect(result.code).toMatch(
    /__sol_query\(__sol_request_source\(\{[\s\S]*?file: "Requests\.tsx",[\s\S]*?line: 4,[\s\S]*?column: 24[\s\S]*?__sol_frame/,
  );
  expect(result.code).toMatch(
    /__sol_mutation\(__sol_request_source\(\{[\s\S]*?file: "Requests\.tsx",[\s\S]*?line: 5,[\s\S]*?column: 21[\s\S]*?__sol_frame/,
  );
});

test("binds request helpers to async component frames", () => {
  const result = compile(
    `import { $component, $query, $mutation } from "@soljs/sol";
     const Requests = $component(async function Requests() {
       await Promise.resolve();
       const query = $query({ queryKey: "late", query: async () => 1 });
       const mutation = $mutation({ mutation: async () => 2 });
       return <p>{query.data}{mutation.data}</p>;
     });`,
    "AsyncRequests.tsx",
  );

  expect(result.code).toContain("__sol_query(__sol_request_source(");
  expect(result.code).toContain("__sol_mutation(__sol_request_source(");
  expect(result.code).not.toMatch(/const query = \$query\(/);
  expect(result.code).not.toMatch(/const mutation = \$mutation\(/);
});

test("an explicitly enabled production build bundles devtools", async () => {
  const result = await build({
    root: join(import.meta.dir, "fixtures/devtools-build"),
    logLevel: "silent",
    plugins: [sol({ devtools: true })],
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => {
    if (!("output" in item)) throw new Error("Expected a completed Vite build");
    return item.output;
  });
  const bundled = outputs
    .map((output) => (output.type === "chunk" ? output.code : String(output.source)))
    .join("\n");

  expect(bundled).toContain("sol_get_diagnostics");
  expect(bundled).not.toContain("/@id/@soljs/sol/devtools");
});
