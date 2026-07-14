import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { normalizePath } from "vite";
import { traverse } from "./ast.ts";
import { compile } from "./compile.ts";
import { canonicalHttpRoutePath } from "./http-path.ts";

const virtualRoutes = "virtual:solix/routes";
const resolvedVirtualRoutes = `\0${virtualRoutes}`;
const virtualEndpoints = "virtual:solix/server-endpoints";
const resolvedVirtualEndpoints = `\0${virtualEndpoints}`;
const devtoolsBuildEntry = "/@solix/devtools";
const resolvedDevtoolsBuildEntry = "\0solix:devtools-entry";
const componentFile = /\.tsx(?:\?.*)?$/;
const solFile = /\.sol\.tsx?(?:\?.*)?$/i;

export interface SolixPluginOptions {
  /** Inject the in-app diagnostics panel and global API. Defaults to true for Vite dev servers. */
  readonly devtools?: boolean;
}

function isRouteFile(file: string): boolean {
  return solFile.test(file.replaceAll("\\", "/"));
}

async function discoverRoutes(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) return;
          await walk(join(directory, entry.name));
        } else if (entry.isFile()) {
          const file = join(directory, entry.name);
          if (isRouteFile(file)) files.push(file);
        }
      }),
    );
  }
  await walk(root);
  return files.toSorted((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

function routeManifest(files: readonly string[]): string {
  const imports = files.map((file, index) => {
    const specifier = `/@fs/${normalizePath(file)}`;
    return `import * as __solix_route_module_${index} from ${JSON.stringify(specifier)};`;
  });
  const modules = files.map((_, index) => `__solix_route_module_${index}`).join(", ");
  return `${imports.join("\n")}
import { isRouteDefinition as __solix_is_route } from "solix/compiler-runtime";
const __solix_modules = [${modules}];
export default __solix_modules.flatMap(module => Object.values(module).filter(__solix_is_route));`;
}

function endpointManifest(files: readonly string[]): string {
  const imports = files.map((file, index) => {
    const specifier = `/@fs/${normalizePath(file)}`;
    return `import * as __solix_endpoint_module_${index} from ${JSON.stringify(specifier)};`;
  });
  const modules = files.map((_, index) => `__solix_endpoint_module_${index}`).join(", ");
  return `${imports.join("\n")}
import { isServerEndpoint as __solix_is_endpoint } from "solix/compiler-runtime";
const __solix_modules = [${modules}];
export default __solix_modules.flatMap(module => Object.values(module).filter(__solix_is_endpoint));`;
}

type DeclarationHelper = "$route" | "$rpcQuery" | "$rpcMutation" | "$httpRoute";

function declarationHelperBindings(ast: t.File): {
  names: Map<string, DeclarationHelper>;
  namespaces: Set<string>;
} {
  const helpers = new Set<DeclarationHelper>(["$route", "$rpcQuery", "$rpcMutation", "$httpRoute"]);
  const names = new Map<string, DeclarationHelper>();
  const namespaces = new Set<string>();
  for (const statement of ast.program.body) {
    if (!t.isImportDeclaration(statement) || statement.source.value !== "solix") continue;
    for (const specifier of statement.specifiers) {
      if (t.isImportNamespaceSpecifier(specifier)) {
        namespaces.add(specifier.local.name);
        continue;
      }
      if (
        t.isImportSpecifier(specifier) &&
        t.isIdentifier(specifier.imported) &&
        helpers.has(specifier.imported.name as DeclarationHelper)
      ) {
        names.set(specifier.local.name, specifier.imported.name as DeclarationHelper);
      }
    }
  }
  traverse(ast, {
    Program(path) {
      for (const helper of helpers) {
        if (!path.scope.hasBinding(helper)) names.set(helper, helper);
      }
      path.stop();
    },
  });
  return { names, namespaces };
}

function manifestCallHelper(
  bindings: ReturnType<typeof declarationHelperBindings>,
  callee: t.Expression | t.V8IntrinsicIdentifier,
): DeclarationHelper | undefined {
  if (t.isIdentifier(callee)) return bindings.names.get(callee.name);
  if (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.object) &&
    t.isIdentifier(callee.property) &&
    bindings.namespaces.has(callee.object.name)
  ) {
    return ["$route", "$rpcQuery", "$rpcMutation", "$httpRoute"].includes(callee.property.name)
      ? (callee.property.name as DeclarationHelper)
      : undefined;
  }
  return undefined;
}

function manifestExportedNames(ast: t.File): Set<string> {
  const names = new Set<string>();
  for (const statement of ast.program.body) {
    if (!t.isExportNamedDeclaration(statement) || statement.source) continue;
    if (statement.declaration) {
      for (const name of Object.keys(t.getBindingIdentifiers(statement.declaration)))
        names.add(name);
    }
    for (const specifier of statement.specifiers) {
      if (t.isExportSpecifier(specifier) && t.isIdentifier(specifier.local))
        names.add(specifier.local.name);
    }
  }
  return names;
}

function declaredRoutePaths(source: string, filename: string): string[] {
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ["typescript", "jsx"],
  });
  const helpers = declarationHelperBindings(ast);
  const exportedNames = manifestExportedNames(ast);
  const paths: string[] = [];
  for (const statement of ast.program.body) {
    const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
    if (!t.isVariableDeclaration(declaration)) continue;
    for (const variable of declaration.declarations) {
      if (
        !t.isCallExpression(variable.init) ||
        !t.isIdentifier(variable.id) ||
        !exportedNames.has(variable.id.name) ||
        manifestCallHelper(helpers, variable.init.callee) !== "$route" ||
        !t.isObjectExpression(variable.init.arguments[0])
      )
        continue;
      const path = variable.init.arguments[0].properties.find(
        (property) =>
          t.isObjectProperty(property) &&
          !property.computed &&
          t.isIdentifier(property.key, { name: "path" }),
      );
      if (path && t.isObjectProperty(path) && t.isStringLiteral(path.value)) {
        paths.push(path.value.value);
      }
    }
  }
  return paths;
}

interface DeclaredEndpoint {
  readonly method: string;
  readonly path: string;
}

function declaredEndpoints(source: string, filename: string): DeclaredEndpoint[] {
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ["typescript", "jsx"],
  });
  const helpers = declarationHelperBindings(ast);
  const exportedNames = manifestExportedNames(ast);
  const endpoints: DeclaredEndpoint[] = [];
  for (const statement of ast.program.body) {
    const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
    if (!t.isVariableDeclaration(declaration)) continue;
    for (const variable of declaration.declarations) {
      if (
        !t.isIdentifier(variable.id) ||
        !exportedNames.has(variable.id.name) ||
        !t.isCallExpression(variable.init)
      )
        continue;
      const helper = manifestCallHelper(helpers, variable.init.callee);
      if (helper === "$rpcQuery" || helper === "$rpcMutation") {
        const name = variable.init.arguments[0];
        if (t.isStringLiteral(name)) {
          endpoints.push({
            method: "POST",
            path: `/api/rpc/${name.value}`,
          });
        }
      } else if (helper === "$httpRoute" && t.isObjectExpression(variable.init.arguments[0])) {
        const properties = variable.init.arguments[0].properties;
        const method = properties.find(
          (property) =>
            t.isObjectProperty(property) && t.isIdentifier(property.key, { name: "method" }),
        );
        const path = properties.find(
          (property) =>
            t.isObjectProperty(property) && t.isIdentifier(property.key, { name: "path" }),
        );
        if (
          method &&
          path &&
          t.isObjectProperty(method) &&
          t.isStringLiteral(method.value) &&
          t.isObjectProperty(path) &&
          t.isStringLiteral(path.value)
        ) {
          endpoints.push({
            method: method.value.value,
            path: canonicalHttpRoutePath(path.value.value),
          });
        }
      }
    }
  }
  return endpoints;
}

async function validateRouteCollisions(files: readonly string[]): Promise<void> {
  const declarations = await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, "utf8");
      return {
        file,
        paths: declaredRoutePaths(source, file),
        endpoints: declaredEndpoints(source, file),
      };
    }),
  );
  const matchers = new Map<string, { file: string; path: string }>();
  for (const declaration of declarations) {
    for (const path of declaration.paths) {
      const matcher = path
        .split("?", 1)[0]!
        .split("/")
        .map((segment) => (segment.startsWith(":") ? ":" : segment))
        .join("/");
      const existing = matchers.get(matcher);
      if (existing) {
        throw new Error(
          `Duplicate route matcher ${existing.path} in ${existing.file} and ${path} in ${declaration.file}`,
        );
      }
      matchers.set(matcher, { file: declaration.file, path });
    }
  }
  const endpointMatchers = new Map<string, { file: string; path: string }>();
  for (const declaration of declarations) {
    for (const endpoint of declaration.endpoints) {
      const matcher = `${endpoint.method} ${endpoint.path
        .split("/")
        .map((segment) => (segment.startsWith(":") ? ":" : segment))
        .join("/")}`;
      const existing = endpointMatchers.get(matcher);
      if (existing) {
        throw new Error(
          `Duplicate server endpoint ${endpoint.method} ${existing.path} in ${existing.file} and ${endpoint.path} in ${declaration.file}`,
        );
      }
      endpointMatchers.set(matcher, { file: declaration.file, path: endpoint.path });
    }
  }
}

export function solix(options: SolixPluginOptions = {}): Plugin {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("solix() options must be an object");
  }
  if (options.devtools !== undefined && typeof options.devtools !== "boolean") {
    throw new TypeError("solix() devtools must be a boolean");
  }
  let config: ResolvedConfig;
  let devtoolsEnabled = false;
  const invalidateManifest = (server: ViteDevServer, file: string): void => {
    if (!isRouteFile(file) || relative(config.root, file).startsWith("..")) return;
    for (const id of [resolvedVirtualRoutes, resolvedVirtualEndpoints]) {
      const module = server.moduleGraph.getModuleById(id);
      if (module) server.moduleGraph.invalidateModule(module);
    }
    server.ws.send({ type: "full-reload" });
  };

  return {
    name: "solix",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
      devtoolsEnabled = options.devtools ?? resolved.command === "serve";
    },
    transformIndexHtml: {
      order: "pre",
      handler() {
        if (!devtoolsEnabled) return [];
        return [
          {
            tag: "script",
            attrs: {
              type: "module",
              src: config.command === "serve" ? "/@id/solix/devtools" : devtoolsBuildEntry,
              "data-solix-devtools": "",
            },
            injectTo: "head-prepend",
          },
        ];
      },
    },
    resolveId(id) {
      if (id === virtualRoutes) return resolvedVirtualRoutes;
      if (id === virtualEndpoints) return resolvedVirtualEndpoints;
      return id === devtoolsBuildEntry ? resolvedDevtoolsBuildEntry : null;
    },
    async load(id) {
      if (id === resolvedDevtoolsBuildEntry) return 'import "solix/devtools";';
      if (id !== resolvedVirtualRoutes && id !== resolvedVirtualEndpoints) return null;
      const files = await discoverRoutes(config.root);
      await validateRouteCollisions(files);
      return id === resolvedVirtualRoutes ? routeManifest(files) : endpointManifest(files);
    },
    configureServer(server) {
      const changed = (file: string): void => invalidateManifest(server, file);
      server.watcher.on("add", changed);
      server.watcher.on("change", changed);
      server.watcher.on("unlink", changed);
    },
    transform: {
      filter: { id: [componentFile, solFile] },
      handler(source, id, transformOptions) {
        if ((!componentFile.test(id) && !solFile.test(id)) || id.includes("/node_modules/")) {
          return null;
        }
        return compile(source, id.split("?", 1)[0], {
          target: transformOptions?.ssr ? "server" : "client",
        });
      },
    },
  };
}
