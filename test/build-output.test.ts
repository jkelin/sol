import { expect, test } from "bun:test";

test("the demo build keeps compiler output readable", async () => {
  const assets = new Bun.Glob("*.js");
  const outputFiles = [...assets.scanSync("dist/assets")];
  expect(outputFiles.length).toBeGreaterThan(0);

  const output = (
    await Promise.all(outputFiles.map((file) => Bun.file(`dist/assets/${file}`).text()))
  ).join("\n");
  expect(output).toContain("__ff_template");
  expect(output).toContain("//#region demo/src/App.tsx");
  expect(output).toContain('path: "/blog/new"');
  expect(output).toContain('path: "/blog/:id"');
  expect(output).toContain("function matchRoute(pathname)");
  expect(output).toContain("function cleanupEffect(effect)");
});
