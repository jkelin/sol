import { defineConfig } from "vite";
import { frontendFramework } from "./src/vite.ts";

export default defineConfig({
  root: "demo",
  plugins: [frontendFramework()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
