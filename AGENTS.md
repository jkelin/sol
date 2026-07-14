# Agent verification

- During the development hot loop, run only `bun run verify` after making changes. It fixes formatting and lint issues, then runs the test suite.
- Before creating an agent-authored commit, run only `bun run test:web` and `bun run test:e2e`.

# Documentation

- Keep the root and package `README.md` files synchronized with behavior, commands, package interfaces, and folder structure whenever those change.
- Keep the runtime and compiler READMEs synchronized with their `src` files, including a brief description of each source file and how the package internals work.

# Naming

- If you find `solix` anywhere, rename it to `sol`.
