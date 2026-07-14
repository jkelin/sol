// oxlint-disable eslint/no-underscore-dangle -- __solix is the documented development global.
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;

test.beforeAll(async () => {
  server = await createServer({
    configFile: "vite.config.ts",
    server: { host: "127.0.0.1", port: 4175, strictPort: true },
  });
  await server.listen();
});

test.afterAll(async () => {
  await server.close();
});

test("Vite development middleware renders and hydrates full-stack features", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await fetch("http://127.0.0.1:4175/blog/1?from=dev");
  const document = await response.text();
  expect(response.status).toBe(200);
  expect(document).toContain("The compiler keeps the map");
  expect(document).toContain("data-solix-hydration");
  expect(document).toContain('rel="stylesheet" href="/src/styles.css" data-solkit-dev-style');
  expect(document).toContain('rel="stylesheet" href="/src/Shell.css" data-solkit-dev-style');
  const childStyles = await fetch("http://127.0.0.1:4175/src/Shell.css", {
    headers: { accept: "text/css" },
  }).then((result) => result.text());
  expect(childStyles).toContain("--solkit-child-style: loaded");

  const asyncDocument = await fetch("http://127.0.0.1:4175/async-context").then((result) =>
    result.text(),
  );
  expect(asyncDocument).toContain("Timed work is still pending.");
  expect(asyncDocument).not.toContain("Global portal mounted");
  const rootDocument = await fetch("http://127.0.0.1:4175/").then((result) => result.text());
  expect(rootDocument).toContain('<title data-solix-e="0">Margin — 2 tasks left</title>');
  expect(rootDocument).toContain("2 unfinished notes in the Solix compiler example.");

  await page.goto("http://127.0.0.1:4175/blog/1?from=dev");
  await expect(page.locator("html")).toHaveAttribute("data-solkit-hydrated", "true");
  await expect(page.locator(`link[data-solkit-dev-style]`)).toHaveCount(0);
  await expect(page.getByTestId("route-query-source")).toHaveText("Opened from dev");
  expect(errors).toEqual([]);

  await page.goto("http://127.0.0.1:4175/queries");
  await expect(page.locator("html")).toHaveAttribute("data-solkit-hydrated", "true");
  await expect(page.getByTestId("query-loading")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Page 1" })).toBeVisible();
  await page.getByTestId("query-refetch").click();
  await expect(page.getByRole("heading", { name: "Page 2" })).toBeVisible();
  await page.getByTestId("query-mutate").click();
  await expect(page.getByRole("heading", { name: "Page 1" })).toBeVisible();
  const noteResponse = await fetch("http://127.0.0.1:4175/api/notes/1");
  expect(noteResponse.status).toBe(200);
  expect(await noteResponse.json()).toMatchObject({ id: 1 });
  const requestNames = await page.evaluate(() =>
    globalThis.__solix?.requests.map((request) => request.name).filter(Boolean),
  );
  expect(requestNames).toContain("notes");
  expect(requestNames).toContain("create-note");
  expect(errors).toEqual([]);

  await page.goto("http://127.0.0.1:4175/async-context");
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

  await page.goto("http://127.0.0.1:4175/");
  await expect(page.locator("html")).toHaveAttribute("data-solkit-hydrated", "true");
  await expect(page).toHaveTitle("Margin — 2 tasks left");
  await page.getByRole("link", { name: "New entry", exact: true }).click();
  await expect(page).toHaveURL(/\/blog\/new$/);
  await expect(page.getByRole("heading", { name: "Put the thought on paper." })).toBeVisible();
});
