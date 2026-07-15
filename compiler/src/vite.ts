import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import type { Scope } from "@babel/traverse";
import * as t from "@babel/types";
import type { HtmlTagDescriptor, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { normalizePath } from "vite";
import MagicString, { type SourceMap } from "magic-string";
import { type RawSourceMap, SourceMapConsumer, SourceMapGenerator } from "source-map-js";
import { generate, traverse } from "./ast.ts";
import { compile } from "./compile.ts";
import { canonicalHttpRoutePath } from "./http-path.ts";
import {
  canonicalizeStaticRouteSegment,
  compileRoutePath,
  type ParsedRoutePath,
} from "./route-path.ts";

const virtualRoutes = "virtual:sol/routes";
const resolvedVirtualRoutes = `\0${virtualRoutes}`;
const virtualEndpoints = "virtual:sol/server-endpoints";
const resolvedVirtualEndpoints = `\0${virtualEndpoints}`;
const devtoolsPackageEntry = "@soljs/sol/devtools";
const routerPackageEntry = "virtual:sol/router-entry";
const routerBuildEntry = "/@soljs/sol/router-entry";
const resolvedRouterBuildEntry = "\0sol:router-entry";
const componentFile = /\.tsx(?:\?.*)?$/;
const solFile = /\.sol\.tsx?(?:\?.*)?$/i;
const moduleFile = /\.[cm]?[jt]sx?(?:\?.*)?$/i;

export interface SolPluginOptions {
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

interface InspectedRouteFile {
  readonly file: string;
  readonly routes: readonly DeclaredRoute[];
  readonly endpoints: readonly DeclaredEndpoint[];
}

function routeManifest(inspections: readonly InspectedRouteFile[], root: string): string {
  const routeFiles = inspections.filter((inspection) => inspection.routes.length > 0);
  const files = routeFiles.map((inspection) => inspection.file);
  const declarations = routeFiles.map((inspection) => inspection.routes);
  const loaders = files.map((file, index) => {
    const specifier = `/@fs/${normalizePath(file)}`;
    return `const __sol_load_route_module_${index} = () => import(${JSON.stringify(specifier)});`;
  });
  let routeIndex = 0;
  const routes = declarations.flatMap((items, fileIndex) =>
    items.map((declaration) => {
      const name = `__sol_route_${routeIndex++}`;
      const loadExportName =
        declaration.exportNames.find((exportName) => exportName !== "default") ?? "default";
      return {
        name,
        assetKey: normalizePath(relative(root, files[fileIndex]!)),
        declaration,
        code: `const ${name} = __sol_lazy_route(${JSON.stringify(declaration.path)}, ${JSON.stringify(declaration.compiled)}, () => __sol_load_route_module_${fileIndex}().then(module => module[${JSON.stringify(loadExportName)}]));`,
      };
    }),
  );
  const staticPaths = declarations
    .flat()
    .filter((route) => route.compiled.pathnameParameterNames.length === 0)
    .map((route) => route.path.split("?", 1)[0]);
  return `import { lazyRoute as __sol_lazy_route } from "@soljs/sol/compiler-runtime";
${loaders.join("\n")}
${routes.map((route) => route.code).join("\n")}
export const staticRoutePaths = ${JSON.stringify([...new Set(staticPaths)])};
export const staticRoutes = [${routes.map((route) => `{ path: ${route.name}.config.path, compiled: ${route.name}.compiled, assetKey: ${JSON.stringify(route.assetKey)} }`).join(",\n")}];
export default [${routes.map((route) => route.name).join(",\n")}];`;
}

function endpointManifest(inspections: readonly InspectedRouteFile[]): string {
  const endpointFiles = inspections.filter((inspection) => inspection.endpoints.length > 0);
  const imports = endpointFiles.map(({ file }, index) => {
    const specifier = `/@fs/${normalizePath(file)}?sol-endpoints`;
    return `import * as __sol_endpoint_module_${index} from ${JSON.stringify(specifier)};`;
  });
  const modules = endpointFiles.map((_, index) => `__sol_endpoint_module_${index}`).join(", ");
  return `${imports.join("\n")}
import { isServerEndpoint as __sol_is_endpoint } from "@soljs/sol/compiler-runtime";
const __sol_modules = [${modules}];
export default [...new Set(__sol_modules.flatMap(module => Object.values(module).filter(__sol_is_endpoint)))];`;
}

function routeHandleProjection(source: string, filename: string): string {
  const routes = declaredRoutes(source, filename);
  const declarations = routes.map(
    (route, index) =>
      `const __sol_projected_route_${index} = __sol_route_handle({ path: ${JSON.stringify(route.path)} }, ${JSON.stringify(route.compiled)});`,
  );
  const exports = routes.flatMap((route, index) =>
    route.exportNames.map((exportName) =>
      exportName === "default"
        ? `export default __sol_projected_route_${index};`
        : `export { __sol_projected_route_${index} as ${
            t.isValidIdentifier(exportName) ? exportName : JSON.stringify(exportName)
          } };`,
    ),
  );
  return `import { routeHandle as __sol_route_handle } from "@soljs/sol/compiler-runtime";
${declarations.join("\n")}
${exports.join("\n")}`;
}

interface Projection {
  readonly code: string;
  readonly map?: SourceMap | string;
}

function moduleExportName(name: t.Identifier | t.StringLiteral): string {
  return t.isIdentifier(name) ? name.name : name.value;
}

function setsIntersect(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const name of left) if (right.has(name)) return true;
  return false;
}

function sourceMapJson(map: SourceMap | string): RawSourceMap {
  return JSON.parse(typeof map === "string" ? map : map.toString()) as RawSourceMap;
}

function replacementProjection(source: string, code: string, filename: string): Projection {
  const transformed = new MagicString(source);
  if (code !== source) transformed.overwrite(0, source.length, code);
  const map = transformed.generateMap({
    hires: true,
    source: filename,
    includeContent: true,
  });
  if (code !== source) {
    const generatedContent = sourceMapJson(map);
    generatedContent.sourcesContent = generatedContent.sources.map(() => code);
    return { code, map: JSON.stringify(generatedContent) };
  }
  return {
    code,
    map,
  };
}

function composeSourceMaps(
  generated: SourceMap | string,
  previous: SourceMap | string,
  filename: string,
  sourceContent?: string,
): string {
  const generatedConsumer = new SourceMapConsumer(sourceMapJson(generated));
  const previousConsumer = new SourceMapConsumer(sourceMapJson(previous));
  const combined = SourceMapGenerator.fromSourceMap(generatedConsumer);
  combined.applySourceMap(previousConsumer, filename);
  if (sourceContent !== undefined) {
    for (const source of previousConsumer.sources) combined.setSourceContent(source, sourceContent);
  }
  return combined.toString();
}

function effectfulDeclaration(
  statement: t.Statement,
  expressionPurity: WeakMap<t.Expression, boolean>,
): boolean {
  const expressionIsPure = (expression: t.Expression): boolean =>
    expressionPurity.get(expression) ?? false;
  const declaration = t.isExportNamedDeclaration(statement) ? statement.declaration : statement;
  if (t.isVariableDeclaration(declaration)) {
    return declaration.declarations.some(
      (item) => item.init && t.isExpression(item.init) && !expressionIsPure(item.init),
    );
  }
  if (!t.isClassDeclaration(declaration)) return false;
  return declaration.body.body.some(
    (item) =>
      (t.isStaticBlock(item) && item.body.length > 0) ||
      ((t.isClassProperty(item) || t.isClassPrivateProperty(item)) &&
        item.static &&
        item.value !== null &&
        t.isExpression(item.value) &&
        !expressionIsPure(item.value)) ||
      ("computed" in item &&
        item.computed &&
        "key" in item &&
        t.isExpression(item.key) &&
        !expressionIsPure(item.key)),
  );
}

function dependencyProjection(source: string, filename: string): string {
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ["typescript", "jsx"],
  });
  const helpers = declarationHelperBindings(ast);
  const exportedNames = manifestExportedNames(ast);
  const routes = declaredRoutes(source, filename, { ast, helpers, exportedNames });
  const roots = new Set<string>();
  const routeRoots = new Set<string>();
  const routeDependencies = new Set<string>();
  const expressionPurity = new WeakMap<t.Expression, boolean>();
  traverse(ast, {
    Expression(path) {
      const parent = path.parent;
      const declarationInitializer = t.isVariableDeclarator(parent) && parent.init === path.node;
      const classValue =
        (t.isClassProperty(parent) || t.isClassPrivateProperty(parent)) &&
        parent.static &&
        parent.value === path.node;
      const classKey =
        t.isClassBody(path.parentPath?.parent) &&
        "computed" in parent &&
        parent.computed &&
        "key" in parent &&
        parent.key === path.node;
      if (declarationInitializer || classValue || classKey) {
        expressionPurity.set(path.node, path.isPure());
      }
    },
    VariableDeclarator(path) {
      const helper = t.isCallExpression(path.node.init)
        ? manifestCallHelper(helpers, path.node.init.callee)
        : undefined;
      if (
        t.isIdentifier(path.node.id) &&
        exportedNames.has(path.node.id.name) &&
        (helper === "$rpcQuery" || helper === "$rpcMutation" || helper === "$httpRoute")
      ) {
        roots.add(path.node.id.name);
      }
      if (helper === "$route" && t.isCallExpression(path.node.init)) {
        if (t.isIdentifier(path.node.id)) routeRoots.add(path.node.id.name);
        for (const binding of Object.values(path.scope.bindings)) {
          if (
            binding.referencePaths.some(
              (reference) =>
                reference.node.start! >= path.node.init!.start! &&
                reference.node.end! <= path.node.init!.end!,
            )
          ) {
            routeDependencies.add(binding.identifier.name);
          }
        }
      }
    },
  });
  let programScope: Scope | undefined;
  traverse(ast, {
    Program(path) {
      programScope = path.scope;
      path.stop();
    },
  });
  if (!programScope) throw new Error("Expected endpoint projection program scope");
  const scope = programScope;
  const bindingDependencies = new Map<string, Set<string>>();
  for (const [name, binding] of Object.entries(scope.bindings)) {
    const dependencies = new Set<string>();
    if (!routeRoots.has(name))
      binding.path.traverse({
        ReferencedIdentifier(path) {
          const dependency = path.node.name;
          if (scope.bindings[dependency] === path.scope.getBinding(dependency)) {
            dependencies.add(dependency);
          }
        },
      });
    bindingDependencies.set(name, dependencies);
  }
  const addClosure = (names: Set<string>, additions: Iterable<string>): void => {
    const queue: string[] = [];
    for (const name of additions) {
      if (names.has(name)) continue;
      names.add(name);
      queue.push(name);
    }
    while (queue.length) {
      for (const dependency of bindingDependencies.get(queue.pop()!) ?? []) {
        if (names.has(dependency)) continue;
        names.add(dependency);
        queue.push(dependency);
      }
    }
  };
  const routeOwned = new Set<string>();
  addClosure(routeOwned, routeDependencies);
  for (const name of routeRoots) routeOwned.add(name);
  const needed = new Set<string>();
  addClosure(needed, roots);
  const effects = new Set<t.Statement>();
  interface StatementFacts {
    readonly declaredNames: readonly string[];
    readonly references: Set<string>;
    readonly mutations: Set<string>;
    readonly authoredEffect: boolean;
  }
  const facts = new Map<t.Statement, StatementFacts>(
    ast.program.body.map((statement) => [
      statement,
      {
        declaredNames: Object.keys(t.getBindingIdentifiers(statement)),
        references: new Set<string>(),
        mutations: new Set<string>(),
        authoredEffect: effectfulDeclaration(statement, expressionPurity),
      },
    ]),
  );
  const containingStatement = (position: number | null | undefined): t.Statement | undefined => {
    if (position == null) return undefined;
    let low = 0;
    let high = ast.program.body.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const statement = ast.program.body[middle]!;
      if (position < statement.start!) high = middle - 1;
      else if (position >= statement.end!) low = middle + 1;
      else return statement;
    }
    return undefined;
  };
  for (const [name, binding] of Object.entries(scope.bindings)) {
    for (const reference of binding.referencePaths) {
      const statement = containingStatement(reference.node.start);
      if (statement) facts.get(statement)!.references.add(name);
    }
    for (const violation of binding.constantViolations) {
      const statement = containingStatement(violation.node.start);
      if (statement) facts.get(statement)!.mutations.add(name);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of ast.program.body) {
      if (t.isImportDeclaration(statement) || effects.has(statement)) continue;
      const { references, mutations, declaredNames, authoredEffect } = facts.get(statement)!;
      if (declaredNames.some((name) => routeRoots.has(name))) continue;
      const routeOwnedDeclaration =
        declaredNames.some((name) => routeOwned.has(name)) &&
        !declaredNames.some((name) => needed.has(name));
      if (routeOwnedDeclaration) continue;
      const required = setsIntersect(mutations, needed) || setsIntersect(references, needed);
      const authoredDeclarationEffect =
        authoredEffect && !declaredNames.some((name) => routeOwned.has(name));
      if (!required && !authoredDeclarationEffect) continue;
      effects.add(statement);
      addClosure(needed, references);
      addClosure(needed, mutations);
      addClosure(needed, declaredNames);
      changed = true;
    }
  }
  const body = ast.program.body.flatMap((statement): t.Statement[] => {
    if (t.isImportDeclaration(statement)) {
      if (
        statement.specifiers.length === 0 &&
        !/\.(?:css|less|sass|scss|styl|stylus)(?:$|\?)/i.test(statement.source.value)
      ) {
        return [t.cloneNode(statement, true)];
      }
      const specifiers = statement.specifiers.filter((specifier) =>
        needed.has(specifier.local.name),
      );
      if (!specifiers.length) return [];
      const projected = t.cloneNode(statement, true);
      projected.specifiers = specifiers.map((item) => t.cloneNode(item));
      return [projected];
    }
    if (t.isExportNamedDeclaration(statement) && !statement.declaration && !statement.source) {
      if (statement.exportKind === "type") return [];
      const specifiers = statement.specifiers.filter(
        (specifier) =>
          t.isExportSpecifier(specifier) &&
          t.isIdentifier(specifier.local) &&
          needed.has(specifier.local.name),
      );
      if (!specifiers.length) return [];
      const projected = t.cloneNode(statement, true);
      projected.specifiers = specifiers.map((item) => t.cloneNode(item));
      return [projected];
    }
    if (effects.has(statement)) return [t.cloneNode(statement, true)];
    const names = Object.keys(t.getBindingIdentifiers(statement));
    return names.some((name) => needed.has(name) && !routeRoots.has(name))
      ? [t.cloneNode(statement, true)]
      : [];
  });
  const localRoutes = routes.filter((route) => needed.has(route.localName));
  let handleName = "solRouteHandle";
  while (scope.bindings[handleName]) handleName = `_${handleName}`;
  const handles = localRoutes.map(
    (route) =>
      `const ${route.localName} = ${handleName}({ path: ${JSON.stringify(route.path)} }, ${JSON.stringify(route.compiled)});`,
  );
  const handleImport = localRoutes.length
    ? `import { routeHandle as ${handleName} } from "@soljs/sol/compiler-runtime";\n`
    : "";
  return `${handleImport}${handles.join("\n")}\n${generate(t.program(body)).code}`;
}

function endpointProjection(source: string, filename: string): string {
  return dependencyProjection(source, filename);
}

async function routeImportSource(
  importer: string,
  specifier: string,
  inspectRouteFile: (file: string) => Promise<InspectedRouteFile>,
  resolveImport?: (specifier: string, importer: string) => Promise<string | undefined>,
): Promise<InspectedRouteFile | undefined> {
  const base = resolve(dirname(importer), specifier);
  const resolved = await resolveImport?.(specifier, importer);
  const candidates = [
    ...(resolved ? [resolved] : []),
    base,
    ...[".tsx", ".ts", ".jsx", ".js"].map((suffix) => `${base}${suffix}`),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  const loaded = await Promise.all(
    candidates.filter(isRouteFile).map(async (target) => {
      try {
        return await inspectRouteFile(target);
      } catch {
        return undefined;
      }
    }),
  );
  return loaded.find((candidate) => candidate !== undefined);
}

async function projectRouteImports(
  input: Projection,
  importer: string,
  inspectRouteFile: (file: string) => Promise<InspectedRouteFile>,
  resolveImport?: (specifier: string, importer: string) => Promise<string | undefined>,
): Promise<Projection> {
  const { code: source } = input;
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const edits = new MagicString(source);
  const candidates = ast.program.body.flatMap((statement) => {
    if (
      (t.isImportDeclaration(statement) || t.isExportNamedDeclaration(statement)) &&
      statement.source &&
      statement.source.value !== "@soljs/sol" &&
      !/[?#]/.test(statement.source.value)
    ) {
      return [{ statement, specifier: statement.source.value }];
    }
    return [];
  });
  const projections = await Promise.all(
    candidates.map(async ({ statement, specifier }) => ({
      statement,
      resolved: await routeImportSource(importer, specifier, inspectRouteFile, resolveImport),
    })),
  );
  for (const projection of projections) {
    if (!projection.resolved) continue;
    const { statement, resolved } = projection;
    const routeNames = new Set(resolved.routes.flatMap((route) => route.exportNames));
    if (t.isExportNamedDeclaration(statement)) {
      if (statement.exportKind === "type") continue;
      const exportsRoute = statement.specifiers.some(
        (specifier) =>
          t.isExportNamespaceSpecifier(specifier) ||
          (t.isExportSpecifier(specifier) &&
            specifier.exportKind !== "type" &&
            (t.isIdentifier(specifier.local) || t.isStringLiteral(specifier.local)) &&
            routeNames.has(moduleExportName(specifier.local))),
      );
      if (exportsRoute) {
        throw new Error(
          `Automatic route splitting does not support route re-exports from ${statement.source!.value}; import and export the handle explicitly`,
        );
      }
      continue;
    }
    if (statement.importKind === "type") continue;
    if (statement.specifiers.some((specifier) => t.isImportNamespaceSpecifier(specifier))) {
      throw new Error(
        `Automatic route splitting does not support namespace route imports from ${statement.source.value}; use named imports`,
      );
    }
    const handles = statement.specifiers.filter(
      (specifier) =>
        (!t.isImportSpecifier(specifier) || specifier.importKind !== "type") &&
        ((t.isImportDefaultSpecifier(specifier) && routeNames.has("default")) ||
          (t.isImportSpecifier(specifier) &&
            (t.isIdentifier(specifier.imported) || t.isStringLiteral(specifier.imported)) &&
            routeNames.has(moduleExportName(specifier.imported)))),
    );
    if (!handles.length) continue;
    const ordinary = statement.specifiers.filter((specifier) => !handles.includes(specifier));
    const projected = t.importDeclaration(
      handles.map((specifier) => t.cloneNode(specifier)),
      t.stringLiteral(`${statement.source.value}?sol-route-handles`),
    );
    const imports = [projected];
    if (ordinary.length) {
      imports.push(
        t.importDeclaration(
          ordinary.map((specifier) => t.cloneNode(specifier)),
          t.cloneNode(statement.source),
        ),
      );
    }
    const original = source.slice(statement.start!, statement.end!);
    const replacement = imports.map((item) => generate(item).code).join(" ");
    const preservedLines = "\n".repeat(original.split("\n").length - 1);
    edits.overwrite(statement.start!, statement.end!, `${replacement}${preservedLines}`);
  }
  const code = edits.toString();
  if (code === source) return input;
  const map = edits.generateMap({ hires: true, source: importer, includeContent: true });
  return { code, map: input.map ? composeSourceMaps(map, input.map, importer) : map };
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
    if (
      !t.isImportDeclaration(statement) ||
      statement.importKind === "type" ||
      statement.source.value !== "@soljs/sol"
    )
      continue;
    for (const specifier of statement.specifiers) {
      if (t.isImportSpecifier(specifier) && specifier.importKind === "type") continue;
      if (t.isImportNamespaceSpecifier(specifier)) {
        namespaces.add(specifier.local.name);
        continue;
      }
      if (
        t.isImportSpecifier(specifier) &&
        helpers.has(moduleExportName(specifier.imported) as DeclarationHelper)
      ) {
        names.set(specifier.local.name, moduleExportName(specifier.imported) as DeclarationHelper);
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
    t.isIdentifier(callee.object) &&
    bindings.namespaces.has(callee.object.name)
  ) {
    const property =
      !callee.computed && t.isIdentifier(callee.property)
        ? callee.property.name
        : callee.computed && t.isStringLiteral(callee.property)
          ? callee.property.value
          : undefined;
    return property && ["$route", "$rpcQuery", "$rpcMutation", "$httpRoute"].includes(property)
      ? (property as DeclarationHelper)
      : undefined;
  }
  return undefined;
}

function manifestExportedNames(ast: t.File): Map<string, string[]> {
  const names = new Map<string, string[]>();
  const add = (local: string, exported: string): void => {
    const exports = names.get(local) ?? [];
    if (!exports.includes(exported)) exports.push(exported);
    names.set(local, exports);
  };
  for (const statement of ast.program.body) {
    if (t.isExportDefaultDeclaration(statement) && t.isIdentifier(statement.declaration)) {
      add(statement.declaration.name, "default");
      continue;
    }
    if (!t.isExportNamedDeclaration(statement) || statement.source) continue;
    if (statement.exportKind === "type") continue;
    if (statement.declaration) {
      for (const name of Object.keys(t.getBindingIdentifiers(statement.declaration)))
        add(name, name);
    }
    for (const specifier of statement.specifiers) {
      if (
        t.isExportSpecifier(specifier) &&
        specifier.exportKind !== "type" &&
        t.isIdentifier(specifier.local) &&
        (t.isIdentifier(specifier.exported) || t.isStringLiteral(specifier.exported))
      ) {
        add(specifier.local.name, moduleExportName(specifier.exported));
      }
    }
  }
  return names;
}

interface DeclaredRoute {
  readonly localName: string;
  readonly exportNames: readonly string[];
  readonly path: string;
  readonly compiled: ParsedRoutePath;
}

interface DeclarationAnalysis {
  readonly ast: t.File;
  readonly helpers: ReturnType<typeof declarationHelperBindings>;
  readonly exportedNames: Map<string, string[]>;
}

function declarationAnalysis(source: string, filename: string): DeclarationAnalysis {
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ["typescript", "jsx"],
  });
  return {
    ast,
    helpers: declarationHelperBindings(ast),
    exportedNames: manifestExportedNames(ast),
  };
}

function declaredRoutes(
  source: string,
  filename: string,
  analysis = declarationAnalysis(source, filename),
): DeclaredRoute[] {
  const { ast, helpers, exportedNames } = analysis;
  const routes: DeclaredRoute[] = [];
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
        routes.push({
          localName: variable.id.name,
          exportNames: exportedNames.get(variable.id.name) ?? [],
          path: path.value.value,
          compiled: compileRoutePath(path.value.value),
        });
      }
    }
  }
  return routes;
}

interface DeclaredEndpoint {
  readonly method: string;
  readonly path: string;
}

function declaredEndpoints(
  source: string,
  filename: string,
  analysis = declarationAnalysis(source, filename),
): DeclaredEndpoint[] {
  const { ast, helpers, exportedNames } = analysis;
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

function validateRouteCollisions(inspections: readonly InspectedRouteFile[]): void {
  const matchers = new Map<string, { file: string; path: string }>();
  for (const inspection of inspections) {
    for (const { path } of inspection.routes) {
      const matcher = path
        .split("?", 1)[0]!
        .split("/")
        .map((segment) => (segment.startsWith(":") ? ":" : canonicalizeStaticRouteSegment(segment)))
        .join("/");
      const existing = matchers.get(matcher);
      if (existing) {
        throw new Error(
          `Duplicate route matcher ${existing.path} in ${existing.file} and ${path} in ${inspection.file}`,
        );
      }
      matchers.set(matcher, { file: inspection.file, path });
    }
  }
  const endpointMatchers = new Map<string, { file: string; path: string }>();
  for (const inspection of inspections) {
    for (const endpoint of inspection.endpoints) {
      const matcher = `${endpoint.method} ${endpoint.path
        .split("/")
        .map((segment) => (segment.startsWith(":") ? ":" : segment))
        .join("/")}`;
      const existing = endpointMatchers.get(matcher);
      if (existing) {
        throw new Error(
          `Duplicate server endpoint ${endpoint.method} ${existing.path} in ${existing.file} and ${endpoint.path} in ${inspection.file}`,
        );
      }
      endpointMatchers.set(matcher, { file: inspection.file, path: endpoint.path });
    }
  }
}

export function sol(options: SolPluginOptions = {}): Plugin {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("sol() options must be an object");
  }
  if (options.devtools !== undefined && typeof options.devtools !== "boolean") {
    throw new TypeError("sol() devtools must be a boolean");
  }
  let config: ResolvedConfig;
  let devtoolsEnabled = false;
  let discoveredFiles: Promise<string[]> | undefined;
  const generationConsumers = new Set<string>();
  const routeFiles = (): Promise<string[]> =>
    (discoveredFiles ??= discoverRoutes(config.root).catch((error: unknown) => {
      discoveredFiles = undefined;
      throw error;
    }));
  const fileInspections = new Map<string, Promise<InspectedRouteFile>>();
  const inspectRouteFile = (file: string): Promise<InspectedRouteFile> => {
    let inspection = fileInspections.get(file);
    if (!inspection) {
      inspection = readFile(file, "utf8").then((source) => {
        const analysis = declarationAnalysis(source, file);
        return {
          file,
          routes: declaredRoutes(source, file, analysis),
          endpoints: declaredEndpoints(source, file, analysis),
        };
      });
      void inspection.catch(() => {
        if (fileInspections.get(file) === inspection) fileInspections.delete(file);
      });
      fileInspections.set(file, inspection);
    }
    return inspection;
  };
  const invalidateManifest = (server: ViteDevServer, file: string): void => {
    if (!isRouteFile(file)) return;
    discoveredFiles = undefined;
    generationConsumers.clear();
    fileInspections.delete(file);
    if (relative(config.root, file).startsWith("..")) return;
    for (const id of [resolvedVirtualRoutes, resolvedVirtualEndpoints]) {
      const module = server.moduleGraph.getModuleById(id);
      if (module) server.moduleGraph.invalidateModule(module);
    }
    server.ws.send({ type: "full-reload" });
  };

  return {
    name: "sol",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
      discoveredFiles = undefined;
      generationConsumers.clear();
      fileInspections.clear();
      devtoolsEnabled = options.devtools ?? resolved.command === "serve";
    },
    transformIndexHtml: {
      order: "pre",
      handler() {
        const attrs: HtmlTagDescriptor["attrs"] = {
          type: "module",
          src: config.command === "serve" ? `/@id/${routerPackageEntry}` : routerBuildEntry,
          "data-sol-router": "",
        };
        if (devtoolsEnabled) attrs["data-sol-devtools"] = "";
        return [{ tag: "script", attrs, injectTo: "head-prepend" }];
      },
    },
    resolveId(id) {
      if (id === virtualRoutes) return resolvedVirtualRoutes;
      if (id === virtualEndpoints) return resolvedVirtualEndpoints;
      if (id === routerPackageEntry || id === routerBuildEntry) return resolvedRouterBuildEntry;
      return null;
    },
    async load(id) {
      if (id === resolvedRouterBuildEntry) {
        const devtools = devtoolsEnabled
          ? `import { installDevtools } from ${JSON.stringify(devtoolsPackageEntry)};\ninstallDevtools();\n`
          : "";
        return `import routes from ${JSON.stringify(virtualRoutes)};\nimport { configureRouterRoutes } from "@soljs/sol";\n${devtools}await configureRouterRoutes(routes);`;
      }
      if (id !== resolvedVirtualRoutes && id !== resolvedVirtualEndpoints) return null;
      if (generationConsumers.has(id)) {
        discoveredFiles = undefined;
        fileInspections.clear();
        generationConsumers.clear();
      }
      const files = await routeFiles();
      const inspections = await Promise.all(files.map(inspectRouteFile));
      generationConsumers.add(id);
      validateRouteCollisions(inspections);
      return id === resolvedVirtualRoutes
        ? routeManifest(inspections, config.root)
        : endpointManifest(inspections);
    },
    configureServer(server) {
      const changed = (file: string): void => invalidateManifest(server, file);
      server.watcher.on("add", changed);
      server.watcher.on("change", changed);
      server.watcher.on("unlink", changed);
    },
    transform: {
      filter: { id: [moduleFile] },
      async handler(source, id, transformOptions) {
        if (!moduleFile.test(id) || id.includes("/node_modules/")) {
          return null;
        }
        const filename = id.split("?", 1)[0]!;
        const resolveImport = async (
          specifier: string,
          importer: string,
        ): Promise<string | undefined> => {
          const resolved = await this.resolve(specifier, importer, { skipSelf: true });
          return resolved?.id.split("?", 1)[0];
        };
        if (id.includes("?sol-route-handles")) {
          const handles = replacementProjection(
            source,
            routeHandleProjection(source, filename),
            filename,
          );
          return await projectRouteImports(handles, filename, inspectRouteFile, resolveImport);
        }
        const projection = id.includes("?sol-endpoints")
          ? replacementProjection(source, endpointProjection(source, filename), filename)
          : { code: source };
        const projected = await projectRouteImports(
          projection,
          filename,
          inspectRouteFile,
          resolveImport,
        );
        if (!componentFile.test(id) && !solFile.test(id)) {
          return projected.code === source ? null : projected;
        }
        const compiled = compile(projected.code, filename, {
          target: transformOptions?.ssr ? "server" : "client",
          routeMode: "page",
        });
        const compiledSourceContent = compiled.map
          ? sourceMapJson(compiled.map).sourcesContent?.[0]
          : undefined;
        if (!compiled.map) return projected.map ? projected : null;
        if (!projected.map) return compiled;
        return {
          code: compiled.code,
          map: composeSourceMaps(
            compiled.map,
            projected.map,
            filename,
            compiledSourceContent === projected.code ? undefined : compiledSourceContent,
          ),
        };
      },
    },
  };
}
