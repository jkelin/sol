import type { Plugin } from "vite";
import { compile } from "./compiler.ts";

const tsxFile = /\.tsx(?:\?.*)?$/;

export function frontendFramework(): Plugin {
  return {
    name: "frontend-framework",
    enforce: "pre",
    transform: {
      filter: { id: tsxFile },
      handler(source, id) {
        if (!tsxFile.test(id) || id.includes("/node_modules/")) return null;
        return compile(source, id.split("?", 1)[0]);
      },
    },
  };
}
