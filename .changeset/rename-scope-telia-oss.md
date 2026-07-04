---
"@telia-oss/xjog-journal-persistence": minor
"@telia-oss/xjog-digest-persistence": minor
"@telia-oss/xjog-core-persistence": minor
"@telia-oss/xjog-journal-pglite": minor
"@telia-oss/xjog-journal-reader": minor
"@telia-oss/xjog-journal-writer": minor
"@telia-oss/xjog-digest-pglite": minor
"@telia-oss/xjog-digest-reader": minor
"@telia-oss/xjog-digest-writer": minor
"@telia-oss/xjog-core-pglite": minor
"@telia-oss/xjog-journal-pg": minor
"@telia-oss/xjog-digest-pg": minor
"@telia-oss/xjog-core-pg": minor
"@telia-oss/xjog": minor
"@telia-oss/xjog-util": minor
---

Rename the package scope `@samihult/*` → `@telia-oss/*`.

This is a breaking change: import paths change from `@samihult/xjog-*` to
`@telia-oss/xjog-*`. The previous `@samihult/xjog-*@0.1.x` packages remain on the
registry so existing consumers keep resolving until they migrate. Also bundles the
build-tooling migration (Lerna → pnpm + Turborepo + Changesets) and JFrog
`publishConfig` that landed on `main` but had not yet been released. No runtime
logic changes.
