import { expect, test } from "@playwright/test";
import { preview, type PreviewServer } from "vite";

let previewServer: PreviewServer;

test.beforeAll(async () => {
  previewServer = await preview({
    configFile: "vite.config.ts",
    preview: { host: "127.0.0.1", port: 4174, strictPort: true },
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    previewServer.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test("runs landing examples and preserves preview state across view modes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Build in sunlight." })).toBeVisible();

  const counter = page.getByTestId("counter-example");
  const syntaxColorCount = await counter
    .locator("code")
    .evaluate(
      (code) =>
        new Set(
          [...code.querySelectorAll<HTMLElement>("span[style]")].map(
            (token) => getComputedStyle(token).color,
          ),
        ).size,
    );
  expect(syntaxColorCount).toBeGreaterThan(3);
  await expect(counter.getByRole("button", { name: "−" })).toBeDisabled();
  await counter.getByRole("button", { name: "Add one" }).click();
  await expect(counter.locator("output")).toHaveText("1");
  await expect(counter.getByRole("button", { name: "−" })).toBeEnabled();
  await counter.getByRole("button", { name: "code", exact: true }).click();
  await expect(counter.getByLabel("Code panel")).toBeVisible();
  await expect(counter.getByRole("button", { name: "Add one" })).toBeHidden();
  await counter.getByRole("button", { name: "both", exact: true }).click();
  await expect(counter.locator("output")).toHaveText("1");

  const list = page.getByTestId("list-example");
  const template = list.getByRole("button", { name: /Static template/ });
  await expect(template).toContainText("Ready");
  await template.click();
  await expect(template).toContainText("Draft");
  await list.getByRole("button", { name: "Add block" }).click();
  await expect(list.getByRole("button", { name: /DOM operation 3/ })).toBeVisible();

  const form = page.getByTestId("form-example");
  await form.getByRole("button", { name: "Validate" }).click();
  await expect(form.getByRole("alert")).toContainText("valid email");
  await form.getByLabel("Email address").fill("hello@solix.dev");
  await form.getByRole("button", { name: "Validate" }).click();
  await expect(form.getByText("Accepted: hello@solix.dev")).toBeVisible();
  expect(errors).toEqual([]);
});

test("navigates Markdown documentation and operates embedded examples", async ({
  context,
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "Getting Started" })).toBeVisible();
  const sidebar = page.getByRole("complementary", {
    name: "Documentation sidebar",
    exact: true,
  });
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /Getting Started/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page
    .getByRole("link", { name: /Reactivity/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/docs\/reactivity$/);
  await expect(page.getByRole("heading", { name: "Reactivity" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /Reactivity/ })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const example = page.locator('[data-live-example="AssemblyQueue"]');
  await example.getByRole("button", { name: "Add block" }).click();
  await expect(example.getByText("Block 3", { exact: true })).toBeVisible();
  await example.getByRole("button", { name: "code", exact: true }).click();
  await expect(example.getByText("Block 3", { exact: true })).toBeHidden();
  await example.getByRole("button", { name: "both", exact: true }).click();
  await expect(example.getByText("Block 3", { exact: true })).toBeVisible();

  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:4174",
  });
  await example.getByRole("button", { name: "Copy code" }).click();
  await expect(example.getByRole("status")).toHaveText("Code copied to clipboard");

  await page.goto("/docs/not-a-real-page");
  await expect(
    page.getByRole("heading", { name: "This documentation page does not exist." }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("keeps the site keyboard-usable, reduced-motion safe, and overflow-free", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const heroLayout = await page.evaluate(() => {
    const headline = document.querySelector<HTMLElement>("#hero-title span.relative")!;
    const orbit = document.querySelector<HTMLElement>(
      '[aria-label="Solix blocks assembling around a precise DOM output"]',
    )!;
    const headlineBounds = headline.getBoundingClientRect();
    const orbitBounds = orbit.getBoundingClientRect();
    const cards = [...orbit.querySelectorAll<HTMLElement>(":scope > div")].slice(2);
    return {
      separated: orbitBounds.top > headlineBounds.bottom,
      cardsContained: cards.every((card) => {
        const bounds = card.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth;
      }),
    };
  });
  expect(heroLayout).toEqual({ separated: true, cardsContained: true });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  const animationDuration = await page
    .locator(".ticker-track")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration));
  expect(animationDuration).toBeLessThanOrEqual(0.001);
  await expect
    .poll(() =>
      page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/web-landing-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 1632, height: 1000 });
  const wideHeroLayout = await page.evaluate(() => {
    const headline = document
      .querySelector<HTMLElement>("#hero-title span.relative")!
      .getBoundingClientRect();
    const orbit = document.querySelector<HTMLElement>(
      '[aria-label="Solix blocks assembling around a precise DOM output"]',
    )!;
    const cards = [...orbit.querySelectorAll<HTMLElement>(":scope > div")].slice(2);
    const writable = cards[0]!.getBoundingClientRect();
    return {
      headlineClearsWritableBlock: headline.right < writable.left,
      cardsContained: cards.every((card) => {
        const bounds = card.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth;
      }),
    };
  });
  expect(wideHeroLayout).toEqual({ headlineClearsWritableBlock: true, cardsContained: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs");
  const browse = page.getByRole("button", { name: "Browse pages" });
  await browse.click();
  const sheet = page.getByRole("dialog", { name: "Field manual" });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole("button", { name: "Close ×" })).toBeFocused();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(browse).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await browse.click();
  await page
    .getByRole("link", { name: /Forms and Validation/ })
    .last()
    .click();
  await expect(page).toHaveURL(/\/docs\/forms-and-validation$/);
  await expect
    .poll(() =>
      page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/web-docs-mobile.png", fullPage: true });
});
