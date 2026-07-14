#!/usr/bin/env bun

import { build } from "vite";

const BUILD_TARGET = "SOLKIT_BUILD_TARGET";

async function viteBuild(target?: string): Promise<void> {
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

const command = process.argv[2];
if (command !== "build" || process.argv.length !== 3) {
  console.error("Usage: solkit build");
  process.exitCode = 1;
} else {
  await viteBuild();
  await viteBuild("server");
}
