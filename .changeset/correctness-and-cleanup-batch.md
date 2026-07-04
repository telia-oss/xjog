---
'@telia-oss/xjog': patch
'@telia-oss/xjog-core-persistence': patch
'@telia-oss/xjog-core-pg': patch
'@telia-oss/xjog-core-pglite': patch
'@telia-oss/xjog-digest-pg': patch
'@telia-oss/xjog-digest-pglite': patch
'@telia-oss/xjog-journal-persistence': patch
'@telia-oss/xjog-journal-pg': patch
'@telia-oss/xjog-journal-pglite': patch
'@telia-oss/xjog-util': minor
'@telia-oss/xjog-journal-writer': minor
'@telia-oss/xjog-digest-writer': minor
---

Correctness and cleanup batch across the workspace:

- core: `destroy()` now releases the chart mutex and finishes persistence
  cleanup even when an update hook throws; update hooks that throw
  synchronously are logged instead of aborting create/send/destroy (the three
  call sites now share `XJog.runUpdateHooks`); done-data of a final state is
  awaited before being sent to the parent chart (was a Promise object), and a
  throwing final-state `data` mapper is now a logged best-effort skip rather
  than rejecting an already-committed `send()`; `dropExternalId` awaits the
  persistence call; `sendTo` activity-existence check no longer always passes
  (`typeof` misuse); machine chart cache evicts down to the size limit (was
  one entry per refresh), skips charts that are currently in use (avoiding a
  self-eviction deadlock and head-of-line blocking under the cache mutex), and
  releases the cache mutex on error paths; activity manager releases its
  database mutex when persistence calls throw; forced chart adoption survives
  transient database errors per chart (a failure on one chart no longer
  strands already-claimed charts or surfaces an unhandled rejection);
  after-action presence checks run concurrently.
- core-pg, core-pglite: removed non-transactional `destroyChart` overrides
  (with a missing await) so the transactional base implementation applies;
  removed commented-out dead code.
- journal-pglite: removed a broken `record()` override that wrote no journal
  entries and failed on the second call per chart; `queryEntries` and
  `queryFullStates` bind parameters correctly for every query-field
  combination and use parameterized VALUES lists instead of hand-escaped SQL
  literals; journal rows decode bytea columns as UTF-8; notification handler
  failures are logged instead of crashing the process; fixed `pg_notify` cast
  typo.
- journal-pg: notification-handler failures are logged instead of surfacing as
  an unhandled rejection that crashes the process (matching journal-pglite).
- journal-persistence: `record()` rethrows the original error instead of a
  logging closure.
- digest-pg: fixed malformed quoted identifier in digest SELECT list that
  broke `readDigest`/`readByChart` against real Postgres.
- digest-pg, digest-pglite: `readByChart` keys results by digest key (was
  machineId, collapsing all rows); fixed copy-pasted binding-key in the
  `updated after` filter; digest filter binding names no longer embed the raw
  digest key, which produced `:name` tokens the parameter binders truncated at
  the first non-word character — filtering on keys containing hyphens, dots or
  digits now works.
- digest-pglite: `queryDigests` now applies filter expressions and binds
  offset/limit/machineId/chartId correctly.
- journal-writer, digest-writer: expose `uninstall()` so the update hook
  installed by the constructor can be removed.
- util: `isActivityRef(null/undefined)` returns false instead of throwing;
  added `createPositionalParameters`, a shared positional-placeholder binder
  used by the PGlite query builders (was duplicated inline); removed the
  unused (and broken) `BurstController`.
