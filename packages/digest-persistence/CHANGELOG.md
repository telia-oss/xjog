# @telia-oss/xjog-digest-persistence

## 0.3.0

### Minor Changes

- f9a3d82: Extract a shared `AbstractPostgresDigestPersistenceAdapter` (positional `$N` SQL over a `PostgresQueryRunner` shim); digest-pg/digest-pglite now provide only the driver layer.

### Patch Changes

- e713e18: Deduplicate the digest `filterQuery` builder into the shared digest-persistence package.
- Updated dependencies [760310a]
- Updated dependencies [6fda287]
- Updated dependencies [c61b5fc]
  - @telia-oss/xjog-util@0.3.0

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
