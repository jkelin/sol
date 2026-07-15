import { expect, test } from "bun:test";

test("the example build keeps compiler output readable", async () => {
  const assets = new Bun.Glob("*.js");
  const outputFiles = [...assets.scanSync("dist/client/assets")];
  expect(outputFiles.length).toBeGreaterThan(0);
  expect(outputFiles.some((file) => file.startsWith("todo.sol-"))).toBe(true);
  expect(outputFiles.some((file) => file.startsWith("queries.sol-"))).toBe(true);

  const output = (
    await Promise.all(outputFiles.map((file) => Bun.file(`dist/client/assets/${file}`).text()))
  ).join("\n");
  const clientArtifacts = (
    await Promise.all(
      [...new Bun.Glob("*").scanSync("dist/client/assets")]
        .filter((file) => file.endsWith(".js") || file.endsWith(".js.map"))
        .map((file) => Bun.file(`dist/client/assets/${file}`).text()),
    )
  ).join("\n");
  expect(output).toContain("__sol_template");
  expect(output).toContain("//#region src/App.tsx");
  expect(output).toContain('path: "/blog/new"');
  expect(output).toContain('path: "/blog/:id?from=:from"');
  expect(output).toContain("function matchRoute(pathname, searchParams)");
  expect(output).toContain("function cleanupEffect(effect)");
  expect(output).toContain("function queryEntry(key, frame)");
  expect(output).toContain("function requestSource(config, source)");
  expect(output).toContain("queryInFrame(requestSource({");
  expect(output).toContain("mutationInFrame(requestSource(");
  expect(output).toContain('rpcQueryClient("notes")');
  expect(output).toContain('rpcMutationClient("create-note")');
  expect(clientArtifacts).not.toContain("Invalid note id");
  expect(clientArtifacts).not.toContain("Cache one request across observers");
  expect(clientArtifacts).not.toContain("notes-backend");
  expect(clientArtifacts).not.toContain("notesPageSchema");
  expect(clientArtifacts).not.toContain("noteTitleSchema");
  expect(clientArtifacts).not.toContain("noteHttpSchema");
  expect(clientArtifacts).not.toContain("verifyNotesBackendSecret");
  expect(clientArtifacts).not.toContain("SOL_BACKEND_SCHEMA_VALIDATOR_DO_NOT_SHIP");
  expect(clientArtifacts).not.toContain("SOL_BACKEND_SECRET_DO_NOT_SHIP");
  expect(output).toContain("function runTransitions(");
  expect(output).toContain("element.getAnimations(");
  expect(output).not.toContain("sol_get_diagnostics");
  expect(output).not.toContain("sol-devtools");
  expect(await Bun.file("dist/server/app.mjs").exists()).toBe(true);
  expect(await Bun.file("dist/server/index.mjs").exists()).toBe(true);
  const serverOutput = await Bun.file("dist/server/app.mjs").text();
  expect(serverOutput).toContain("notes-backend");
  const serverArtifacts = (
    await Promise.all(
      [...new Bun.Glob("**/*").scanSync("dist/server")]
        .filter((file) => file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".map"))
        .map((file) => Bun.file(`dist/server/${file}`).text()),
    )
  ).join("\n");
  const serverFiles = [...new Bun.Glob("assets/*.js").scanSync("dist/server")];
  expect(serverFiles.some((file) => file.includes("todo.sol-"))).toBe(true);
  expect(serverFiles.some((file) => file.includes("queries.sol-"))).toBe(true);
  expect(serverArtifacts).toContain("SOL_BACKEND_SCHEMA_VALIDATOR_DO_NOT_SHIP");
  expect(serverArtifacts).toContain("SOL_BACKEND_SECRET_DO_NOT_SHIP");
});
