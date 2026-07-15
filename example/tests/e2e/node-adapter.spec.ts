import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { nodeAdapter } from "solkit/adapters/node";

const port = 4176;
const origin = `http://127.0.0.1:${port}`;
const serverDirectory = resolve("dist/node-server");
const clientDirectory = resolve("dist/client");
let server: ChildProcess | undefined;

test.beforeAll(async () => {
  await rm(serverDirectory, { recursive: true, force: true });
  await mkdir(serverDirectory, { recursive: true });
  await copyFile(resolve("dist/server/app.mjs"), resolve(serverDirectory, "app.mjs"));
  await cp(resolve("dist/server/assets"), resolve(serverDirectory, "assets"), { recursive: true });
  await nodeAdapter().write({ serverDirectory, clientDirectory });
  server = spawn("node", [resolve(serverDirectory, "index.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "inherit",
  });
  await expect
    .poll(async () =>
      fetch(origin).then(
        (response) => response.status,
        () => 0,
      ),
    )
    .toBe(200);
});

test.afterAll(async () => {
  if (server?.exitCode === null) server.kill("SIGKILL");
  if (server?.exitCode === null) {
    await new Promise<void>((resolveExit) => server?.once("exit", () => resolveExit()));
  }
  await rm(serverDirectory, { recursive: true, force: true });
});

test("Node serves SSR output and hydrates routes, queries, async content, and Head", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const routeDocument = await fetch(`${origin}/blog/1?from=node`).then((response) =>
    response.text(),
  );
  expect(routeDocument).toContain("The compiler keeps the map");
  expect(routeDocument).toContain("data-sol-hydration");
  const rootDocument = await fetch(origin).then((response) => response.text());
  expect(rootDocument).toContain('<title data-sol-e="0">Margin — 2 tasks left</title>');
  expect(rootDocument).toContain("2 unfinished notes in the Sol compiler example.");
  await page.goto(`${origin}/blog/1?from=node`);
  await expect(page.locator("html")).toHaveAttribute("data-solkit-hydrated", "true");
  await expect(page.getByTestId("route-query-source")).toHaveText("Opened from node");

  await page.goto(`${origin}/queries`);
  await expect(page.locator("html")).toHaveAttribute("data-solkit-hydrated", "true");
  await expect(page.getByTestId("query-loading")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Page 1" })).toBeVisible();
  await page.getByTestId("query-refetch").click();
  await expect(page.getByRole("heading", { name: "Page 2" })).toBeVisible();
  await page.getByTestId("query-mutate").click();
  await expect(page.getByText("Mutation note 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Page 1" })).toBeVisible();

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
  await page.getByTestId("context-consumer").click();
  await expect(page.getByTestId("context-consumer")).toContainText("visits 1");

  await page.goto(origin);
  await expect(page.locator("html")).toHaveAttribute("data-solkit-hydrated", "true");
  await expect(page).toHaveTitle("Margin — 2 tasks left");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "2 unfinished notes in the Sol compiler example.",
  );
  expect(errors).toEqual([]);
});
