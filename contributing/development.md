# Development

This is a monorepo managed using pnpm workspaces. Build and test tasks are orchestrated
by [Turborepo](https://turborepo.com) (task graph + caching in `turbo.json`), and
versioning and publishing go through [Changesets](https://github.com/changesets/changesets).

Prerequisites:

- `pnpm`
- Node.js 24

## Getting started

Prepare the repository.

```bash
git clone git@github.com:telia-oss/xjog.git
cd xjog
pnpm install
```

After this you can run commands like this from the root directory:

```bash
pnpm -r run clean
pnpm run build                                  # turbo run build (cached, graph-ordered)
pnpm exec turbo run build --filter @telia-oss/xjog
pnpm --filter @telia-oss/xjog run lint
```

To get started with development, build and watch from the root level.

```bash
pnpm run watch-all
```

## Versioning and publishing

Please follow the semantic versioning:

- Breaking changes &rarr; major version
- New features &rarr; minor version
- Fixes, documentation &rarr; patch version

Alpha versions are `0.0.x`; beta versions are `0.x.y`. XJog is currently in
**beta** (`0.2.0`). It can graduate to `1.0` once the API and database schema
are considered stable.

Versioning and publishing go through Changesets. As part of every PR that changes a
published package, add a changeset describing the change:

```bash
pnpm changeset
```

Select the affected packages and the bump level, write a short summary, and commit
the generated file in `.changeset/` alongside your code. During beta, use `minor`
for new features and `patch` for fixes; versions stay `0.x.y` until a `1.0` release.

To cut a release, maintainers run `pnpm version-packages` (consume changesets +
bump) and then `pnpm release` (build + publish) from `main`. Packages publish to
Telia's JFrog Artifactory, pinned via each package's `publishConfig.registry` and
the `@telia-oss:registry` entry in `.npmrc`. The full runbook — auth and
troubleshooting the "already published / nothing to publish" case — is in
[releasing.md](./releasing.md).

Publishing is manual and requires a JFrog auth token in your `~/.npmrc` (never
committed). See [releasing.md](./releasing.md) for details.

## Issues and branching

No direct changes to `main` are allowed.

The preferred way is to track issues. Please
[link your PR](https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue)
to the issue. Small changes may be accepted without an issue in code review.

Use the following branch naming:

- `docs/very-short-description` for a PR that only contains documentation (no code compilation needed)
- `feature/very-short-description` for new functionality, test or improvement
- `fix/very-short-description` for a bug fix (please add regression tests and make sure they fail before the fix)

## Reviews

Currently, all pull requests require an owner's code review. Reviews by other can speed up the process, so don't shy
away from that.

## Running tests

Tests run through Turborepo and Jest (with `@swc/jest` for fast transpilation):

```bash
pnpm run test                                      # all packages (turbo run test)
pnpm exec turbo run test --filter @telia-oss/xjog  # a single package
```

CI runs the same suite on every PR (`.github/workflows/check-pr.yml`).

Two kinds of tests, co-located as `<Name>.test.ts`:

- **Unit tests** — for pure, side-effect-free logic (e.g. a function that
  transforms or filters data). The minority.
- **End-to-end tests** — exercise the full stack, persistence included, against an
  in-process **PGlite** database (no external DB required). These matter most:
  XJog is sensitive to database idiosyncrasies, and its lifecycle behaviour
  (recovery, handoff, deferred events) is where the risk lives. Prefer these over
  unit tests for anything with external effects.

Run a single test file or pattern from within a package directory:

```bash
cd packages/core
NODE_OPTIONS='--experimental-vm-modules' jest --config jestconfig.js src/XJogChart.test.ts
NODE_OPTIONS='--experimental-vm-modules' jest --config jestconfig.js -t "test name pattern"
```

