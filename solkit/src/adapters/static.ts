import { access, mkdir, readFile, rm, rmdir, writeFile as writeFileToDisk } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { RequestHandler, SolkitAdapter, SolkitAdapterContext, StaticPaths } from "../types.ts";

interface StaticApplication {
  readonly handle?: RequestHandler;
  readonly staticPaths?: StaticPaths;
  readonly staticRoutePaths?: StaticPaths;
  readonly staticRoutes?: readonly StaticRoute[];
}

interface StaticRoute {
  readonly path: string;
  readonly compiled: {
    readonly pattern: string;
    readonly specificity: readonly number[];
  };
  readonly assetKey: string;
}

interface ClientManifestChunk {
  readonly file: string;
  readonly src?: string;
  readonly css?: readonly string[];
  readonly imports?: readonly string[];
}

type ClientManifest = Readonly<Record<string, ClientManifestChunk>>;

export interface StaticAdapter extends SolkitAdapter {
  readonly static: true;
  write(context: SolkitAdapterContext): Promise<void>;
}

function validateContext(context: unknown): asserts context is SolkitAdapterContext {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new TypeError("Static adapter context must be an object");
  }
  const candidate = context as Partial<SolkitAdapterContext>;
  if (typeof candidate.serverDirectory !== "string" || !candidate.serverDirectory) {
    throw new TypeError("Static adapter serverDirectory must be a non-empty string");
  }
  if (typeof candidate.clientDirectory !== "string" || !candidate.clientDirectory) {
    throw new TypeError("Static adapter clientDirectory must be a non-empty string");
  }
  if (candidate.writeFile !== undefined && typeof candidate.writeFile !== "function") {
    throw new TypeError("Static adapter writeFile must be a function");
  }
}

function validateStaticPath(path: unknown): asserts path is string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /%2f|%5c/i.test(path) ||
    path.includes("?") ||
    path.includes("#") ||
    (path !== "/" && path.endsWith("/"))
  ) {
    throw new TypeError(
      `Static path ${JSON.stringify(path)} must be a canonical root-relative pathname`,
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new TypeError(`Static path ${JSON.stringify(path)} contains invalid URL encoding`);
  }
  if (
    decoded.includes("\\") ||
    (path !== "/" &&
      path
        .slice(1)
        .split("/")
        .some((segment) => !segment)) ||
    decoded.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(
      `Static path ${JSON.stringify(path)} must not contain separators or dot segments`,
    );
  }
  if (new URL(path, "https://sol.invalid").pathname !== path) {
    throw new TypeError(`Static path ${JSON.stringify(path)} must already be URL-canonical`);
  }
}

function validateStaticPaths(value: unknown, name: string): asserts value is StaticPaths {
  if (!Array.isArray(value)) {
    throw new TypeError(`Static application ${name} must be an array`);
  }
  const unique = new Set<string>();
  for (const path of value) {
    validateStaticPath(path);
    if (unique.has(path)) throw new TypeError(`Duplicate ${name} path ${path}`);
    unique.add(path);
  }
}

function validateStaticRoutes(value: unknown): asserts value is readonly StaticRoute[] {
  if (!Array.isArray(value))
    throw new TypeError("Static application staticRoutes must be an array");
  for (const route of value) {
    if (
      !route ||
      typeof route !== "object" ||
      Array.isArray(route) ||
      typeof (route as Partial<StaticRoute>).path !== "string" ||
      !(route as Partial<StaticRoute>).path?.startsWith("/") ||
      typeof (route as Partial<StaticRoute>).assetKey !== "string" ||
      !(route as Partial<StaticRoute>).assetKey ||
      !(route as Partial<StaticRoute>).compiled ||
      typeof (route as Partial<StaticRoute>).compiled?.pattern !== "string" ||
      !Array.isArray((route as Partial<StaticRoute>).compiled?.specificity) ||
      (route as Partial<StaticRoute>).compiled?.specificity.some(
        (part) => typeof part !== "number" || !Number.isFinite(part),
      )
    ) {
      throw new TypeError("Static application contains invalid static route metadata");
    }
    try {
      RegExp((route as StaticRoute).compiled.pattern);
    } catch {
      throw new TypeError("Static application contains an invalid route pattern");
    }
  }
}

function validateClientManifest(value: unknown): asserts value is ClientManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Static client manifest must be an object");
  }
  for (const chunk of Object.values(value)) {
    if (
      !chunk ||
      typeof chunk !== "object" ||
      Array.isArray(chunk) ||
      typeof (chunk as Partial<ClientManifestChunk>).file !== "string" ||
      !(chunk as Partial<ClientManifestChunk>).file ||
      ((chunk as Partial<ClientManifestChunk>).src !== undefined &&
        typeof (chunk as Partial<ClientManifestChunk>).src !== "string") ||
      !validStringArray((chunk as Partial<ClientManifestChunk>).css) ||
      !validStringArray((chunk as Partial<ClientManifestChunk>).imports)
    ) {
      throw new TypeError("Static client manifest contains an invalid chunk");
    }
  }
}

function validStringArray(value: unknown): value is readonly string[] | undefined {
  return (
    value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function compareStaticRoutes(left: StaticRoute, right: StaticRoute): number {
  const length = Math.max(left.compiled.specificity.length, right.compiled.specificity.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (right.compiled.specificity[index] ?? -1) - (left.compiled.specificity[index] ?? -1);
    if (difference) return difference;
  }
  return left.path.localeCompare(right.path);
}

function routeAssetLinks(
  template: string,
  path: string,
  routes: readonly StaticRoute[],
  manifest: ClientManifest,
): string {
  const route = routes
    .toSorted(compareStaticRoutes)
    .find((candidate) => new RegExp(candidate.compiled.pattern).test(path));
  if (!route) return "";
  const manifestEntry = Object.entries(manifest).find(
    ([key, chunk]) => key === route.assetKey || chunk.src === route.assetKey,
  );
  if (!manifestEntry) {
    throw new Error(`Static route ${route.path} has no client asset manifest entry`);
  }
  const files = new Set<string>();
  const styles = new Set<string>();
  const visit = ([key, chunk]: [string, ClientManifestChunk]): void => {
    if (files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const css of chunk.css ?? []) styles.add(css);
    for (const imported of chunk.imports ?? []) {
      const dependency = manifest[imported];
      if (!dependency) throw new Error(`Static client manifest import ${imported} is missing`);
      visit([key, dependency]);
    }
  };
  visit(manifestEntry);
  const prefix = /<script[^>]+src="([^"]*?)(?:assets\/)[^"]+"/.exec(template)?.[1] ?? "/";
  const href = (file: string): string =>
    `${prefix}${file}`.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return [
    ...[...styles].map((file) => `<link rel="stylesheet" crossorigin href="${href(file)}">`),
    ...[...files].map((file) => `<link rel="modulepreload" crossorigin href="${href(file)}">`),
  ].join("\n");
}

function outputFile(clientDirectory: string, path: string): string {
  return path === "/"
    ? join(clientDirectory, "index.html")
    : join(clientDirectory, ...path.slice(1).split("/"), "index.html");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function writeStaticSite(context: SolkitAdapterContext): Promise<void> {
  validateContext(context);
  const templateFile = join(context.clientDirectory, "index.html");
  const manifestFile = join(context.clientDirectory, ".solkit", "manifest.json");
  const template = await readFile(templateFile, "utf8").catch((error: unknown) => {
    throw new Error(`Static adapter could not read the built client template at ${templateFile}`, {
      cause: error,
    });
  });
  const application = (await import(
    `${pathToFileURL(join(context.serverDirectory, "app.mjs")).href}?static=${Date.now()}`
  )) as StaticApplication;
  if (typeof application.handle !== "function") {
    throw new TypeError("Static server bundle must export a request handler");
  }
  validateStaticPaths(application.staticRoutePaths ?? [], "staticRoutePaths");
  if (application.staticPaths !== undefined)
    validateStaticPaths(application.staticPaths, "staticPaths");
  validateStaticRoutes(application.staticRoutes ?? []);
  const manifestValue: unknown =
    (application.staticRoutes?.length ?? 0) > 0
      ? JSON.parse(await readFile(manifestFile, "utf8"))
      : {};
  validateClientManifest(manifestValue);
  const staticPaths = [
    ...new Set([...(application.staticRoutePaths ?? []), ...(application.staticPaths ?? [])]),
  ];
  if (staticPaths.length === 0) {
    throw new TypeError("Static application must declare or infer at least one path");
  }

  const rendered: Array<{ path: string; html: string; file: string }> = [];
  for (const path of staticPaths) {
    const links = routeAssetLinks(template, path, application.staticRoutes ?? [], manifestValue);
    const pageTemplate = links
      ? template.replace("<!--solkit-head-->", `${links}\n<!--solkit-head-->`)
      : template;
    // oxlint-disable-next-line no-await-in-loop -- the runtime render context is process-global
    const response = await application.handle(
      new Request(new URL(path, "https://sol.static"), {
        headers: { accept: "text/html" },
      }),
      { template: pageTemplate },
    );
    if (!(response instanceof Response)) {
      throw new TypeError(`Static render for ${path} did not return a Response`);
    }
    if (!response.ok) throw new Error(`Static render for ${path} returned ${response.status}`);
    if (!response.headers.get("content-type")?.includes("text/html")) {
      throw new TypeError(`Static render for ${path} did not return HTML`);
    }
    rendered.push({
      path,
      // oxlint-disable-next-line no-await-in-loop -- each response must finish before the next render
      html: await response.text(),
      file: outputFile(context.clientDirectory, path),
    });
  }

  await Promise.all(
    rendered.map(async (page) => {
      if (page.path !== "/" && (await exists(page.file))) {
        throw new Error(`Static path ${page.path} would overwrite ${page.file}`);
      }
    }),
  );
  await Promise.all(
    rendered.map(async (page) => {
      if (context.writeFile) await context.writeFile(page.file, page.html);
      else {
        await mkdir(dirname(page.file), { recursive: true });
        await writeFileToDisk(page.file, page.html, "utf8");
      }
    }),
  );
  await rm(context.serverDirectory, { recursive: true });
  await rm(manifestFile, { force: true });
  await rmdir(dirname(context.serverDirectory)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  });
}

export function staticAdapter(): StaticAdapter {
  if (arguments.length !== 0) throw new TypeError("staticAdapter() does not accept options");
  return Object.freeze({
    name: "static",
    static: true,
    write: writeStaticSite,
  });
}
