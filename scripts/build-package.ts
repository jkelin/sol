import { Extractor, ExtractorConfig, ExtractorLogLevel } from "@microsoft/api-extractor";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Manifest = Record<string, unknown> & {
  name?: unknown;
  version?: unknown;
  exports?: unknown;
  bin?: unknown;
};

function entrySources(value: unknown, field: "exports" | "bin"): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Package ${field} must be an object`);
  }
  return Object.values(value).map((source) => {
    if (typeof source !== "string" || !source.startsWith("./src/") || !source.endsWith(".ts")) {
      throw new TypeError(`Package ${field} entry points must be TypeScript files under src`);
    }
    return source;
  });
}

function outputExports(value: unknown): Record<string, { types: string; import: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Package exports must be an object");
  }
  return Object.fromEntries(
    Object.keys(value).map((name) => [name, { types: "./index.d.ts", import: "./index.js" }]),
  );
}

function outputBin(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  entrySources(value, "bin");
  return Object.fromEntries(Object.keys(value as object).map((name) => [name, "index.js"]));
}

const packageDirectory = resolve(Bun.argv[2] ?? "");
const packageJsonPath = resolve(packageDirectory, "package.json");
const manifest: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
  throw new TypeError("Package manifest must be an object");
}
const source = manifest as Manifest;
if (typeof source.name !== "string" || !source.name.startsWith("@soljs/")) {
  throw new TypeError("Only @soljs packages can be built for publication");
}
if (typeof source.version !== "string") throw new TypeError("Package version must be a string");

const exports = [...new Set(entrySources(source.exports, "exports"))];
const bins = source.bin === undefined ? [] : [...new Set(entrySources(source.bin, "bin"))];
const stagingDirectory = resolve(packageDirectory, ".build");
const declarationDirectory = resolve(stagingDirectory, "types");
const outputDirectory = resolve(packageDirectory, "dist");
const javascriptEntry = resolve(stagingDirectory, "package-entry.ts");
const declarationEntry = resolve(declarationDirectory, "package-entry.d.ts");

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(
    javascriptEntry,
    `${exports.map((entry) => `export * from ${JSON.stringify(`../${entry.slice(2)}`)};`).join("\n")}\n${bins.map((entry) => `import ${JSON.stringify(`../${entry.slice(2)}`)};`).join("\n")}\n`,
    "utf8",
  ),
  writeFile(
    declarationEntry,
    `${exports
      .map(
        (entry) => `export * from ${JSON.stringify(`./${entry.slice("./src/".length, -3)}.js`)};`,
      )
      .join("\n")}\n`,
    "utf8",
  ),
]);

try {
  const bundle = await Bun.build({
    entrypoints: [javascriptEntry],
    outdir: outputDirectory,
    naming: "index.js",
    target: source.name === "@soljs/sol" ? "browser" : "node",
    format: "esm",
    packages: "external",
    splitting: false,
    sourcemap: "none",
    env: "disable",
  });
  if (!bundle.success) {
    throw new AggregateError(bundle.logs, `Failed to bundle ${source.name}`);
  }

  const extractorConfig = ExtractorConfig.prepare({
    configObjectFullPath: undefined,
    configObject: {
      projectFolder: packageDirectory,
      mainEntryPointFilePath: declarationEntry,
      apiReport: { enabled: false },
      docModel: { enabled: false },
      dtsRollup: {
        enabled: true,
        untrimmedFilePath: resolve(outputDirectory, "index.d.ts"),
      },
      tsdocMetadata: { enabled: false },
      compiler: { tsconfigFilePath: resolve(packageDirectory, "tsconfig.build.json") },
      messages: {
        compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
        extractorMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
        tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
      },
    },
    packageJsonFullPath: packageJsonPath,
  });
  const extraction = Extractor.invoke(extractorConfig, {
    localBuild: true,
    showVerboseMessages: false,
    messageCallback(message) {
      message.handled = true;
    },
  });
  if (!extraction.succeeded) {
    throw new Error(
      `Failed to roll up ${source.name} declarations with ${extraction.errorCount} errors`,
    );
  }

  const javascriptOutput = resolve(outputDirectory, "index.js");
  const declarationOutput = resolve(outputDirectory, "index.d.ts");
  if (source.bin !== undefined) {
    await writeFile(
      javascriptOutput,
      `#!/usr/bin/env node\n${await readFile(javascriptOutput, "utf8")}`,
      "utf8",
    );
  }

  const formatter = Bun.spawn(
    [process.execPath, "x", "oxfmt", "--write", javascriptOutput, declarationOutput],
    {
      cwd: resolve(packageDirectory, ".."),
      stdout: "inherit",
      stderr: "pipe",
    },
  );
  const [formatterExitCode, formatterError] = await Promise.all([
    formatter.exited,
    new Response(formatter.stderr).text(),
  ]);
  if (formatterExitCode !== 0) {
    throw new Error(`Failed to format ${source.name} build output:\n${formatterError}`);
  }

  const output: Manifest = { ...source };
  output.main = "./index.js";
  output.module = "./index.js";
  output.types = "./index.d.ts";
  output.sideEffects = false;
  output.exports = outputExports(source.exports);
  output.bin = outputBin(source.bin);
  output.scripts = { prepublishOnly: "bun run --cwd .. build" };
  delete output.devDependencies;

  await Promise.all([
    writeFile(
      resolve(outputDirectory, "package.json"),
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8",
    ),
    copyFile(resolve(packageDirectory, "README.md"), resolve(outputDirectory, "README.md")),
  ]);
  if (source.bin !== undefined) await chmod(javascriptOutput, 0o755);
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
