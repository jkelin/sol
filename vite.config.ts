import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { frontendFramework } from "./src/vite.ts";

export default defineConfig({
  root: "demo",
  plugins: [frontendFramework(), tailwindcss()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
