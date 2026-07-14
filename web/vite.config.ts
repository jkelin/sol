import tailwindcss from "@tailwindcss/vite";
import { solix } from "@solix/compiler/vite";
import { bunAdapter } from "solkit/adapters/bun";
import { solkit } from "solkit/vite";
import { defineConfig } from "vite";
import { solixMarkdown } from "./src/markdown/vite.ts";

export default defineConfig({
  plugins: [
    solixMarkdown(),
    solix(),
    tailwindcss(),
    solkit({ entry: "/src/main.tsx", adapter: bunAdapter() }),
  ],
  build: {
    sourcemap: true,
  },
});
