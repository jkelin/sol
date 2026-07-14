import { loadLauncher, writeLauncher } from "../adapter-utils.ts";
import type { SolkitAdapter, SolkitAdapterContext } from "../types.ts";

export function nodeAdapter(): SolkitAdapter {
  if (arguments.length !== 0) throw new TypeError("nodeAdapter() does not accept options");
  return Object.freeze({
    name: "node",
    write: async (context: SolkitAdapterContext) =>
      writeLauncher(context, await loadLauncher(new URL("./node-launcher.mjs", import.meta.url))),
  });
}
