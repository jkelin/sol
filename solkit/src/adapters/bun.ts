import { loadLauncher, writeLauncher } from "../adapter-utils.ts";
import type { SolkitAdapter, SolkitAdapterContext } from "../types.ts";

export function bunAdapter(): SolkitAdapter {
  if (arguments.length !== 0) throw new TypeError("bunAdapter() does not accept options");
  return Object.freeze({
    name: "bun",
    write: async (context: SolkitAdapterContext) =>
      writeLauncher(
        context,
        await loadLauncher(
          new URL("./bun-launcher.mjs", import.meta.url),
          () => import("./bun-launcher.mjs", { with: { type: "text" } }),
        ),
      ),
  });
}
