import tailwindcss from "@tailwindcss/vite";
import { sol } from "@soljs/compiler/vite";
import { bunAdapter } from "@soljs/solkit/adapters/bun";
import { solkit } from "@soljs/solkit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sol(), tailwindcss(), solkit({ entry: "/src/entry.tsx", adapter: bunAdapter() })],
  build: {
    minify: false,
    sourcemap: true,
  },
});
