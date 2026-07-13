import tailwindcss from "@tailwindcss/vite";
import { solix } from "@solix/compiler/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [solix(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
