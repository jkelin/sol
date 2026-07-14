import tailwindcss from "@tailwindcss/vite";
import { sol } from "@sol/compiler/vite";
import { bunAdapter } from "solkit/adapters/bun";
import { solkit } from "solkit/vite";
import { defineConfig } from "vite";
import { solMarkdown } from "./src/markdown/vite.ts";

export default defineConfig({
  plugins: [
    solMarkdown(),
    sol(),
    tailwindcss(),
    solkit({ entry: "/src/main.tsx", adapter: bunAdapter() }),
  ],
  build: {
    sourcemap: true,
  },
});
