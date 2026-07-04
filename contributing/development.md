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

All ALPHA versions should be `0.0.x` and BETA versions `0.x.y`.

XJog can be graduated to beta once there is a comprehensive test set and
sufficient documentation.

Versioning and publishing go through Changesets. As part of every PR that changes a
published package, add a changeset describing the change:

```bash
pnpm changeset
```

Select the affected packages and the bump level, write a short summary, and commit
the generated file in `.changeset/` alongside your code. While in alpha, keep bumps as
`patch` so versions stay `0.0.x`.

To cut a release, maintainers run `pnpm version-packages` (consume changesets +
bump) and then `pnpm release` (build + publish) from `main`. Packages publish to
Telia's JFrog Artifactory, pinned via each package's `publishConfig.registry` and
the `@telia-oss:registry` entry in `.npmrc`. The full runbook — auth and
troubleshooting the "already published / nothing to publish" case — is in
[releasing.md](./releasing.md).

Publishing is manual during alpha and requires a JFrog auth token in your
`~/.npmrc` (never committed). See [releasing.md](./releasing.md) for details.

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

XJog has undergone a large-scale refactoring to multiple smaller packages and testing framework needs to be rewritten as
well. The idea is to have two kinds of tests:

A) Unit tests

In XJog unit tests are going to be a minority. Only write unit tests where you can extract a functional part that has no
external effects. For example, a simple function that transforms or filters data. For anything more complex, spend your
effort on writing E2E tests.

To run all unit tests:

```bash
pnpm run test
```

B) End-to-end tests (E2E)

With end-to-end, the whole stack including the persistence layer, is active. These tests are the most important ones,
since XJog is sensitive to database idiosyncrasies. Also the XJog's lifecycle functionalities play a crucial part in
making everything run reliably and smooth.

### Current state of affairs

Presently, no runnable tests. A rudimentary set of test cases can be found under `tests-int` and `tests-e2e` though.

Integration tests were a set of tests that used a mock adapter, but the upkeep cost of a mock adapter is high. They had
their benefits at the early stages of development, but should be converted to E2E tests now.

Testing should be activated. See the following issues:

- [#9 Bring back unit tests](https://github.com/telia-oss/xjog/issues/9)
- [#10 Re-establish E2E tests](https://github.com/telia-oss/xjog/issues/10)

