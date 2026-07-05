# Refactoring TODO

Follow-ups from the 2026-07-04 code-quality audit. The bug-fix batch landed in
[PR #55](https://github.com/telia-oss/xjog/pull/55); everything below builds on
that branch being merged into `main`.

Ground rules for every item (from AGENTS.md):

- Branch from `main` with a `fix/` or `feature/` prefix; never commit to `main`.
- Every PR that touches a published package needs a changeset
  (`pnpm changeset`; during beta: `minor` for features, `patch` for fixes).
- Bug fixes need a regression test that fails before the fix.
- Verify locally before opening a PR: `pnpm run build`, `pnpm run test`,
  `pnpm run lint` must all pass.
- Behavior must be preserved unless the item explicitly says otherwise.

Work the items top to bottom within a track; items in different tracks are
independent of each other.

---

## Track A — Deduplicate the pg/pglite adapters

The pg and pglite adapters in each family (core, journal, digest) are ~85–90 %
identical SQL, differing only in parameter-binding style (`pg-bind` `:name`
macros vs raw `$N`) and result-shape (`result.rowCount` vs
`result.affectedRows`). The drift bugs fixed in PR #55 all lived in that
duplicated code. Goal: each family gets a shared abstract
`...PostgresPersistenceAdapterBase` that owns all SQL, written once with `$N`
positional placeholders (both drivers accept them), with a minimal driver shim.

The shim interface every concrete adapter must satisfy:

```ts
interface PostgresQueryRunner {
  query<T>(sql: string, params?: unknown[]): Promise<{
    rows: T[];
    rowCount: number; // pg: result.rowCount ?? 0; pglite: result.affectedRows ?? 0
  }>;
}
```

Things that stay per-driver (do NOT try to unify these):

- `connect()` / migration bootstrap (`pg.Pool` + migration client vs
  `PGlite.create()`; note different `noLock` values in `migrationRunner` opts).
- `withTransaction()` (`BEGIN/COMMIT/ROLLBACK` on a pool client vs PGlite's
  native `pool.transaction()`).
- Real-time delivery: `pg-listen` subscriber connection (pg) vs
  `connection.listen()` (pglite).
- bytea decoding: add ONE shared helper
  `decodeBytea(value: Buffer | Uint8Array): string` (use `TextDecoder`) in
  `@telia-oss/xjog-util` and use it from both row parsers. PR #55 fixed a bug
  caused by exactly this drift (`String(uint8array)` → `"123,34,..."`).

### A1. Extract shared digest `filterQuery` — proof of pattern

- [ ] Move the static `filterQuery(expression, prefix)` method into
      `packages/digest-persistence/src/DigestPersistenceAdapter.ts` (or a
      standalone exported function in that package).
- [ ] Delete the two copies:
      `packages/digest-pg/src/PostgresDigestPersistenceAdapter.ts` (~L246–440)
      and `packages/digest-pglite/src/PGliteDigestPersistenceAdapter.ts`
      (~L198–392). They are line-for-line identical today — diff them first to
      confirm nothing drifted after PR #55; if they differ, stop and
      investigate.
- [ ] Both `queryDigests` implementations call the shared function. The pg
      side keeps passing the returned bindings into `bind()`; the pglite side
      keeps its positional substitution (see the regex in
      `PGliteDigestPersistenceAdapter.queryDigests` — it must not match `::`
      type casts).
- [ ] Add unit tests for the shared `filterQuery` in `digest-persistence`
      (pure string-building, no DB needed): each operator, `and`/`or`/`not`
      nesting, prefix uniqueness of binding keys.
- Size: small. Risk: low. No behavior change.

### A2. Shared base for the digest family

- [ ] Create `AbstractPostgresDigestPersistenceAdapter` in
      `packages/digest-persistence` implementing `upsertDigest`,
      `deleteDigest`, `deleteByChart`, `readDigest`, `readByChart`,
      `queryDigests`, `emitDigestEntryNotification` on top of the
      `PostgresQueryRunner` shim, using `$N` placeholders only.
- [ ] `digest-pg` drops `pg-bind` usage for these methods and provides the
      shim over `pg.Pool`; keeps `connect`, `disconnect`, and the `pg-listen`
      subscription. `digest-pglite` provides the shim over `PGlite`; keeps
      `connect`, `disconnect`, `listen`.
- [ ] Port the paging/filter regression tests from
      `PGliteDigestPersistenceAdapter.test.ts` so they run against the shared
      base (they now cover pg's SQL too).
- [ ] Changeset: `minor` for digest-persistence, digest-pg, digest-pglite.
- Size: medium. Gate: A1 merged.

### A3. Shared base for the journal family

- [ ] Same pattern in `packages/journal-persistence`:
      `insertEntry`, `updateFullState`, `readEntry`, `queryEntries`,
      `readFullState`, `queryFullStates`, `deleteByChart`, `getCurrentTime`,
      `emitJournalEntryNotification` move to a shared base.
- [ ] Use the pglite versions of `queryEntries`/`queryFullStates` as the
      canonical source — they were rewritten in PR #55 with correct dynamic
      `$N` numbering and parameterized `VALUES` lists. The pg versions still
      use `pg-bind` and `escapeLiteral()` string interpolation; both go away.
      Removing `client.escapeLiteral` also removes the reason journal-pg holds
      a dedicated read connection for escaping — do NOT change the
      four-connection topology in this item, just the SQL.
- [ ] Keep per-driver: connection topology (journal-pg's 4 clients vs
      pglite's single connection), `pg-listen` vs `connection.listen`,
      the notification→re-query loop.
- [ ] Port the repeated-`record()` and array-query regression tests from
      `PGliteJournalPersistenceAdapter.test.ts` to run against the base.
- Size: medium-large. Gate: A2 merged (pattern proven twice).

### A4. Shared base for the core family

- [ ] Same pattern in `packages/core-persistence` for the ~40 pure-SQL
      methods (instance lifecycle, chart CRUD, deferred events, external ids,
      activities — the full list is in both adapter files; every method whose
      body is `connection.query(...)` + row mapping qualifies).
- [ ] Keep per-driver: `connect`, `disconnect`, `withTransaction`,
      `onDeathNote` polling, row `state` decoding (use the shared
      `decodeBytea`).
- [ ] The existing 22-test suite in
      `packages/core-pglite/src/PGlitePersistenceAdapter.test.ts` is the
      safety net; it must pass unchanged.
- [ ] Expect to remove the `pg-bind` dependency from `core-pg/package.json`
      when done (also check journal-pg/digest-pg after A2/A3).
- Size: large (biggest single win, ~900 duplicated lines). Gate: A3 merged.

### A5. Real-Postgres smoke tests for the `-pg` packages

The `-pg` packages currently have zero tests; after A2–A4 the shared SQL is
covered by pglite suites, so only the driver layer needs real-Postgres tests.

- [ ] Add a CI job (GitHub Actions `services: postgres` is simpler than
      testcontainers here) that runs a small suite per `-pg` package:
      `connect()` + migrations apply, `withTransaction` commits and rolls
      back, one LISTEN/NOTIFY round trip (journal + digest), one
      `destroyChart` (exercises transactional base against real pg).
- [ ] Guard the suites so they skip (not fail) when `PG_TEST_URL` /
      `DATABASE_URL` is unset, so local `pnpm test` stays dependency-free.
- Size: medium. Independent of A-ordering but most valuable after A4.

---

## Track B — Core readability/structure

### B1. Split `XJogChart.executeAction()`

- [ ] `packages/core/src/XJogChart.ts` — `executeAction` is ~210 lines with a
      6-branch switch. Extract each branch into a private method:
      `executeSendAction`, `executeCancelAction`, `executeStartAction`,
      `executeStopAction`, `executeLogAction`. Pure mechanical extraction;
      each branch already closes over `state`/`cid` — pass them as params.
- [ ] While there, delete the commented-out blocks flagged in the audit
      (`sendTo` dead branch in the Send case, `receivers` set in
      `spawnCallback`, observer logic in `spawnUnregisteredMachine`,
      `isSpawnedActor`/`isBehavior` placeholders in `spawn()`).
- [ ] No behavior change; the existing `XJogChart.test.ts` suite must pass
      unchanged.
- Size: medium. Risk: low-medium (mechanical, but this is the hottest file —
  review the diff carefully for accidental reordering of awaits).

### B2. Split `XJogChart.send()` tail

- [ ] Extract the simulator-interception block (top of `send()`) and the
      done-state/auto-forward tail into named private helpers. Do NOT
      restructure the mutex/transition core in the middle — highest-risk code
      in the repo, and the audit found no bugs in it.
- Size: small-medium. Gate: B1 merged (same file, avoid conflicts).

### B3. Extract profiling into `XJogProfiler`

- [ ] Move the histogram machinery out of `packages/core/src/XJog.ts`
      (fields `executionDurationHistogram*`, `executionTimes`,
      `executionDurationHistograms`; methods `recordExecutionDuration`,
      `getExecutionDurationHistogram`, `getProfilingMetrics`; the marker
      comment "Move these to a monitoring class" shows the block) into a new
      `XJogProfiler` class composed into `XJog`.
- [ ] Keep `xJog.timeExecution(...)` and `xJog.getProfilingMetrics()`
      signatures unchanged (public API used across every core file).
- [ ] Add an option (e.g. `options.profiling.enabled`, default true to
      preserve behavior) that short-circuits `timeExecution` to just call the
      routine — it currently does `performance.now()` + log-bucket math on
      every call system-wide.
- [ ] Changeset: `minor` for `@telia-oss/xjog`.
- Size: medium. Risk: low.

---

## Track C — Small independent items (good first tasks)

- [x] **C1. `core-sqlite` stub**: `packages/core-sqlite/` contains only
      `package._json` and no `src/`. Decide: delete the directory and remove
      sqlite from the AGENTS.md/README architecture lists (recommended), or
      file a real implementation plan. Docs-only if deleting (`docs/` branch).
      Resolved: directory deleted, AGENTS.md architecture bullet and
      dependency-flow diagram updated to drop `core-sqlite`.
- [ ] **C2. Rename shadowed variable in `XJogDeferredEventManager.ts`**:
      local variables named `PersistedDeferredEvent` shadow the imported type
      of the same name throughout the file (~15 usages). Rename the variables
      to `deferredEvent`. Pure rename, no changeset-visible behavior change
      (still needs a `patch` changeset since the package rebuilds).
- [ ] **C3. `XJogMachine` cache to a single `Map`**: `chartCacheStore`
      (plain object) + `chartCacheKeys` (Set for insertion order) duplicate
      one concept; a single `Map<string, XJogChart>` preserves insertion order
      natively. Touches `cleanCache`/`refreshCache`/`evictCacheEntry`/
      `getChart`. Keep the `while`-eviction and try/finally added in PR #55.
- [ ] **C4. `digest-reader` re-query coalescing**:
      `XJogDigestReader.observeDigests` re-runs `persistence.queryDigests()`
      on every notification. Add a debounce (e.g. RxJS `auditTime` /
      `debounceTime` with a small window, configurable). Behavior change —
      document in changeset.
- [ ] **C5. `journal-reader` cleanups**: `readMergedJournalEntry` has unused
      generic params (misleading API) and calls `nullSafeApplyJsonDiff`
      (which does `JSON.parse(JSON.stringify(...))`) per journal entry in a
      loop — reuse one working copy across the fold. Also replace the
      truthiness checks on `previousState`/`previousContext` with explicit
      `!== null` sentinels.
- [x] **C6. `XJogStateChange` action-type stubs**: 15 of 18 variants in
      `packages/util/src/XJogStateChange.ts` are empty `// TODO ?` stubs.
      Needs a design decision (fill in payloads or collapse to a smaller
      union) — write a proposal in the PR description before coding.
      Resolved: collapsed the payload-less stubs into a single
      `XJogStateChangePlainAction`; `XJogActionTypes` became a real enum
      (was `declare enum` with no runtime value); `mapActions` is now fully
      type-checked with unit tests.

---

## Suggested order

1. A1 (small, proves the pattern) → A2 → A3 → A4 → A5
2. B3 and C-items can be interleaved anytime; B1 → B2 after A-track PRs that
   touch core are merged, to keep `XJogChart.ts` conflicts down.
3. C6 last — it's the only item needing an API design discussion.
