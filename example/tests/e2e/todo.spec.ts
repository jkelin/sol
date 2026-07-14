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

test("runs the to-do workflow with validation and fine-grained updates", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Margin — 2 tasks left");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "2 unfinished notes in the Solix compiler example.",
  );
  await expect(page.locator("style[data-solix-head-example]")).toHaveJSProperty(
    "textContent",
    ":root { --remaining-notes: 2; }",
  );

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
  await expect(blankEditor).toBeVisible();
  await expect(blankEditor).toHaveAttribute("aria-invalid", "true");
  const editInfo = originalRow.getByRole("button", {
    name: "Validation error: Write a note before adding it.",
    exact: true,
  });
  await expect(editInfo).toBeVisible();
  await editInfo.focus();
  await expect(originalRow.getByRole("tooltip")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/todo-validation-edit.png", fullPage: true });

  await blankEditor.fill("This title is definitely too long");
  await expect(blankEditor).toHaveAttribute("aria-invalid", "false");
  await blankEditor.press("Enter");
  await expect(blankEditor).toBeVisible();
  await expect(blankEditor).toHaveAttribute("aria-invalid", "true");
  await expect(originalRow.getByRole("tooltip")).toHaveText(
    "Keep the note to 32 characters or fewer.",
  );

  await blankEditor.fill("Save edits on blur");
  await blankEditor.blur();
  await expect(
    page.getByRole("button", { name: "Edit Save edits on blur", exact: true }),
  ).toBeVisible();
  const draft = page.getByLabel("New note", { exact: true });
  const add = page.getByRole("button", { name: "Add task", exact: true });
  await expect(add).toBeEnabled();
  await add.click();
  await expect(draft).toHaveAttribute("aria-invalid", "true");
  const emptyInfo = page.getByRole("button", {
    name: "Validation error: Write a note before adding it.",
    exact: true,
  });
  await emptyInfo.focus();
  await expect(page.getByRole("tooltip")).toHaveCSS("opacity", "1");

  await draft.fill("This task title is much too long!");
  await expect(draft).toHaveAttribute("aria-invalid", "false");
  await draft.press("Enter");
  await expect(draft).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("tooltip")).toHaveText("Keep the note to 32 characters or fewer.");

  await draft.fill("Verify fine-grained updates");
  await draft.press("Enter");

  await expect(page.getByText("Verify fine-grained updates", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Margin — 3 tasks left");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "3 unfinished notes in the Solix compiler example.",
  );
  await expect(draft).toHaveValue("");
  await page
    .getByRole("checkbox", {
      name: "Mark Verify fine-grained updates as completed",
      exact: true,
    })
    .check({ force: true });

  await expect(page).toHaveTitle("Margin — 2 tasks left");
  await expect(page.locator("style[data-solix-head-example]")).toHaveJSProperty(
    "textContent",
    ":root { --remaining-notes: 2; }",
  );
  await expect(page.locator(".completion-margin strong")).toHaveText("2");
  await expect(page.locator(".remaining-count strong")).toHaveText("2");
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByText("Verify fine-grained updates", { exact: true })).toBeHidden();
  await expect(page.locator(".todo-row")).toHaveCount(2);

  await page.getByRole("button", { name: "Completed", exact: true }).click();
  await expect(page.getByText("Verify fine-grained updates", { exact: true })).toBeVisible();
  await expect(page.getByText("Trace the compiled template", { exact: true })).toBeVisible();
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

  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByRole("button", { name: "Validation error: Write a note before adding it." })
    .focus();
  await expect(page.getByRole("tooltip")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/todo-validation-desktop.png", fullPage: true });
  await page.getByLabel("New note", { exact: true }).fill("Draft");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Filter tasks" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/todo-mobile.png", fullPage: true });

  await page.getByLabel("New note", { exact: true }).fill("");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByRole("button", { name: "Validation error: Write a note before adding it." })
    .focus();
  await expect(page.getByRole("tooltip")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/todo-validation-mobile.png", fullPage: true });
});

test("navigates compiled blog routes and creates a shared entry", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
    if (typeof descriptor?.value !== "function") return;
    const getAnimations = descriptor.value as Element["getAnimations"];
    Element.prototype.getAnimations = function (options) {
      const animations = Reflect.apply(getAnimations, this, [options]) as Animation[];
      const count = Number(sessionStorage.getItem("transition-animation-count") ?? 0);
      sessionStorage.setItem("transition-animation-count", String(count + animations.length));
      return animations;
    };
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  expect(pageErrors).toEqual([]);
  await expect(page.getByTestId("global-header")).toBeVisible();

  await page.getByRole("link", { name: "New entry", exact: true }).click();
  await expect(page).toHaveURL(/\/blog\/new$/);
  await expect(page.getByRole("heading", { name: "Put the thought on paper." })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("transition-animation-count"))))
    .toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("link", { name: /The compiler keeps the map/ })).toBeVisible();
  await page.screenshot({ path: "test-results/blog-new-desktop.png", fullPage: true });

  await page.getByRole("link", { name: /The compiler keeps the map/ }).click();
  await expect(page.getByTestId("route-pending")).toBeVisible();
  await expect(page).toHaveURL(/\/blog\/1\?from=index$/);
  await expect.poll(() => pageErrors).toEqual([]);
  await expect(page.getByTestId("route-query-source")).toHaveText("Opened from index");
  await page.goBack();
  await expect(page).toHaveURL(/\/blog\/new$/);

  await page.locator('a[href^="/blog/1?"]').evaluate((anchor) => {
    (anchor as HTMLAnchorElement).click();
    document.querySelector<HTMLAnchorElement>('a[href="/"]')!.click();
  });
  await expect(page).toHaveURL(/\/$/);
  await page.waitForTimeout(50);
  await expect(page.getByRole("heading", { name: "Things worth finishing" })).toBeVisible();
  await page.getByRole("link", { name: "New entry", exact: true }).click();
  await expect(page).toHaveURL(/\/blog\/new$/);

  await page.getByRole("button", { name: "File entry" }).click();
  await expect(page.getByText("Give the entry a name.")).toBeVisible();
  await expect(page.getByText("Add some content before filing.")).toBeVisible();

  await page.getByLabel("Entry name").fill("Routes written in the margin");
  await page
    .getByLabel("Content")
    .fill("Static route declarations can still drive a responsive browser history.");
  await page.getByRole("button", { name: "File entry" }).click();

  await expect(page.getByTestId("route-pending")).toBeVisible();
  await expect(page).toHaveURL(/\/blog\/3\?from=new$/);
  expect(pageErrors).toEqual([]);
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

  await page.goto("/blog/1?from=first&from=last");
  await expect(page.getByTestId("route-query-source")).toHaveText("Opened from last");
  await page.goto("/blog/not-a-number");
  await expect(page.getByTestId("global-header")).toBeVisible();
  await expect(page.getByRole("heading", { name: "This entry is missing." })).toHaveCount(0);
});

test("renders context-backed async components and Await behind Suspense", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/async-context");
  await expect(page.getByRole("heading", { name: "Context and async rendering" })).toBeVisible();
  await expect(page.getByTestId("optional-context")).toContainText("undefined");
  await expect(page.getByTestId("context-consumer")).toContainText("visits 0");
  await expect(page.getByTestId("async-loading")).toBeVisible();
  await expect(page.getByTestId("async-results")).toBeHidden();

  await expect(page.getByTestId("async-loading")).toBeHidden();
  await expect(page.getByTestId("async-component")).toContainText("Async component");
  await expect(page.getByTestId("async-component")).toContainText("Provider-backed");
  await expect(page.getByTestId("await-result")).toContainText("Await render function");

  await page.getByTestId("context-consumer").click();
  await expect(page.getByTestId("context-consumer")).toContainText("visits 1");
  expect(pageErrors).toEqual([]);
});

test("shares query data, refetches with new arguments, and refreshes after a mutation", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/queries");
  await expect(page.getByTestId("query-loading")).toBeVisible();
  await expect(page.getByTestId("query-panel")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Page 1" })).toBeVisible();
  await expect(page.getByTestId("query-notes").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("query-observer").locator("strong")).toHaveText("1");

  await page.getByTestId("query-refetch").click();
  await expect(page.getByRole("heading", { name: "Page 2" })).toBeVisible();
  await expect(page.getByTestId("query-last-page")).toContainText("1");

  await page.getByTestId("query-mutate").click();
  await expect(page.getByText("Mutation note 4", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Page 1" })).toBeVisible();
  await expect(page.getByTestId("query-observer").locator("strong")).toHaveText("2");
  expect(pageErrors).toEqual([]);
});
