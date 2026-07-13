# Agent verification

- Run `bun run verify` after making changes.
- Run `bun run test:e2e` when a change might have broken the browser application.
- Before creating an agent-authored commit, always run both `bun run verify` and `bun run test:e2e` for full verification.

# Documentation

- Keep the root and package `README.md` files synchronized with behavior, commands, package interfaces, and folder structure whenever those change.
- Keep the runtime and compiler READMEs synchronized with their `src` files, including a brief description of each source file and how the package internals work.
