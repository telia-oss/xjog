# @telia-oss/xjog-journal-reader

## 0.2.1

### Patch Changes

- 66eca86: journal-reader: drop misleading unused generics on `readMergedJournalEntry`, reuse one working copy across the diff fold, and use explicit `!== null` checks for previous state/context.
- Updated dependencies [760310a]
- Updated dependencies [d89e73e]
- Updated dependencies [6fda287]
- Updated dependencies [9175538]
- Updated dependencies [6942537]
- Updated dependencies [c61b5fc]
- Updated dependencies [de1d41e]
- Updated dependencies [1a9a004]
  - @telia-oss/xjog@0.3.0
  - @telia-oss/xjog-journal-persistence@0.3.0
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
  - @telia-oss/xjog-journal-persistence@0.2.0
  - @telia-oss/xjog@0.2.0
  - @telia-oss/xjog-util@0.2.0
