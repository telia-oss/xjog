---
---

Build tooling and tests only: replace Lerna with pnpm workspace scripts +
Turborepo, adopt Changesets for versioning/publishing, and silence noisy test
warnings (xstate `predictableActionArguments`, VM-modules experimental warning,
an intentional unresolvable-delay warning) plus add PGlite teardown in tests.

No changes to any published package's runtime code, so no version bump is
required — this is an intentionally empty changeset.
