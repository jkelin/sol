import tailwindcss from "@tailwindcss/vite";
import { sol } from "@sol/compiler/vite";
import { staticAdapter } from "solkit/adapters/static";
import { solkit } from "solkit/vite";
import { defineConfig } from "vite";
import { solMarkdown } from "./src/markdown/vite.ts";

export default defineConfig({
  base: process.env.BASE_URL ?? "/",
  plugins: [
    solMarkdown(),
    sol(),
    tailwindcss(),
    solkit({ entry: "/src/main.tsx", adapter: staticAdapter() }),
  ],
  build: {
    sourcemap: true,
  },
});
