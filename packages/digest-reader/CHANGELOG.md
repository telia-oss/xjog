# @telia-oss/xjog-digest-reader

## 0.3.0

### Minor Changes

- aa3412e: Debounce/coalesce `observeDigests` re-queries so bursts of notifications
  collapse into fewer `queryDigests` calls; window configurable (default 50ms).

  This is a behavior change: previously every notification from
  `persistence.newDigestEntriesSubject` triggered an immediate `queryDigests`
  call. Notifications are now buffered for `notificationDebounceMs`
  (default 50ms, configurable via the reader's constructor options) before
  being deduplicated by chart and re-queried, so a burst of notifications for
  the same chart results in a single re-query instead of one per
  notification. The initial `queryDigests` call made when subscribing to
  `observeDigests` is unaffected and still emits immediately.

### Patch Changes

- Updated dependencies [760310a]
- Updated dependencies [f9a3d82]
- Updated dependencies [e713e18]
- Updated dependencies [6fda287]
- Updated dependencies [c61b5fc]
  - @telia-oss/xjog-util@0.3.0
  - @telia-oss/xjog-digest-persistence@0.3.0

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
  - @telia-oss/xjog-digest-persistence@0.2.0
  - @telia-oss/xjog-util@0.2.0
