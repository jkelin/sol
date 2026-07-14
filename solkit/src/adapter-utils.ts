import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SolkitAdapterContext } from "./types.ts";

export async function loadLauncher(url: URL): Promise<string> {
  let source: unknown;
  if (typeof Bun === "undefined") source = await readFile(url, "utf8");
  else source = (await import(url.href, { with: { type: "text" } })).default;
  if (typeof source !== "string") throw new TypeError("Launcher source must be text");
  return source;
}

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
