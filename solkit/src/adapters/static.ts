import { access, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { RequestHandler, SolkitAdapter, SolkitAdapterContext, StaticPaths } from "../types.ts";

interface StaticApplication {
  readonly handle?: RequestHandler;
  readonly staticPaths?: StaticPaths;
}

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

function validateStaticPaths(value: unknown): asserts value is StaticPaths {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Static application entry must export a non-empty staticPaths array");
  }
  const unique = new Set<string>();
  for (const path of value) {
    validateStaticPath(path);
    if (unique.has(path)) throw new TypeError(`Duplicate static path ${path}`);
    unique.add(path);
  }
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
  validateStaticPaths(application.staticPaths);

  const rendered: Array<{ path: string; html: string; file: string }> = [];
  for (const path of application.staticPaths) {
    // oxlint-disable-next-line no-await-in-loop -- the runtime render context is process-global
    const response = await application.handle(
      new Request(new URL(path, "https://sol.static"), {
        headers: { accept: "text/html" },
      }),
      { template },
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
      await mkdir(dirname(page.file), { recursive: true });
      await writeFile(page.file, page.html, "utf8");
    }),
  );
  await rm(context.serverDirectory, { recursive: true });
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
