# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets).
It replaces the versioning and publishing role Lerna used to play.

## Adding a changeset

When you make a change that should be released, add a changeset describing it:

```bash
pnpm changeset
```

Pick the affected packages and the bump level (patch / minor / major), then write
a short summary. This creates a markdown file in `.changeset/` — commit it with
your PR. While in alpha, keep all bumps as `patch` so versions stay `0.0.x`.

## Releasing (maintainers)

```bash
pnpm version-packages   # applies pending changesets: bumps versions + writes changelogs
pnpm install            # refresh the lockfile after the bumps
pnpm release            # builds all packages, then publishes changed ones + git tags
```

`updateInternalDependencies` is set to `patch`, so a bump to one package also nudges
the `workspace:^` dependents. `access` is `restricted` because alpha packages are
published to the private GitHub Packages registry under `@samihult`.
