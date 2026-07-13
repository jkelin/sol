import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { normalizePath } from "vite";
import { compile } from "./compile.ts";

const virtualRoutes = "virtual:solix/routes";
const resolvedVirtualRoutes = `\0${virtualRoutes}`;
const componentFile = /\.tsx(?:\?.*)?$/;
const routeFile = /\.route\.[jt]sx?(?:\?.*)?$/i;

function isRouteFile(file: string): boolean {
  return routeFile.test(file.replaceAll("\\", "/"));
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

function declaredRoutePaths(source: string, filename: string): string[] {
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ["typescript", "jsx"],
  });
  const paths: string[] = [];
  for (const statement of ast.program.body) {
    const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
    if (!t.isVariableDeclaration(declaration)) continue;
    for (const variable of declaration.declarations) {
      if (
        !t.isCallExpression(variable.init) ||
        !t.isIdentifier(variable.init.callee, { name: "$route" }) ||
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

async function validateRouteCollisions(files: readonly string[]): Promise<void> {
  const declarations = await Promise.all(
    files.map(async (file) => ({
      file,
      paths: declaredRoutePaths(await readFile(file, "utf8"), file),
    })),
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
}

export function solix(): Plugin {
  let config: ResolvedConfig;
  const invalidateManifest = (server: ViteDevServer, file: string): void => {
    if (!isRouteFile(file) || relative(config.root, file).startsWith("..")) return;
    const module = server.moduleGraph.getModuleById(resolvedVirtualRoutes);
    if (module) server.moduleGraph.invalidateModule(module);
    server.ws.send({ type: "full-reload" });
  };

  return {
    name: "solix",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
    },
    resolveId(id) {
      return id === virtualRoutes ? resolvedVirtualRoutes : null;
    },
    async load(id) {
      if (id !== resolvedVirtualRoutes) return null;
      const files = await discoverRoutes(config.root);
      await validateRouteCollisions(files);
      return routeManifest(files);
    },
    configureServer(server) {
      const added = (file: string): void => invalidateManifest(server, file);
      const removed = (file: string): void => invalidateManifest(server, file);
      server.watcher.on("add", added);
      server.watcher.on("unlink", removed);
      return () => {
        server.watcher.off("add", added);
        server.watcher.off("unlink", removed);
      };
    },
    transform: {
      filter: { id: [componentFile, routeFile] },
      handler(source, id) {
        if ((!componentFile.test(id) && !routeFile.test(id)) || id.includes("/node_modules/")) {
          return null;
        }
        return compile(source, id.split("?", 1)[0]);
      },
    },
  };
}
