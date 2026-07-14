import { expect, test } from "bun:test";

test("the example build keeps compiler output readable", async () => {
  const assets = new Bun.Glob("*.js");
  const outputFiles = [...assets.scanSync("dist/assets")];
  expect(outputFiles.length).toBeGreaterThan(0);

  const output = (
    await Promise.all(outputFiles.map((file) => Bun.file(`dist/assets/${file}`).text()))
  ).join("\n");
  expect(output).toContain("__solix_template");
  expect(output).toContain("//#region src/App.tsx");
  expect(output).toContain('path: "/blog/new"');
  expect(output).toContain('path: "/blog/:id?from=:from"');
  expect(output).toContain("function matchRoute(pathname, searchParams)");
  expect(output).toContain("function cleanupEffect(effect)");
  expect(output).toContain("function queryEntry(key)");
  expect(output).toContain("function requestSource(config, source)");
  expect(output).toContain("$query(requestSource({");
  expect(output).toContain("$mutation(requestSource(");
  expect(output).toContain("function runTransitions(");
  expect(output).toContain("element.getAnimations(");
  expect(output).not.toContain("solix_get_diagnostics");
  expect(output).not.toContain("solix-devtools");
});
