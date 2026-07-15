#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BUILD_TARGET = "SOLKIT_BUILD_TARGET";
const CLI_RUNNING = "SOLKIT_CLI_RUNNING";

async function viteBuild(target?: string): Promise<void> {
  const { build } = await import("vite");
  const previous = process.env[BUILD_TARGET];
  if (target) process.env[BUILD_TARGET] = target;
  else delete process.env[BUILD_TARGET];
  try {
    await build();
  } finally {
    if (previous === undefined) delete process.env[BUILD_TARGET];
    else process.env[BUILD_TARGET] = previous;
  }
}

async function run(): Promise<void> {
  const command = process.argv[2];
  if (command !== "build" || process.argv.length !== 3) {
    console.error("Usage: solkit build");
    process.exitCode = 1;
    return;
  }
  await viteBuild();
  await viteBuild("server");
  await viteBuild("adapter");
}

const script = process.argv[1];
if (
  script &&
  process.env[CLI_RUNNING] !== "1" &&
  realpathSync(script) === fileURLToPath(import.meta.url)
) {
  process.env[CLI_RUNNING] = "1";
  void run().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
