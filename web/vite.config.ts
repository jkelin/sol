import tailwindcss from "@tailwindcss/vite";
import { solix } from "@solix/compiler/vite";
import { defineConfig } from "vite";
import { solixMarkdown } from "./src/markdown/vite.ts";

export default defineConfig({
  plugins: [solixMarkdown(), solix(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
