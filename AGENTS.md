# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

XJog is an XState 4 statechart runner for long-running, database-persisted charts (e.g. business processes). TypeScript monorepo using pnpm workspaces + Turborepo for tasks (build/test caching + graph ordering) and Changesets for independent versioning/publishing. Published under `@telia-oss/xjog-*`. Currently in beta (`0.2.0`).

## Commands

```bash
pnpm install                                            # Install dependencies
pnpm run build                                          # Build all packages (turbo run build, cached)
pnpm exec turbo run build --filter @telia-oss/xjog       # Build single package (+ its deps)
pnpm run test                                           # Run all unit tests (turbo run test)
pnpm exec turbo run test --filter @telia-oss/xjog        # Run tests for one package
pnpm run watch-all                                      # Build once, then tsc --watch all packages
pnpm run lint                                           # Lint whole repo (biome ci)
pnpm run lint:fix                                       # Lint + apply safe fixes (biome check --write)
pnpm run format                                         # Format whole repo (biome format --write)
pnpm --filter @telia-oss/xjog run lint                   # Lint single package
```

Build/test run through [Turborepo](https://turborepo.com) (`turbo.json` defines the task
graph + cache; `build` outputs `lib/**`, `test` depends on upstream `^build`). Linting is a
single whole-repo Biome pass, so it isn't routed through turbo. Versioning and publishing
run through [Changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset                                          # Record a change + bump level for a release
pnpm version-packages                                   # Apply pending changesets (bump + changelog)
pnpm release                                            # Build all, then publish changed packages + tags
```

Linting and formatting use [Biome](https://biomejs.dev) (config in `biome.json`).

Run a single test file from within its package directory:
```bash
cd packages/core
NODE_OPTIONS='--experimental-vm-modules' jest --config jestconfig.js src/XJogActivityManager.test.ts
NODE_OPTIONS='--experimental-vm-modules' jest --config jestconfig.js -t "test name pattern"
```

## Architecture

The monorepo follows a layered adapter pattern:

- **core** (`@telia-oss/xjog`): Main engine — `XJog` orchestrates lifecycle, `XJogMachine` wraps registered statecharts, `XJogChart` manages individual chart instances. Uses `async-mutex` for chart-level locking and RxJS for streaming state changes.
- **util** (`@telia-oss/xjog-util`): Shared logging (`XJogLogEmitter` extends `EventEmitter`), types, helpers.
- **core-persistence** / **core-pg** / **core-pglite**: Abstract persistence adapter + concrete implementations. Each adapter handles SQL migrations from `src/migrations/*.sql` files.
- **journal-*** and **digest-***: Separate persistence/reader/writer packages for journal and digest subsystems, following the same abstract+concrete pattern.

Each package: source in `src/`, compiles to `lib/`, has its own `tsconfig.json` extending root, and excludes `*.test.*` from compilation. Build uses `tsc` directly, tests use `@swc/jest` for speed.

### Key dependency flow
```
core → core-persistence → util
core-pg / core-pglite → core-persistence → util
journal-writer / journal-reader → journal-persistence → util
digest-writer / digest-reader → digest-persistence → util
```

PGlite adapter is used for in-process database testing (no external DB needed). Prefer E2E tests over unit tests; unit tests only for pure functional logic with no external effects.

## Code Style

- Biome formatter: 80 cols, single quotes, trailing commas everywhere, 2-space indent, semicolons
- `any` is permitted (`noExplicitAny` is off); unused vars/params and non-null assertions are also allowed
- Files are PascalCase matching primary export; tests are co-located as `<Name>.test.ts`
- Classes prefixed with `XJog` (e.g. `XJogChart`); options use raw + resolved pattern (`XJogOptions` / `ResolvedXJogOptions`)
- Structured logging via `this.trace()`, `this.debug()`, etc. with correlation IDs (`cid`)
- SQL migrations in `src/migrations/`, copied to `lib/` during build
- Imports are sorted automatically by Biome's `organizeImports` assist (run `pnpm run lint:fix`)

## Git Workflow

- No agent attribution! Hide yourself from the repository.
- No direct commits to `main`
- Branch prefixes: `docs/`, `feature/`, `fix/`
- Bug fix PRs should include regression tests that fail before the fix
- Every PR must include a changeset (`pnpm changeset`) for any change to a
  published package; commit the generated `.changeset/*.md` file with the PR.
  During beta, use `minor` for features and `patch` for fixes (versions stay `0.x.y`).
- PRs always target the `main` branch of the `telia-oss/xjog` repository (the
  `origin` remote) — e.g. `gh pr create --repo telia-oss/xjog --base main`
  (or just `gh pr create`, since `main` is the default branch).
