import { expect, test } from "@playwright/test";
import { preview, type PreviewServer } from "vite";

let previewServer: PreviewServer;

test.beforeAll(async () => {
  previewServer = await preview({
    configFile: "vite.config.ts",
    preview: { host: "127.0.0.1", port: 5174, strictPort: true },
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    previewServer.httpServer.close((error) => error ? reject(error) : resolve());
  });
});

test("runs the to-do workflow without rerunning component setup", async ({ page }) => {
  await page.goto("/");

  const draft = page.getByLabel("New note", { exact: true });
  const add = page.getByRole("button", { name: "Add task", exact: true });
  await expect(add).toBeDisabled();
  await draft.fill("Verify fine-grained updates");
  await expect(add).toBeEnabled();
  await draft.press("Enter");

  await expect(page.getByText("Verify fine-grained updates", { exact: true })).toBeVisible();
  await expect(draft).toHaveValue("");
  await page.getByRole("checkbox", {
    name: "Mark Verify fine-grained updates as completed",
    exact: true,
  }).check({ force: true });

  await expect(page.locator(".completion-margin strong")).toHaveText("2");
  await expect(page.locator(".remaining-count strong")).toHaveText("2");
  await expect.poll(() => page.evaluate(() => window.__frontendFrameworkDemo)).toEqual({ app: 1, row: 4 });

  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByText("Verify fine-grained updates", { exact: true })).toBeHidden();
  await expect(page.locator(".todo-row")).toHaveCount(2);

  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Clear completed", exact: true }).click();
  await expect(page.locator(".todo-row")).toHaveCount(2);
  await expect(page.locator(".ledger-footer span")).toHaveText("2 total / 0 completed");

  await page.getByRole("button", { name: "Remove Prove nested proxy updates", exact: true }).click();
  await expect(page.locator(".todo-row")).toHaveCount(1);
});

test("stays usable and overflow-free at desktop and mobile sizes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("New note", { exact: true }).focus();
  await expect(page.getByRole("heading", { name: "Things worth finishing" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/todo-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Filter tasks" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/todo-mobile.png", fullPage: true });
});
