import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SolkitAdapterContext } from "./types.ts";

export async function writeLauncher(context: SolkitAdapterContext, source: string): Promise<void> {
  if (!context || typeof context !== "object") {
    throw new TypeError("Adapter context must be an object");
  }
  if (typeof context.serverDirectory !== "string" || !context.serverDirectory) {
    throw new TypeError("Adapter serverDirectory must be a non-empty string");
  }
  if (typeof context.clientDirectory !== "string" || !context.clientDirectory) {
    throw new TypeError("Adapter clientDirectory must be a non-empty string");
  }
  await mkdir(context.serverDirectory, { recursive: true });
  await writeFile(join(context.serverDirectory, "index.mjs"), source, "utf8");
}
