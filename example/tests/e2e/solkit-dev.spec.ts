// oxlint-disable eslint/no-underscore-dangle -- __sol is the documented development global.
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { availablePort } from "./available-port.ts";

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  const port = await availablePort();
  server = await createServer({
    configFile: "vite.config.ts",
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  const localUrl = server.resolvedUrls?.local[0];
  if (!localUrl) throw new Error("Vite did not expose a local development URL");
  origin = localUrl.replace(/\/$/, "");
});

test.afterAll(async () => {
  await server.close();
});

test("Vite development middleware renders and hydrates full-stack features", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const clientModule = await server.transformRequest("/src/queries.sol.tsx");
  if (!clientModule) throw new Error("Vite did not transform the queries client module");
  const clientCode = clientModule.code;
  const sourceContents =
    clientModule.map && "sourcesContent" in clientModule.map
      ? clientModule.map.sourcesContent
      : undefined;
  if (!sourceContents) throw new Error("Vite did not retain client source-map content");
  const clientSources = sourceContents.join("\n");
  const clientArtifacts = `${clientCode}\n${clientSources}`;
  expect(clientCode).toContain('__sol_rpc_query_client("notes")');
  expect(clientCode).toContain('__sol_rpc_mutation_client("create-note")');
  expect(clientSources).toContain("interface Note");
  expect(clientArtifacts).not.toContain("notes-backend");
  expect(clientArtifacts).not.toContain("notesPageSchema");
  expect(clientArtifacts).not.toContain("noteTitleSchema");
  expect(clientArtifacts).not.toContain("noteHttpSchema");
  expect(clientArtifacts).not.toContain("verifyNotesBackendSecret");
  expect(clientArtifacts).not.toContain("Cache one request across observers");
  expect(clientArtifacts).not.toContain("SOL_BACKEND_SCHEMA_VALIDATOR_DO_NOT_SHIP");
  expect(clientArtifacts).not.toContain("SOL_BACKEND_SECRET_DO_NOT_SHIP");
  const response = await fetch(`${origin}/blog/1?from=dev`);
  const document = await response.text();
  expect(response.status).toBe(200);
  expect(document).toContain("The compiler keeps the map");
  expect(document).toContain("data-sol-hydration");
  expect(document).toContain('rel="stylesheet" href="/src/styles.css" data-solkit-dev-style');
  expect(document).toContain('rel="stylesheet" href="/src/Shell.css" data-solkit-dev-style');
  const childStyles = await fetch(`${origin}/src/Shell.css`, {
    headers: { accept: "text/css" },
  }).then((result) => result.text());
  expect(childStyles).toContain("--solkit-child-style: loaded");

  const asyncDocument = await fetch(`${origin}/async-context`).then((result) => result.text());
  expect(asyncDocument).toContain("Timed work is still pending.");
  expect(asyncDocument).not.toContain("Global portal mounted");
  const rootDocument = await fetch(origin).then((result) => result.text());
  expect(rootDocument).toContain('<title data-sol-e="0">Margin — 2 tasks left</title>');
  expect(rootDocument).toContain("2 unfinished notes in the Sol compiler example.");

  await page.goto(`${origin}/blog/1?from=dev`);
  await expect(page.locator("html")).toHaveAttribute("data-solkit-hydrated", "true");
  await expect(page.locator(`link[data-solkit-dev-style]`)).toHaveCount(0);
  await expect(page.getByTestId("route-query-source")).toHaveText("Opened from dev");
  expect(errors).toEqual([]);

  await page.goto(`${origin}/queries`);
  await expect(page.locator("html")).toHaveAttribute("data-solkit-hydrated", "true");
  await expect(page.getByTestId("query-loading")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Page 1" })).toBeVisible();
  await page.getByTestId("query-refetch").click();
  await expect(page.getByRole("heading", { name: "Page 2" })).toBeVisible();
  await page.getByTestId("query-mutate").click();
  await expect(page.getByRole("heading", { name: "Page 1" })).toBeVisible();
  const noteResponse = await fetch(`${origin}/api/notes/1`);
  expect(noteResponse.status).toBe(200);
  expect(await noteResponse.json()).toMatchObject({ id: 1 });
  const requestNames = await page.evaluate(() =>
    globalThis.__sol?.requests.map((request) => request.name).filter(Boolean),
  );
  expect(requestNames).toContain("notes");
  expect(requestNames).toContain("create-note");
  expect(errors).toEqual([]);

  await page.goto(`${origin}/async-context`);
  await expect(page.locator("html")).toHaveAttribute("data-solkit-hydrated", "true");
  await expect(page.getByTestId("async-results")).toBeVisible();
  await page.waitForFunction(
    () =>
      typeof (globalThis as typeof globalThis & { solkitResolveTimedNote?: unknown })
        .solkitResolveTimedNote === "function",
  );
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      solkitResolveTimedNote(value: string): void;
    };
    runtime.solkitResolveTimedNote("Timed work resumed in the browser.");
  });
  await expect(page.getByTestId("timed-fallback")).toBeHidden();
  await expect(page.getByTestId("timed-ready")).toBeVisible();
  await expect(page.getByTestId("expected-error")).toContainText("Expected boundary failure");
  await expect(page.getByTestId("global-portal-content")).toBeVisible();
  await page.getByTestId("portal-content").click();
  await expect(page.getByTestId("portal-content")).toHaveText("Portal clicks1");
  await expect(page).toHaveTitle("Margin — compiled notes");
  expect(errors).toEqual([]);

  await page.goto(origin);
  await expect(page.locator("html")).toHaveAttribute("data-solkit-hydrated", "true");
  await expect(page).toHaveTitle("Margin — 2 tasks left");
  await page.getByRole("link", { name: "New entry", exact: true }).click();
  await expect(page).toHaveURL(/\/blog\/new$/);
  await expect(page.getByRole("heading", { name: "Put the thought on paper." })).toBeVisible();
});
