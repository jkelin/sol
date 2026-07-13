import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
  },
});
