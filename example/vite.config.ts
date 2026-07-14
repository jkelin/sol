import tailwindcss from "@tailwindcss/vite";
import { sol } from "@sol/compiler/vite";
import { bunAdapter } from "solkit/adapters/bun";
import { solkit } from "solkit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sol(), tailwindcss(), solkit({ entry: "/src/entry.tsx", adapter: bunAdapter() })],
  build: {
    minify: false,
    sourcemap: true,
  },
});
