import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Manifest = Record<string, unknown> & {
  name?: unknown;
  version?: unknown;
  exports?: unknown;
  bin?: unknown;
};

function outputPath(source: unknown, extension: ".js" | ".d.ts"): string {
  if (typeof source !== "string" || !source.startsWith("./src/") || !source.endsWith(".ts")) {
    throw new TypeError("Package entry points must be TypeScript files under src");
  }
  return `./${source.slice("./src/".length, -".ts".length)}${extension}`;
}

function outputExports(value: unknown): Record<string, { types: string; import: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Package exports must be an object");
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, source]) => [
      name,
      { types: outputPath(source, ".d.ts"), import: outputPath(source, ".js") },
    ]),
  );
}

function outputBin(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Package bin must be an object");
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, source]) => [name, outputPath(source, ".js").slice(2)]),
  );
}

const packageDirectory = resolve(Bun.argv[2] ?? "");
const manifest: unknown = JSON.parse(
  await readFile(resolve(packageDirectory, "package.json"), "utf8"),
);
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
  throw new TypeError("Package manifest must be an object");
}
const source = manifest as Manifest;
if (typeof source.name !== "string" || !source.name.startsWith("@soljs/")) {
  throw new TypeError("Only @soljs packages can be built for publication");
}
if (typeof source.version !== "string") throw new TypeError("Package version must be a string");

const output: Manifest = { ...source };
output.main = "./index.js";
output.module = "./index.js";
output.types = "./index.d.ts";
output.exports = outputExports(source.exports);
output.bin = outputBin(source.bin);
output.scripts = { prepublishOnly: "bun run --cwd .. build" };
delete output.devDependencies;

const outputDirectory = resolve(packageDirectory, "dist");
await Promise.all([
  writeFile(
    resolve(outputDirectory, "package.json"),
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  ),
  copyFile(resolve(packageDirectory, "README.md"), resolve(outputDirectory, "README.md")),
]);
