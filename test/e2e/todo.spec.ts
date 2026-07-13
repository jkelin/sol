import { expect, test } from "@playwright/test";
import { preview, type PreviewServer } from "vite";

let previewServer: PreviewServer;

test.beforeAll(async () => {
  previewServer = await preview({
    configFile: "vite.config.ts",
    preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    previewServer.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test("runs the to-do workflow without rerunning component setup", async ({ page }) => {
  await page.goto("/");

  const originalRow = page.getByTestId("todo-2");
  const originalRowHandle = await originalRow.elementHandle();
  await page.getByRole("button", { name: "Edit Prove nested proxy updates", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "Edit Prove nested proxy updates",
    exact: true,
  });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Prove nested proxy updates");
  await editor.fill("Prove transparent local updates");
  await editor.press("Enter");
  await expect(
    page.getByRole("button", { name: "Edit Prove transparent local updates", exact: true }),
  ).toBeVisible();
  const renamedRowHandle = await originalRow.elementHandle();
  expect(
    await page.evaluate(
      ([before, after]) => before === after,
      [originalRowHandle, renamedRowHandle],
    ),
  ).toBe(true);

  await page
    .getByRole("button", { name: "Edit Prove transparent local updates", exact: true })
    .click();
  const cancelEditor = originalRow.locator(".todo-editor");
  await cancelEditor.fill("Discard this");
  await expect(cancelEditor).toBeVisible();
  await cancelEditor.press("Escape");
  await expect(
    page.getByRole("button", { name: "Edit Prove transparent local updates", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Edit Prove transparent local updates", exact: true })
    .click();
  const blankEditor = originalRow.locator(".todo-editor");
  await blankEditor.fill("   ");
  await blankEditor.blur();
  await expect(
    page.getByRole("button", { name: "Edit Prove transparent local updates", exact: true }),
  ).toBeVisible();

  const titleButton = page.getByRole("button", {
    name: "Edit Prove transparent local updates",
    exact: true,
  });
  await titleButton.focus();
  await titleButton.press("Enter");
  const blurEditor = originalRow.locator(".todo-editor");
  await expect(blurEditor).toBeFocused();
  await blurEditor.fill("Save edits on blur");
  await blurEditor.blur();
  await expect(
    page.getByRole("button", { name: "Edit Save edits on blur", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.frontendFrameworkDemo))
    .toEqual({ app: 1, row: 3 });

  const draft = page.getByLabel("New note", { exact: true });
  const add = page.getByRole("button", { name: "Add task", exact: true });
  await expect(add).toBeDisabled();
  await draft.fill("Verify fine-grained updates");
  await expect(add).toBeEnabled();
  await draft.press("Enter");

  await expect(page.getByText("Verify fine-grained updates", { exact: true })).toBeVisible();
  await expect(draft).toHaveValue("");
  await page
    .getByRole("checkbox", {
      name: "Mark Verify fine-grained updates as completed",
      exact: true,
    })
    .check({ force: true });

  await expect(page.locator(".completion-margin strong")).toHaveText("2");
  await expect(page.locator(".remaining-count strong")).toHaveText("2");
  await expect
    .poll(() => page.evaluate(() => window.frontendFrameworkDemo))
    .toEqual({ app: 1, row: 4 });

  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByText("Verify fine-grained updates", { exact: true })).toBeHidden();
  await expect(page.locator(".todo-row")).toHaveCount(2);

  await page.getByRole("button", { name: "Completed", exact: true }).click();
  await expect(page.getByText("Verify fine-grained updates", { exact: true })).toBeVisible();
  await expect(page.getByText("Trace the first compiled template", { exact: true })).toBeVisible();
  await expect(page.locator(".todo-row")).toHaveCount(2);

  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Clear completed", exact: true }).click();
  await expect(page.locator(".todo-row")).toHaveCount(2);
  await expect(page.locator(".ledger-footer span")).toHaveText("2 total / 0 completed");

  await page.getByRole("button", { name: "Remove Save edits on blur", exact: true }).click();
  await expect(page.locator(".todo-row")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Remove Ship without a virtual DOM", exact: true })
    .click();
  await expect(page.locator(".todo-row")).toHaveCount(0);
  await expect(page.getByText("No notes on this page.", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.frontendFrameworkDemo))
    .toEqual({ app: 1, row: 8 });
});

test("stays usable and overflow-free at desktop and mobile sizes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("New note", { exact: true }).focus();
  await expect(page.getByRole("heading", { name: "Things worth finishing" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/todo-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Filter tasks" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/todo-mobile.png", fullPage: true });
});

test("navigates compiled blog routes and creates a shared entry", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("global-header")).toBeVisible();

  await page.getByRole("link", { name: "New entry", exact: true }).click();
  await expect(page).toHaveURL(/\/blog\/new$/);
  await expect(page.getByRole("heading", { name: "Put the thought on paper." })).toBeVisible();
  await expect(page.getByRole("link", { name: /The compiler keeps the map/ })).toBeVisible();
  await page.screenshot({ path: "test-results/blog-new-desktop.png", fullPage: true });

  await page.getByRole("button", { name: "File entry" }).click();
  await expect(page.getByText("Give the entry a name.")).toBeVisible();
  await expect(page.getByText("Add some content before filing.")).toBeVisible();

  await page.getByLabel("Entry name").fill("Routes written in the margin");
  await page
    .getByLabel("Content")
    .fill("Static route declarations can still drive a responsive browser history.");
  await page.getByRole("button", { name: "File entry" }).click();

  await expect(page).toHaveURL(/\/blog\/3$/);
  await expect(page.getByRole("heading", { name: "Routes written in the margin" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Routes written in the margin/ })).toBeVisible();
  await expect(page.getByTestId("global-header")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/blog-detail-mobile.png", fullPage: true });

  await page.goBack();
  await expect(page).toHaveURL(/\/blog\/new$/);
  await expect(page.getByRole("link", { name: /Routes written in the margin/ })).toBeVisible();

  await page.getByRole("link", { name: "Todo", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Things worth finishing" })).toBeVisible();
});
