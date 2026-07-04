# @telia-oss/xjog-core-persistence

## 0.2.0

### Minor Changes

- 012e4ae: Rename the package scope `@samihult/*` → `@telia-oss/*`.

  This is a breaking change: import paths change from `@samihult/xjog-*` to
  `@telia-oss/xjog-*`. The previous `@samihult/xjog-*@0.1.x` packages remain on the
  registry so existing consumers keep resolving until they migrate. Also bundles the
  build-tooling migration (Lerna → pnpm + Turborepo + Changesets) and JFrog
  `publishConfig` that landed on `main` but had not yet been released. No runtime
  logic changes.

### Patch Changes

- Updated dependencies [012e4ae]
  - @telia-oss/xjog-util@0.2.0
