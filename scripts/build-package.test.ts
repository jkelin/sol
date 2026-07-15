import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

type OutputManifest = {
  sideEffects?: unknown;
  exports?: unknown;
};

const workspace = resolve(import.meta.dir, "..");
const packages = ["runtime", "compiler", "solkit"] as const;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "sol-package-build-"));

afterAll(() => rm(temporaryDirectory, { recursive: true, force: true }));

describe("publishable package bundles", () => {
  for (const packageName of packages) {
    test(`${packageName} emits one JavaScript file and one declaration file`, async () => {
      const outputDirectory = resolve(workspace, packageName, "dist");
      const files = (await readdir(outputDirectory, { recursive: true }))
        .filter((file) => file.endsWith(".js") || file.endsWith(".d.ts"))
        .toSorted();
      expect(files).toEqual(["index.d.ts", "index.js"]);

      const manifest = JSON.parse(
        await readFile(resolve(outputDirectory, "package.json"), "utf8"),
      ) as OutputManifest;
      expect(manifest.sideEffects).toBe(false);
      expect(manifest.exports).toBeObject();
      for (const target of Object.values(manifest.exports as Record<string, unknown>)) {
        expect(target).toEqual({ types: "./index.d.ts", import: "./index.js" });
      }
      if (packageName === "solkit") {
        expect(await readFile(resolve(outputDirectory, "index.js"), "utf8")).toStartWith(
          "#!/usr/bin/env node\n",
        );
      }
    });
  }

  test("the rolled-up declarations type every published subpath", async () => {
    const entry = resolve(temporaryDirectory, "consumer.ts");
    await writeFile(
      entry,
      `import { $component } from "@soljs/sol";
import { template } from "@soljs/sol/compiler-runtime";
import { installDevtools } from "@soljs/sol/devtools";
import { Fragment, type JSX } from "@soljs/sol/jsx-runtime";
import { jsxDEV } from "@soljs/sol/jsx-dev-runtime";
import { compareRouteSpecificity } from "@soljs/sol/route-descriptors";
import { compile } from "@soljs/compiler";
import { sol } from "@soljs/compiler/vite";
import { createRequestHandler } from "@soljs/solkit";
import { solkit } from "@soljs/solkit/vite";
import { bunAdapter } from "@soljs/solkit/adapters/bun";
import { nodeAdapter } from "@soljs/solkit/adapters/node";
import { staticAdapter } from "@soljs/solkit/adapters/static";
void [$component, template, installDevtools, Fragment, jsxDEV, compareRouteSpecificity, compile, sol, createRequestHandler, solkit, bunAdapter, nodeAdapter, staticAdapter];
type Element = JSX.Element;
declare const element: Element;
void element;
`,
      "utf8",
    );
    const path = (packageName: string): string[] => [
      resolve(workspace, packageName, "dist/index.d.ts"),
    ];
    const program = ts.createProgram({
      rootNames: [entry],
      options: {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.Preserve,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        baseUrl: workspace,
        types: [],
        skipLibCheck: true,
        paths: {
          "@soljs/sol": path("runtime"),
          "@soljs/sol/*": path("runtime"),
          "@soljs/compiler": path("compiler"),
          "@soljs/compiler/*": path("compiler"),
          "@soljs/solkit": path("solkit"),
          "@soljs/solkit/*": path("solkit"),
        },
      },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
    ).toEqual([]);
  });

  test("the JavaScript and declaration bundles are formatted", async () => {
    const outputs = packages.flatMap((packageName) => [
      resolve(workspace, packageName, "dist/index.js"),
      resolve(workspace, packageName, "dist/index.d.ts"),
    ]);
    const formatter = Bun.spawn([process.execPath, "x", "oxfmt", "--check", ...outputs], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      formatter.exited,
      new Response(formatter.stdout).text(),
      new Response(formatter.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: expect.stringContaining("All matched files use the correct format."),
      stderr: "",
    });
  });

  test("the packages import and the Solkit executable runs from an installed layout", async () => {
    const consumer = resolve(temporaryDirectory, "consumer");
    const modules = resolve(consumer, "node_modules");
    await Promise.all(
      packages.map((packageName) =>
        cp(
          resolve(workspace, packageName, "dist"),
          resolve(modules, "@soljs", packageName === "runtime" ? "sol" : packageName),
          { recursive: true },
        ),
      ),
    );
    await Promise.all(
      [
        "vite",
        "magic-string",
        "source-map-js",
        "@babel/generator",
        "@babel/parser",
        "@babel/traverse",
        "@babel/types",
      ].map(async (dependency) => {
        const destination = resolve(modules, dependency);
        await mkdir(dirname(destination), { recursive: true });
        await symlink(resolve(workspace, "node_modules", dependency), destination, "junction");
      }),
    );

    const entry = resolve(consumer, "index.ts");
    await writeFile(
      entry,
      `import { $signal } from "@soljs/sol";
import { template } from "@soljs/sol/compiler-runtime";
import { compile } from "@soljs/compiler";
import { sol } from "@soljs/compiler/vite";
import { createRequestHandler } from "@soljs/solkit";
import { solkit } from "@soljs/solkit/vite";
import { bunAdapter } from "@soljs/solkit/adapters/bun";
if ([$signal, template, compile, sol, createRequestHandler, solkit, bunAdapter].some(value => typeof value !== "function")) throw new Error("Package export is missing");
`,
      "utf8",
    );
    const imported = Bun.spawn([process.execPath, entry], {
      cwd: consumer,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [importExitCode, importError] = await Promise.all([
      imported.exited,
      new Response(imported.stderr).text(),
    ]);
    expect({ exitCode: importExitCode, error: importError }).toEqual({ exitCode: 0, error: "" });

    const executable = Bun.spawn([process.execPath, resolve(modules, "@soljs/solkit/index.js")], {
      cwd: consumer,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await executable.exited).toBe(1);
    expect(await new Response(executable.stderr).text()).toContain("Usage: solkit build");
  });

  for (const [packageName, imported, excluded] of [
    ["runtime", "$signal", "Open Sol devtools"],
    ["compiler", "compile", "sol() options must be an object"],
    ["solkit", "createRequestHandler", "solkit() options must be an object"],
  ] as const) {
    test(`${packageName} lets consumers remove unused exports`, async () => {
      const entry = resolve(temporaryDirectory, `${packageName}.ts`);
      const bundleUrl = pathToFileURL(resolve(workspace, packageName, "dist/index.js")).href;
      await writeFile(
        entry,
        `import { ${imported} } from ${JSON.stringify(bundleUrl)};\nconsole.log(${imported});\n`,
        "utf8",
      );
      const result = await Bun.build({
        entrypoints: [entry],
        target: packageName === "runtime" ? "browser" : "node",
        format: "esm",
        packages: "external",
      });
      expect(result.success).toBe(true);
      expect(result.outputs).toHaveLength(1);
      expect(await result.outputs[0]!.text()).not.toContain(excluded);
    });
  }
});
