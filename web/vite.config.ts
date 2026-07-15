import tailwindcss from "@tailwindcss/vite";
import { sol } from "@soljs/compiler/vite";
import { staticAdapter } from "@soljs/solkit/adapters/static";
import { solkit } from "@soljs/solkit/vite";
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
