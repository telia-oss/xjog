---
"@samihult/xjog-journal-persistence": patch
"@samihult/xjog-digest-persistence": patch
"@samihult/xjog-core-persistence": patch
"@samihult/xjog-journal-pglite": patch
"@samihult/xjog-journal-reader": patch
"@samihult/xjog-journal-writer": patch
"@samihult/xjog-digest-pglite": patch
"@samihult/xjog-digest-reader": patch
"@samihult/xjog-digest-writer": patch
"@samihult/xjog-core-pglite": patch
"@samihult/xjog-journal-pg": patch
"@samihult/xjog-digest-pg": patch
"@samihult/xjog-core-pg": patch
"@samihult/xjog": patch
"@samihult/xjog-util": patch
---

Build tooling and tests only: replace Lerna with pnpm workspace scripts +
Turborepo, adopt Changesets for versioning/publishing, and silence noisy test
warnings (xstate `predictableActionArguments`, VM-modules experimental warning,
an intentional unresolvable-delay warning) plus add PGlite teardown in tests.
