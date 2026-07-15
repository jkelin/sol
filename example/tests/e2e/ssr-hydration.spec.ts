import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { availablePort } from "./available-port.ts";

let server: ViteDevServer;
let serverHtml: () => Promise<string>;
let serverUrl: string;

test.beforeAll(async () => {
  const port = await availablePort();
  server = await createServer({
    configFile: "vite.config.ts",
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  const resolvedUrl = server.resolvedUrls?.local[0];
  if (!resolvedUrl) throw new Error("Vite did not expose its local development URL");
  serverUrl = resolvedUrl;
  const fixture = (await server.ssrLoadModule("/tests/fixtures/ssr-app.tsx")) as {
    serverHtml: () => Promise<string>;
  };
  serverHtml = () => fixture.serverHtml();
});

test.afterAll(async () => {
  await server.close();
});

test("claims async server HTML and resumes a timed-out boundary", async ({ page }) => {
  const html = await serverHtml();
  await page.goto(serverUrl);
  await page.setContent(`
    <base href="${serverUrl}">
    <div id="ssr-app">${html}</div>
    <script type="module">
      const client = await import("/tests/fixtures/ssr-client.ts");
      window.solStartHydration = client.startHydration;
      window.solClientLoaded = true;
    </script>
  `);
  await page.waitForFunction(
    () => (window as typeof window & { solClientLoaded?: boolean }).solClientLoaded,
  );

  const serverButton = await page.locator("#ssr-primary").elementHandle();
  const timedFallback = await page.locator("#ssr-timed-fallback").elementHandle();
  await page.evaluate(async () => {
    const runtime = window as typeof window & { solStartHydration(): Promise<() => void> };
    await runtime.solStartHydration();
  });

  expect(
    await page.evaluate((node) => node === document.querySelector("#ssr-primary"), serverButton),
  ).toBe(true);
  expect(
    await page.evaluate(
      (node) => node === document.querySelector("#ssr-timed-fallback"),
      timedFallback,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => (window as typeof window & { solPrimaryCalls: number }).solPrimaryCalls,
    ),
  ).toBe(0);
  await page.locator("#ssr-primary").click();
  await expect(page.locator("#ssr-primary")).toHaveText("server data:1");

  await page.evaluate(() => {
    const runtime = window as typeof window & { solResolveTimed(value: string): void };
    runtime.solResolveTimed("browser continuation");
  });
  await expect(page.locator("#ssr-timed-ready")).toHaveText("browser continuation");
  await expect(page.locator("#ssr-timed-fallback")).toHaveCount(0);
});
