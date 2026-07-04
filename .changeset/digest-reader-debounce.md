---
'@telia-oss/xjog-digest-reader': minor
---

Debounce/coalesce `observeDigests` re-queries so bursts of notifications
collapse into fewer `queryDigests` calls; window configurable (default 50ms).

This is a behavior change: previously every notification from
`persistence.newDigestEntriesSubject` triggered an immediate `queryDigests`
call. Notifications are now buffered for `notificationDebounceMs`
(default 50ms, configurable via the reader's constructor options) before
being deduplicated by chart and re-queried, so a burst of notifications for
the same chart results in a single re-query instead of one per
notification. The initial `queryDigests` call made when subscribing to
`observeDigests` is unaffected and still emits immediately.
